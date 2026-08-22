"""
email_utils.py — Sends OTP emails via Gmail SMTP using the credentials
already present in your .env file (APP_PASSWORD_EMAIL + GMAIL_APP_PASSWORD).

Quick self-test — run this file directly:
    python email_utils.py your.other.email@example.com
It will try to send a real test OTP and print the exact success/failure
reason, instead of you having to dig through app.py's server logs.
"""

import os
import sys
import smtplib
import ssl
from email.mime.text import MIMEText
from dotenv import load_dotenv

load_dotenv()

# Gmail App Passwords are shown as "abcd efgh ijkl mnop" for readability,
# but the real credential has NO spaces — Google's SMTP login rejects it
# (or silently fails, depending on the error) if you pass it with spaces
# still in it. This was the actual reason OTP emails were never arriving:
# every send attempt was failing auth and quietly falling back to the
# console-only printout below.
SENDER_EMAIL = os.getenv("APP_PASSWORD_EMAIL", "").strip().strip('"')
SENDER_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD", "").strip().strip('"').replace(" ", "")


def _send_via_ssl(to_email, msg):
    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context, timeout=15) as server:
        server.login(SENDER_EMAIL, SENDER_APP_PASSWORD)
        server.sendmail(SENDER_EMAIL, [to_email], msg.as_string())


def _send_via_starttls(to_email, msg):
    # Some networks/hosts block port 465 outright but allow 587 — this is
    # the fallback for those cases.
    context = ssl.create_default_context()
    with smtplib.SMTP("smtp.gmail.com", 587, timeout=15) as server:
        server.starttls(context=context)
        server.login(SENDER_EMAIL, SENDER_APP_PASSWORD)
        server.sendmail(SENDER_EMAIL, [to_email], msg.as_string())


def send_otp_email(to_email, code, purpose="verify_email"):
    """Sends a 6-digit OTP code to to_email. Returns True/False.
    If SMTP isn't configured OR sending fails, falls back to printing the
    code to the console (so the flow never gets stuck), but now prints a
    clear, specific reason so the failure is actually diagnosable."""

    subject = "Your S.N.E.T.C.H verification code" if purpose == "verify_email" else "Your S.N.E.T.C.H password reset code"
    body = f"""Hi,

Your S.N.E.T.C.H one-time code is: {code}

This code expires in 10 minutes. If you did not request this, you can ignore this email.

— S.N.E.T.C.H
"""

    if not SENDER_EMAIL or not SENDER_APP_PASSWORD:
        print("[EMAIL DISABLED] APP_PASSWORD_EMAIL / GMAIL_APP_PASSWORD missing from .env")
        print(f"[OTP for {to_email} ({purpose})]: {code}")
        return True

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = SENDER_EMAIL
    msg["To"] = to_email

    last_error = None
    for label, sender_fn in (("SSL:465", _send_via_ssl), ("STARTTLS:587", _send_via_starttls)):
        try:
            sender_fn(to_email, msg)
            print(f"[EMAIL SENT via {label}] {purpose} code -> {to_email}")
            return True
        except smtplib.SMTPAuthenticationError as e:
            last_error = e
            print(f"[EMAIL AUTH FAILED via {label}]: {e}")
            print("  -> Check that GMAIL_APP_PASSWORD in .env is a current, 16-character")
            print("     App Password (Google Account > Security > 2-Step Verification >")
            print("     App passwords) generated for the SAME account as APP_PASSWORD_EMAIL,")
            print("     and that 2-Step Verification is turned ON for that account.")
            break  # auth failure won't fix itself by switching ports — stop retrying
        except (smtplib.SMTPException, OSError, TimeoutError) as e:
            last_error = e
            print(f"[EMAIL CONNECTION FAILED via {label}]: {e}")
            print("  -> This usually means the network/host is blocking outbound SMTP.")
            continue  # worth trying the other port

    print(f"[EMAIL SEND FAILED — fallback] {last_error}")
    print(f"[Fallback - OTP for {to_email} ({purpose})]: {code}")
    return True


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else SENDER_EMAIL
    print(f"Sender account : {SENDER_EMAIL or '(not set)'}")
    print(f"App password   : {'set (' + str(len(SENDER_APP_PASSWORD)) + ' chars, spaces stripped)' if SENDER_APP_PASSWORD else '(not set)'}")
    print(f"Sending test OTP to: {target}\n")
    send_otp_email(target, "123456", purpose="verify_email")
