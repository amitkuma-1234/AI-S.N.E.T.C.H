# ============================================================
#  smtp.py — AI Email Center (S.N.E.T.C.H)
#  Flask Blueprint: /smtp/api/*
#
#  Sends real emails — with one or many attachments of any type
#  (PDF, DOCX, XLSX, PPTX, TXT, images, ZIP, audio, video, etc.)
#  — via Gmail SMTP using the SAME credentials already configured
#  in .env for OTP delivery (see email_utils.py):
#
#     APP_PASSWORD_EMAIL   = your-account@gmail.com
#     GMAIL_APP_PASSWORD   = your 16-character App Password
#
#  Design mirrors the pattern used elsewhere in this project
#  (see whatsappmessage.py / document_chatbot.py): a self-contained
#  Blueprint + register_*(app) hook, so app.py only needs two lines
#  added and every other feature stays untouched.
# ============================================================

import os
import re
import ssl
import smtplib
import mimetypes
from pathlib import Path
from email.message import EmailMessage
from email.utils import make_msgid, formatdate

from flask import Blueprint, request, jsonify
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent / ".env")

# ── Config / credentials (same account used by email_utils.py) ───
SENDER_ACCOUNT_EMAIL = os.getenv("APP_PASSWORD_EMAIL", "").strip().strip('"')
SENDER_ACCOUNT_APP_PASSWORD = (
    os.getenv("GMAIL_APP_PASSWORD", "").strip().strip('"').replace(" ", "")
)

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

MAX_ATTACHMENT_MB = 25
MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024
MAX_TOTAL_MB = 25
MAX_TOTAL_BYTES = MAX_TOTAL_MB * 1024 * 1024
MAX_ATTACHMENTS = 15

# Executable / script types are blocked for security — everything else
# (pdf, docx, xlsx, pptx, txt, images, zip, audio, video, ...) is allowed.
BLOCKED_EXTENSIONS = {
    "exe", "bat", "cmd", "com", "scr", "msi", "vbs", "js", "jse", "wsf",
    "ps1", "sh", "jar", "apk", "dll", "cpl", "gadget", "reg", "lnk", "vbe",
}

smtp_bp = Blueprint("smtp_api", __name__, url_prefix="/smtp/api")


# ── Helpers ────────────────────────────────────────────────────
def _is_valid_email(addr: str) -> bool:
    return bool(addr) and bool(EMAIL_RE.match(addr.strip()))


def _human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f}{unit}" if unit != "B" else f"{int(size)}{unit}"
        size /= 1024
    return f"{size:.1f}GB"


def _build_message(sender_email, receiver_email, subject, body, files):
    """Build a properly MIME-formatted email (text body + N attachments)."""
    msg = EmailMessage()
    msg["From"] = sender_email
    msg["To"] = receiver_email
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="snetch.local")
    msg["Reply-To"] = sender_email
    # Helps deliverability: tell the recipient's server this really came
    # from S.N.E.T.C.H, and gives a plain-text body (required for MIME).
    msg["X-Mailer"] = "S.N.E.T.C.H Email Center"
    msg.set_content(body)

    for f in files:
        filename = f["filename"]
        data = f["data"]
        ctype, encoding = mimetypes.guess_type(filename)
        if ctype is None or encoding is not None:
            ctype = "application/octet-stream"
        maintype, subtype = ctype.split("/", 1)
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)

    return msg


def _send_via_ssl(login_email, msg, receiver_email):
    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context, timeout=30) as server:
        server.login(login_email, SENDER_ACCOUNT_APP_PASSWORD)
        server.sendmail(login_email, [receiver_email], msg.as_string())


def _send_via_starttls(login_email, msg, receiver_email):
    # Some networks block port 465 but allow 587 — fallback path.
    context = ssl.create_default_context()
    with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as server:
        server.starttls(context=context)
        server.login(login_email, SENDER_ACCOUNT_APP_PASSWORD)
        server.sendmail(login_email, [receiver_email], msg.as_string())


# ── Routes ─────────────────────────────────────────────────────
@smtp_bp.route("/config", methods=["GET"])
def api_config():
    """Frontend calls this on load to know limits + server readiness."""
    return jsonify({
        "success": True,
        "configured": bool(SENDER_ACCOUNT_EMAIL and SENDER_ACCOUNT_APP_PASSWORD),
        "max_attachment_mb": MAX_ATTACHMENT_MB,
        "max_total_mb": MAX_TOTAL_MB,
        "max_attachments": MAX_ATTACHMENTS,
        "blocked_extensions": sorted(BLOCKED_EXTENSIONS),
    })


@smtp_bp.route("/send", methods=["POST"])
def api_send():
    if not SENDER_ACCOUNT_EMAIL or not SENDER_ACCOUNT_APP_PASSWORD:
        return jsonify({
            "success": False,
            "error": "Email sending isn't configured on this server. "
                     "Set APP_PASSWORD_EMAIL and GMAIL_APP_PASSWORD in .env.",
        }), 503

    sender_email = (request.form.get("sender_email") or "").strip()
    receiver_email = (request.form.get("receiver_email") or "").strip()
    subject = (request.form.get("subject") or "").strip()
    body = (request.form.get("message") or "").strip()

    if not _is_valid_email(sender_email):
        return jsonify({"success": False, "field": "sender_email",
                         "error": "Invalid Sender Email Address."}), 400
    if not _is_valid_email(receiver_email):
        return jsonify({"success": False, "field": "receiver_email",
                         "error": "Invalid Receiver Email Address."}), 400
    if not subject:
        return jsonify({"success": False, "field": "subject",
                         "error": "Subject Is Required."}), 400
    if not body:
        return jsonify({"success": False, "field": "message",
                         "error": "Message Cannot Be Empty."}), 400

    uploaded = [f for f in request.files.getlist("attachments") if f and f.filename]

    if len(uploaded) > MAX_ATTACHMENTS:
        return jsonify({"success": False, "field": "attachments",
                         "error": f"Too Many Attachments. Maximum is {MAX_ATTACHMENTS}."}), 400

    files = []
    total_size = 0
    for f in uploaded:
        raw_name = f.filename
        ext = raw_name.rsplit(".", 1)[-1].lower() if "." in raw_name else ""
        if ext in BLOCKED_EXTENSIONS:
            return jsonify({"success": False, "field": "attachments",
                             "error": f"Unsupported File Type: .{ext}"}), 400

        data = f.read()
        size = len(data)
        if size == 0:
            continue
        if size > MAX_ATTACHMENT_BYTES:
            return jsonify({
                "success": False, "field": "attachments",
                "error": f"'{raw_name}' Is Too Large ({_human_size(size)}). "
                         f"Max {MAX_ATTACHMENT_MB}MB Per File.",
            }), 400

        total_size += size
        if total_size > MAX_TOTAL_BYTES:
            return jsonify({
                "success": False, "field": "attachments",
                "error": f"Attachment Too Large. Total Exceeds {MAX_TOTAL_MB}MB.",
            }), 400

        files.append({"filename": raw_name, "data": data})

    try:
        msg = _build_message(sender_email, receiver_email, subject, body, files)
    except Exception as e:
        return jsonify({"success": False, "error": f"Failed To Prepare Email: {e}"}), 500

    last_kind = None
    last_error = None
    for label, sender_fn in (("SSL:465", _send_via_ssl), ("STARTTLS:587", _send_via_starttls)):
        try:
            sender_fn(SENDER_ACCOUNT_EMAIL, msg, receiver_email)
            return jsonify({
                "success": True,
                "message": "Email Sent Successfully",
                "from": sender_email,
                "to": receiver_email,
                "attachments": len(files),
            })
        except smtplib.SMTPAuthenticationError as e:
            last_kind, last_error = "auth", e
            print(f"[SMTP AUTH FAILED via {label}]: {e}")
            break  # auth won't fix itself by switching ports
        except smtplib.SMTPRecipientsRefused as e:
            print(f"[SMTP RECEIVER REFUSED via {label}]: {e}")
            return jsonify({"success": False, "field": "receiver_email",
                             "error": "Invalid Receiver Email Address."}), 400
        except smtplib.SMTPSenderRefused as e:
            print(f"[SMTP SENDER REFUSED via {label}]: {e}")
            return jsonify({
                "success": False, "field": "sender_email",
                "error": "Sender Email Was Rejected By The Mail Server. "
                         "It must match or be a verified alias of the configured account.",
            }), 400
        except smtplib.SMTPException as e:
            last_kind, last_error = "smtp", e
            print(f"[SMTP ERROR via {label}]: {e}")
            continue
        except (OSError, TimeoutError) as e:
            last_kind, last_error = "network", e
            print(f"[SMTP NETWORK ERROR via {label}]: {e}")
            continue

    if last_kind == "auth":
        return jsonify({"success": False, "error": "Authentication Failed."}), 500
    if last_kind == "network":
        return jsonify({"success": False, "error": "Network Error. Please try again."}), 502
    return jsonify({"success": False, "error": "SMTP Server Error. Please try again shortly."}), 500


def register_smtp(app) -> None:
    """Wire this feature's API into the main Flask app.

    smtp.py deliberately does not import app.py (to avoid touching any
    other feature/file). Add these two lines once in app.py, near the
    other feature imports:

        import smtp
        ...
        smtp.register_smtp(app)
    """
    app.register_blueprint(smtp_bp)


if __name__ == "__main__":
    print("This module now powers the S.N.E.T.C.H web Email Center at /smtp.")
    print(f"Configured sender account: {SENDER_ACCOUNT_EMAIL or '(not set)'}")
    print(f"App password set: {'yes' if SENDER_ACCOUNT_APP_PASSWORD else 'no'}")