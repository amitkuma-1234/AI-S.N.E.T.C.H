"""
whatsappmessage.py — S.N.E.T.C.H AI WhatsApp Messenger (backend)

Exposes a Flask Blueprint (`whatsapp_bp`) used by
templates/whatsappmessage.html + js/whatsappmessage.js:

    POST /api/whatsapp/send                       -> queue a message (multipart/form-data)
    GET  /api/whatsapp/status/<job_id>             -> poll job status
    GET  /api/whatsapp/file/<folder_id>/<filename> -> serve an uploaded attachment (shareable link)

HOW SENDING WORKS
------------------
This feature drives the **installed WhatsApp Desktop application** —
never WhatsApp Web / any browser tab.

TEXT:
  1. The chat is opened directly inside WhatsApp Desktop using the
     OS-level `whatsapp://send` protocol handler that the desktop
     client registers on install. This never touches a browser and
     never visits https://web.whatsapp.com.
  2. The desktop window is brought into focus and an Enter keystroke
     is dispatched to actually submit the pre-filled text.

ATTACHMENTS (real files, not just links):
  WhatsApp's `whatsapp://send` protocol has no parameter for
  attaching files, and there's no public desktop automation API for
  uploading them either. Instead, every attachment is delivered as an
  actual native WhatsApp file/image message using the same mechanism
  a human uses to paste a file into a chat:
    a. The file(s) are copied onto the OS clipboard as a native
       "file" selection (Windows: CF_HDROP via the clipboard API;
       macOS: `osascript` sets the clipboard to POSIX file
       references).
    b. The WhatsApp Desktop window is focused and Ctrl+V / Cmd+V is
       dispatched, which opens WhatsApp's own attachment preview for
       those files — the exact same preview a human would see.
    c. Enter is dispatched to actually send that preview.
  This means the recipient gets the real file inside WhatsApp, the
  same as if someone had dragged it in by hand.

  Linux desktop WhatsApp clients are unofficial and don't reliably
  support clipboard file-paste, so on Linux attachments fall back to
  a shareable download link appended to the message text (clearly
  communicated to the user — never silently swapped in).

  For attachment download *links* to open for a real recipient, this
  server needs to be reachable from the internet (a real domain/IP),
  not just localhost. That's a deployment detail, not a code
  limitation, and only applies to the Linux link fallback.

WHY THIS NEVER FAKES SUCCESS
------------------------------
Every step that can fail — WhatsApp Desktop not being installed, the
app failing to launch, the window not accepting a keystroke, or the
clipboard file-copy failing — raises/records a distinct error. The
job is only marked `status="success"` once every requested part
(text, and every attachment) has been confirmed dispatched into a
focused WhatsApp Desktop window. If any step can't be confirmed, the
job is marked `status="error"` with a specific, user-facing message
instead — even if an earlier part (e.g. the text) already went
through. The frontend polls this job status and only shows the
success popup for `status="success"`.

Opening, focusing, and driving the desktop app happens on a
background thread; the HTTP endpoint returns immediately with a
`job_id` that the frontend polls for status.
"""

import os
import re
import time
import uuid
import struct
import shutil
import platform
import threading
import traceback
import subprocess
from datetime import datetime, timedelta
from urllib.parse import quote_plus

from flask import Blueprint, request, jsonify, send_from_directory, abort
from werkzeug.utils import secure_filename

try:
    import phonenumbers
    PHONENUMBERS_OK = True
except ImportError:
    PHONENUMBERS_OK = False
    print("[whatsappmessage] 'phonenumbers' not installed. Run: pip install phonenumbers")

try:
    import pyautogui
    PYAUTOGUI_OK = True
except Exception as e:
    # Broad except (not just ImportError) on purpose: on a headless
    # server (no DISPLAY, e.g. AWS EC2), pyautogui's own import chain
    # (via mouseinfo) raises a bare KeyError('DISPLAY') at import time
    # instead of ImportError. This feature is desktop-automation only
    # and can never work on a headless server anyway, so we degrade
    # gracefully instead of crashing the whole app on boot.
    PYAUTOGUI_OK = False
    print(f"[whatsappmessage] 'pyautogui' unavailable ({e}). "
          f"WhatsApp desktop-automation features will be disabled.")

try:
    import pygetwindow as gw
    PYGETWINDOW_OK = True
except Exception as e:
    PYGETWINDOW_OK = False
    print(f"[whatsappmessage] 'pygetwindow' unavailable ({e}). "
          f"WhatsApp desktop-automation features will be disabled.")

if platform.system() == "Windows":
    try:
        import win32clipboard  # noqa: F401 - availability check only; imported again where used
        PYWIN32_OK = True
    except ImportError:
        PYWIN32_OK = False
        print("[whatsappmessage] 'pywin32' not installed. Run: pip install pywin32 (needed to attach real files on Windows)")
else:
    PYWIN32_OK = True  # not applicable on this OS


# ══════════════════════════════════════════════════════════════════
#  CONFIG
# ══════════════════════════════════════════════════════════════════

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_ROOT = os.path.join(BASE_DIR, "whatsapp_uploads")
os.makedirs(UPLOAD_ROOT, exist_ok=True)

MAX_FILE_SIZE_BYTES = 64 * 1024 * 1024        # 64 MB per file
MAX_TOTAL_SIZE_BYTES = 200 * 1024 * 1024      # 200 MB per send
MAX_FILES_PER_MESSAGE = 10
FILE_RETENTION_HOURS = 24                     # cleanup window for uploaded attachments

IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
DOCUMENT_EXTENSIONS = {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "rtf"}
ARCHIVE_EXTENSIONS = {"zip", "rar", "7z"}
AUDIO_EXTENSIONS = {"mp3", "wav", "ogg", "m4a", "aac"}
VIDEO_EXTENSIONS = {"mp4", "mov", "avi", "mkv", "webm"}

ALLOWED_EXTENSIONS = (
    IMAGE_EXTENSIONS | DOCUMENT_EXTENSIONS | ARCHIVE_EXTENSIONS
    | AUDIO_EXTENSIONS | VIDEO_EXTENSIONS
)

IS_WINDOWS = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"
IS_LINUX = platform.system() == "Linux"

WA_APP_LAUNCH_TIMEOUT = 10     # seconds allowed for the OS to hand off to WhatsApp Desktop
WA_APP_LOAD_WAIT = 3.5         # seconds to let the chat screen render before we type
WA_FOCUS_RETRY_ATTEMPTS = 3    # attempts to find/focus the WhatsApp Desktop window
WA_FOCUS_RETRY_DELAY = 1.0     # seconds between focus attempts
WA_ATTACH_PREVIEW_WAIT = 2.0   # seconds to let WhatsApp render the attachment preview after paste


# ══════════════════════════════════════════════════════════════════
#  IN-MEMORY JOB TRACKING
#  A lightweight job store is enough here: each send is a short-lived
#  background task and jobs don't need to survive a server restart.
# ══════════════════════════════════════════════════════════════════

_jobs = {}
_jobs_lock = threading.Lock()


def _set_job(job_id, **fields):
    with _jobs_lock:
        job = _jobs.setdefault(job_id, {})
        job.update(fields)
        job["updated_at"] = time.time()


def _get_job(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


# ══════════════════════════════════════════════════════════════════
#  IN-MEMORY UPLOAD SESSION TRACKING
#  Attachments are uploaded to the backend the moment they're
#  selected (before "Send Message" is ever clicked). Each browser
#  "session" of staged attachments is tracked here under an
#  `upload_id`, so the Send route can re-use the already-uploaded
#  files instead of uploading them again.
# ══════════════════════════════════════════════════════════════════

_uploads = {}       # upload_id -> {"folder_path": str, "files": {file_id: {...}}, "updated_at": float}
_uploads_lock = threading.Lock()


def _get_or_create_upload_session(upload_id):
    """Returns (upload_id, session_dict), creating a new session if
    upload_id is missing/unknown."""
    with _uploads_lock:
        if upload_id and upload_id in _uploads:
            _uploads[upload_id]["updated_at"] = time.time()
            return upload_id, _uploads[upload_id]

        new_id = uuid.uuid4().hex
        folder_path = os.path.join(UPLOAD_ROOT, new_id)
        os.makedirs(folder_path, exist_ok=True)
        session = {"folder_path": folder_path, "files": {}, "updated_at": time.time()}
        _uploads[new_id] = session
        return new_id, session


def _get_upload_session(upload_id):
    with _uploads_lock:
        session = _uploads.get(upload_id)
        return session


def _add_uploaded_file(upload_id, file_entry):
    with _uploads_lock:
        session = _uploads.get(upload_id)
        if session is None:
            return
        session["files"][file_entry["file_id"]] = file_entry
        session["updated_at"] = time.time()


def _remove_uploaded_file(upload_id, file_id):
    """Deletes the stored file from disk and its registry entry.
    Returns True if a file was found and removed."""
    with _uploads_lock:
        session = _uploads.get(upload_id)
        if session is None:
            return False
        entry = session["files"].pop(file_id, None)
        if entry is None:
            return False
    try:
        if os.path.isfile(entry["path"]):
            os.remove(entry["path"])
    except OSError:
        pass
    return True


def _count_files_in_session(session) -> int:
    return len(session["files"]) if session else 0


def _total_size_in_session(session) -> int:
    return sum(f["size"] for f in session["files"].values()) if session else 0


# ══════════════════════════════════════════════════════════════════
#  VALIDATION HELPERS
# ══════════════════════════════════════════════════════════════════

class ValidationError(Exception):
    """Raised for any user-facing validation problem (400 response)."""
    def __init__(self, message, field=None):
        super().__init__(message)
        self.message = message
        self.field = field


class WhatsAppLaunchError(Exception):
    """Raised when the WhatsApp Desktop application can't be found, opened,
    or driven to actually send the message."""
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def normalize_and_validate_number(raw_number: str) -> str:
    """
    Validates an international WhatsApp number and returns it in
    strict E.164 form (e.g. '+919876543210').
    """
    if not raw_number or not raw_number.strip():
        raise ValidationError("Please enter a WhatsApp number.", field="number")

    candidate = raw_number.strip()
    if not candidate.startswith("+"):
        raise ValidationError(
            "Number must include the country code, starting with '+' (e.g. +919876543210).",
            field="number",
        )

    if not PHONENUMBERS_OK:
        # Fallback: basic shape check if the phonenumbers library is missing.
        digits = re.sub(r"\D", "", candidate)
        if len(digits) < 8 or len(digits) > 15:
            raise ValidationError("Invalid WhatsApp number.", field="number")
        return "+" + digits

    try:
        parsed = phonenumbers.parse(candidate, None)
    except phonenumbers.NumberParseException:
        raise ValidationError("Invalid WhatsApp number format.", field="number")

    if not phonenumbers.is_valid_number(parsed):
        raise ValidationError("This doesn't look like a valid WhatsApp number.", field="number")

    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)


def validate_message_text(message: str) -> str:
    if message is None:
        return ""
    return message  # multi-line, emoji, special characters are all fine as UTF-8 text


def get_extension(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def classify_extension(ext: str) -> str:
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in DOCUMENT_EXTENSIONS:
        return "document"
    if ext in ARCHIVE_EXTENSIONS:
        return "archive"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    return "other"


def save_uploaded_files(files, request_root_url: str):
    """
    Validates and saves every uploaded file into a unique folder.
    Returns a list of dicts: {name, ext, kind, path, url, size}
    Raises ValidationError on any problem.
    """
    if len(files) > MAX_FILES_PER_MESSAGE:
        raise ValidationError(
            f"You can attach a maximum of {MAX_FILES_PER_MESSAGE} files at a time.",
            field="attachments",
        )

    folder_id = uuid.uuid4().hex
    folder_path = os.path.join(UPLOAD_ROOT, folder_id)

    saved = []
    total_size = 0

    for file_storage in files:
        if not file_storage or not file_storage.filename:
            continue

        original_name = file_storage.filename
        safe_name = secure_filename(original_name) or f"file_{uuid.uuid4().hex[:8]}"
        ext = get_extension(safe_name)

        if ext not in ALLOWED_EXTENSIONS:
            raise ValidationError(
                f"'{original_name}' is an unsupported file type.",
                field="attachments",
            )

        try:
            os.makedirs(folder_path, exist_ok=True)
            dest_path = os.path.join(folder_path, safe_name)
            file_storage.save(dest_path)
            size = os.path.getsize(dest_path)
        except OSError:
            raise ValidationError(
                f"'{original_name}' could not be uploaded. Please try again.",
                field="attachments",
            )

        if size == 0:
            os.remove(dest_path)
            raise ValidationError(f"'{original_name}' is empty.", field="attachments")
        if size > MAX_FILE_SIZE_BYTES:
            os.remove(dest_path)
            raise ValidationError(
                f"'{original_name}' is too large (max {MAX_FILE_SIZE_BYTES // (1024*1024)} MB per file).",
                field="attachments",
            )

        total_size += size
        if total_size > MAX_TOTAL_SIZE_BYTES:
            os.remove(dest_path)
            raise ValidationError(
                f"Total attachment size exceeds {MAX_TOTAL_SIZE_BYTES // (1024*1024)} MB.",
                field="attachments",
            )



        saved.append({
            "name": safe_name,
            "original_name": original_name,
            "ext": ext,
            "kind": classify_extension(ext),
            "path": dest_path,
            "url": f"{request_root_url.rstrip('/')}/api/whatsapp/file/{folder_id}/{safe_name}",
            "size": size,
        })

    return saved


def _validate_and_store_single_file(file_storage, upload_id, session, request_root_url, client_id=None):
    """
    Validates and immediately persists ONE uploaded file into the
    given upload session's folder. Returns the file's registry entry
    dict on success. Raises ValidationError on any problem — callers
    handle this per-file so one bad file never blocks the rest of
    the batch.
    """
    if not file_storage or not file_storage.filename:
        raise ValidationError("No file was received.", field="attachments")

    original_name = file_storage.filename

    if _count_files_in_session(session) >= MAX_FILES_PER_MESSAGE:
        raise ValidationError(
            f"You can attach a maximum of {MAX_FILES_PER_MESSAGE} files at a time.",
            field="attachments",
        )

    safe_name = secure_filename(original_name) or f"file_{uuid.uuid4().hex[:8]}"
    ext = get_extension(safe_name)

    if ext not in ALLOWED_EXTENSIONS:
        raise ValidationError(f"'{original_name}' is an unsupported file type.", field="attachments")

    file_id = uuid.uuid4().hex
    # Prefix with the file_id so two attachments with the same original
    # name never collide inside the same upload session folder.
    stored_name = f"{file_id}_{safe_name}"
    dest_path = os.path.join(session["folder_path"], stored_name)

    try:
        file_storage.save(dest_path)
        size = os.path.getsize(dest_path)
    except OSError:
        raise ValidationError(f"'{original_name}' could not be uploaded. Please try again.", field="attachments")

    if size == 0:
        try:
            os.remove(dest_path)
        except OSError:
            pass
        raise ValidationError(f"'{original_name}' is empty.", field="attachments")

    if size > MAX_FILE_SIZE_BYTES:
        try:
            os.remove(dest_path)
        except OSError:
            pass
        raise ValidationError(
            f"'{original_name}' is too large (max {MAX_FILE_SIZE_BYTES // (1024*1024)} MB per file).",
            field="attachments",
        )

    if _total_size_in_session(session) + size > MAX_TOTAL_SIZE_BYTES:
        try:
            os.remove(dest_path)
        except OSError:
            pass
        raise ValidationError(
            f"Total attachment size exceeds {MAX_TOTAL_SIZE_BYTES // (1024*1024)} MB.",
            field="attachments",
        )

    entry = {
        "file_id": file_id,
        "client_id": client_id,
        "name": stored_name,
        "original_name": original_name,
        "ext": ext,
        "kind": classify_extension(ext),
        "path": dest_path,
        "url": f"{request_root_url.rstrip('/')}/api/whatsapp/file/{upload_id}/{stored_name}",
        "size": size,
        "status": "success",
    }
    _add_uploaded_file(upload_id, entry)
    return entry


def cleanup_expired_uploads():
    """Deletes attachment folders older than FILE_RETENTION_HOURS, and
    forgets any in-memory upload sessions pointing at them."""
    cutoff = datetime.now() - timedelta(hours=FILE_RETENTION_HOURS)
    try:
        for folder_id in os.listdir(UPLOAD_ROOT):
            folder_path = os.path.join(UPLOAD_ROOT, folder_id)
            if not os.path.isdir(folder_path):
                continue
            modified = datetime.fromtimestamp(os.path.getmtime(folder_path))
            if modified < cutoff:
                for f in os.listdir(folder_path):
                    try:
                        os.remove(os.path.join(folder_path, f))
                    except OSError:
                        pass
                try:
                    os.rmdir(folder_path)
                except OSError:
                    pass
                with _uploads_lock:
                    _uploads.pop(folder_id, None)
    except FileNotFoundError:
        pass


# ══════════════════════════════════════════════════════════════════
#  WHATSAPP DESKTOP DETECTION + LAUNCH (never WhatsApp Web)
# ══════════════════════════════════════════════════════════════════

def is_whatsapp_desktop_installed() -> bool:
    """
    Best-effort detection of an installed native WhatsApp Desktop
    client. Deliberately does NOT check for a browser or
    web.whatsapp.com reachability — only the installed desktop app.
    """
    try:
        if IS_WINDOWS:
            # The Microsoft Store build of WhatsApp Desktop registers
            # the 'whatsapp' URI scheme at install time.
            try:
                import winreg
                winreg.QueryValue(winreg.HKEY_CLASSES_ROOT, r"whatsapp\shell\open\command")
                return True
            except (FileNotFoundError, OSError):
                pass
            # Fallback: look for the Store package folder directly.
            local_appdata = os.environ.get("LOCALAPPDATA", "")
            packages_dir = os.path.join(local_appdata, "Packages")
            if os.path.isdir(packages_dir):
                for name in os.listdir(packages_dir):
                    if name.lower().startswith("5319275a.whatsappdesktop"):
                        return True
            return False

        if IS_MAC:
            return (
                os.path.isdir("/Applications/WhatsApp.app")
                or os.path.isdir(os.path.expanduser("~/Applications/WhatsApp.app"))
            )

        if IS_LINUX:
            for exe in ("whatsapp-for-linux", "whatsapp-desktop", "whatsdesk"):
                if shutil.which(exe):
                    return True
            if os.path.isdir("/snap/whatsapp-for-linux"):
                return True
            return False

    except Exception:
        return False

    return False


def _build_whatsapp_uri(number: str, message: str) -> str:
    # WhatsApp's protocol handler expects the number without the
    # leading '+' and the message URL-encoded.
    return f"whatsapp://send?phone={number.lstrip('+')}&text={quote_plus(message)}"


def launch_whatsapp_desktop_chat(number: str, message: str):
    """
    Opens the given chat inside the installed WhatsApp Desktop app —
    never a browser, never web.whatsapp.com — with the message
    pre-filled. Raises WhatsAppLaunchError on any failure.
    """
    uri = _build_whatsapp_uri(number, message)

    try:
        if IS_WINDOWS:
            # Resolves via the registered 'whatsapp:' protocol handler,
            # which routes straight to the installed desktop app.
            os.startfile(uri)  # noqa: S606 - required to invoke the OS URI handler on Windows
        elif IS_MAC:
            subprocess.run(["open", uri], check=True, timeout=WA_APP_LAUNCH_TIMEOUT)
        elif IS_LINUX:
            subprocess.run(["xdg-open", uri], check=True, timeout=WA_APP_LAUNCH_TIMEOUT)
        else:
            raise WhatsAppLaunchError("This operating system isn't supported for WhatsApp Desktop.")
    except WhatsAppLaunchError:
        raise
    except FileNotFoundError:
        raise WhatsAppLaunchError("WhatsApp Desktop application could not be launched.")
    except subprocess.CalledProcessError:
        raise WhatsAppLaunchError("WhatsApp Desktop application could not be launched.")
    except subprocess.TimeoutExpired:
        raise WhatsAppLaunchError("WhatsApp Desktop application took too long to respond.")
    except OSError:
        raise WhatsAppLaunchError("WhatsApp Desktop application could not be launched.")


def _focus_whatsapp_window() -> bool:
    """Attempts to bring the WhatsApp Desktop window to the foreground."""
    if not PYGETWINDOW_OK:
        return False
    try:
        for _ in range(WA_FOCUS_RETRY_ATTEMPTS):
            titles = [t for t in gw.getAllTitles() if "whatsapp" in t.lower()]
            if titles:
                win = gw.getWindowsWithTitle(titles[0])[0]
                try:
                    win.activate()
                except Exception:
                    # Some platforms require restoring a minimized window first.
                    win.restore()
                    win.activate()
                return True
            time.sleep(WA_FOCUS_RETRY_DELAY)
    except Exception:
        return False
    return False


def _confirm_send_in_desktop_app() -> bool:
    """
    Dispatches the Enter keystroke into the focused WhatsApp Desktop
    window to submit the pre-filled message. Returns True only if the
    window was actually found, focused, and the keystroke was sent.
    """
    if not PYAUTOGUI_OK:
        return False
    if not _focus_whatsapp_window():
        return False
    time.sleep(WA_APP_LOAD_WAIT)
    try:
        pyautogui.press("enter")
        return True
    except Exception:
        return False


def _classify_send_exception(exc: Exception) -> str:
    """Maps low-level automation errors to clean, user-friendly messages."""
    text = str(exc).lower()
    if "connection" in text or "network" in text or "timed out" in text or "timeout" in text:
        return "Network error. Please check your internet connection and try again."
    if "invalid" in text and "phone" in text:
        return "Invalid WhatsApp number."
    return "Message sending failed. Please try again in a moment."


def _build_linked_message(message: str, saved_files: list) -> str:
    """Appends attachment download links to the outgoing text message.

    Used ONLY as an explicit, clearly-communicated fallback on Linux,
    where WhatsApp Desktop clients don't reliably support clipboard
    file-paste. Windows and macOS send the real file instead — see
    `_paste_files_into_whatsapp`.
    """
    if not saved_files:
        return message

    lines = [message.rstrip()] if message.strip() else []
    lines.append("")
    lines.append("📎 Attachments:")
    for f in saved_files:
        lines.append(f"• {f['original_name']} — {f['url']}")
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════
#  NATIVE FILE ATTACHMENT (real files, via OS clipboard + paste)
# ══════════════════════════════════════════════════════════════════

def _set_clipboard_files_windows(paths: list) -> bool:
    """Places files on the Windows clipboard as a CF_HDROP file-drop
    selection — the same clipboard format Windows Explorer uses when
    you copy a file, so any app's Ctrl+V paste picks it up natively."""
    try:
        import win32clipboard
        import win32con

        abs_paths = [os.path.abspath(p) for p in paths]
        file_list = "\0".join(abs_paths) + "\0\0"
        file_list_bytes = file_list.encode("utf-16-le")

        # DROPFILES struct: DWORD pFiles; POINT pt; BOOL fNC; BOOL fWide;
        # pFiles = 20 (offset to the file list that follows this header).
        header = struct.pack("<Iiiii", 20, 0, 0, 0, 1)
        payload = header + file_list_bytes

        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32con.CF_HDROP, payload)
        finally:
            win32clipboard.CloseClipboard()
        return True
    except Exception:
        return False


def _set_clipboard_files_mac(paths: list) -> bool:
    """Places files on the macOS clipboard as POSIX file references via
    osascript — the same thing Finder puts on the clipboard when you
    press Cmd+C on a file, so any app's Cmd+V paste picks it up."""
    try:
        abs_paths = [os.path.abspath(p) for p in paths]
        posix_refs = ", ".join(f'POSIX file "{p}"' for p in abs_paths)
        script = (
            f'set the clipboard to {{{posix_refs}}}'
            if len(abs_paths) > 1
            else f'set the clipboard to (POSIX file "{abs_paths[0]}")'
        )
        subprocess.run(["osascript", "-e", script], check=True, timeout=WA_APP_LAUNCH_TIMEOUT)
        return True
    except Exception:
        return False


def _set_clipboard_files(paths: list) -> bool:
    if IS_WINDOWS:
        return _set_clipboard_files_windows(paths)
    if IS_MAC:
        return _set_clipboard_files_mac(paths)
    return False  # Linux WhatsApp desktop clients don't reliably support this


def _set_clipboard_text(text: str) -> bool:
    """Puts plain UTF-8 text (captions may include emoji) on the OS
    clipboard, used to paste a caption alongside pasted attachments."""
    try:
        if IS_WINDOWS:
            import win32clipboard
            import win32con
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, text)
            finally:
                win32clipboard.CloseClipboard()
            return True
        if IS_MAC:
            subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True, timeout=WA_APP_LAUNCH_TIMEOUT)
            return True
    except Exception:
        return False
    return False


def _paste_files_into_whatsapp(paths: list, caption: str = "") -> bool:
    """
    Copies the given local files onto the OS clipboard as a native
    file selection, focuses the WhatsApp Desktop window, and pastes
    them in — which opens WhatsApp's own attachment preview, exactly
    as if a person had done it — then optionally pastes a caption and
    sends. Returns True ONLY if every step was actually dispatched.
    """
    if not PYAUTOGUI_OK:
        return False
    if not _set_clipboard_files(paths):
        return False
    if not _focus_whatsapp_window():
        return False

    time.sleep(0.8)
    try:
        pyautogui.hotkey("command", "v") if IS_MAC else pyautogui.hotkey("ctrl", "v")
    except Exception:
        return False

    time.sleep(WA_ATTACH_PREVIEW_WAIT)  # let WhatsApp render the attachment preview

    if caption.strip():
        if not _set_clipboard_text(caption):
            return False
        try:
            pyautogui.hotkey("command", "v") if IS_MAC else pyautogui.hotkey("ctrl", "v")
        except Exception:
            return False
        time.sleep(0.5)

    try:
        pyautogui.press("enter")
        return True
    except Exception:
        return False


# ══════════════════════════════════════════════════════════════════
#  SENDING (runs on a background thread)
# ══════════════════════════════════════════════════════════════════

def _run_send_job(job_id, number, message, saved_files):
    _set_job(job_id, status="sending", message="Checking WhatsApp Desktop application...")

    if not is_whatsapp_desktop_installed():
        _set_job(
            job_id,
            status="error",
            message="WhatsApp Desktop application isn't installed on this computer. Please install it and try again.",
        )
        return

    # Linux WhatsApp desktop clients can't reliably receive a clipboard
    # file-paste, so attachments there fall back to shareable links
    # appended to the text — clearly communicated, never silent.
    # Same fallback applies to Windows if pywin32 is not installed.
    use_link_fallback = (IS_LINUX or (IS_WINDOWS and not PYWIN32_OK)) and bool(saved_files)
    text_to_send = _build_linked_message(message, saved_files) if use_link_fallback else message

    try:
        _set_job(job_id, status="sending", message="Opening WhatsApp Desktop application...")
        launch_whatsapp_desktop_chat(number, text_to_send)
        time.sleep(WA_APP_LOAD_WAIT)

        if text_to_send.strip():
            _set_job(job_id, status="sending", message="Sending message text...")
            if not _confirm_send_in_desktop_app():
                _set_job(
                    job_id,
                    status="error",
                    message=(
                        "WhatsApp Desktop opened, but the message couldn't be sent automatically. "
                        "Please press Send inside the app, or try again."
                    ),
                )
                return

        if saved_files and not use_link_fallback:
            _set_job(
                job_id, status="sending",
                message=f"Attaching {len(saved_files)} file(s) in WhatsApp Desktop...",
            )
            file_paths = [f["path"] for f in saved_files]
            attached = _paste_files_into_whatsapp(file_paths)
            if not attached:
                _set_job(
                    job_id,
                    status="error",
                    message=(
                        ("Your message text was sent, but " if text_to_send.strip() else "")
                        + "the attachment(s) couldn't be attached automatically. Please drag and "
                        "drop the file(s) into WhatsApp Desktop manually to finish sending them."
                    ),
                )
                return

        if use_link_fallback:
            _set_job(
                job_id, status="success",
                message="Message Sent Successfully (attachments sent as download links — native file attachment isn't supported on Linux).",
            )
        else:
            _set_job(job_id, status="success", message="Message Sent Successfully")

    except WhatsAppLaunchError as launch_err:
        _set_job(job_id, status="error", message=launch_err.message)
    except Exception as exc:  # noqa: BLE001 - convert every unexpected failure to a clean message
        traceback.print_exc()
        _set_job(job_id, status="error", message=_classify_send_exception(exc))


# ══════════════════════════════════════════════════════════════════
#  BLUEPRINT / ROUTES
# ══════════════════════════════════════════════════════════════════

whatsapp_bp = Blueprint("whatsapp_bp", __name__, url_prefix="/api/whatsapp")


@whatsapp_bp.route("/upload", methods=["POST"])
def api_whatsapp_upload():
    """
    Uploads attachment(s) to the backend IMMEDIATELY after the user
    selects them in the browser — well before "Send Message" is
    clicked. Each file is validated and stored independently, so one
    invalid file in a multi-file selection never blocks the rest.

    Accepts (multipart/form-data):
      upload_id   optional — reuse an existing staging session so
                  files selected across multiple Browse clicks land
                  in the same session
      files       one or more files (repeated field)
      client_ids  optional, repeated field, same order as `files` —
                  an opaque id the frontend uses to match each result
                  back to its own attachment chip

    Returns JSON:
      {
        "upload_id": "...",
        "results": [
          {"client_id", "success": true, "file_id", "name",
           "original_name", "ext", "kind", "size", "url"}
          OR
          {"client_id", "success": false, "error": "..."}
        ]
      }
    """
    cleanup_expired_uploads()

    requested_upload_id = request.form.get("upload_id") or None
    upload_id, session = _get_or_create_upload_session(requested_upload_id)

    files = request.files.getlist("files")
    client_ids = request.form.getlist("client_ids")

    if not files:
        return jsonify({"error": "No files were received.", "field": "attachments"}), 400

    results = []
    for i, file_storage in enumerate(files):
        client_id = client_ids[i] if i < len(client_ids) else None
        try:
            entry = _validate_and_store_single_file(
                file_storage, upload_id, session, request.url_root, client_id=client_id
            )
            results.append({
                "client_id": client_id,
                "success": True,
                "file_id": entry["file_id"],
                "name": entry["original_name"],
                "ext": entry["ext"],
                "kind": entry["kind"],
                "size": entry["size"],
                "url": entry["url"],
                "status": "success",
            })
        except ValidationError as ve:
            results.append({
                "client_id": client_id,
                "success": False,
                "error": ve.message,
                "status": "error",
            })
        except Exception:
            traceback.print_exc()
            results.append({
                "client_id": client_id,
                "success": False,
                "error": "Upload failed due to a server error. Please try again.",
                "status": "error",
            })

    return jsonify({"upload_id": upload_id, "results": results}), 200


@whatsapp_bp.route("/upload/<upload_id>/<file_id>", methods=["DELETE"])
def api_whatsapp_remove_upload(upload_id, file_id):
    """Removes a single staged attachment from both the frontend's
    view and the backend's temporary storage."""
    if not re.fullmatch(r"[0-9a-fA-F]{32}", upload_id) or not re.fullmatch(r"[0-9a-fA-F]{32}", file_id):
        return jsonify({"error": "Invalid attachment reference."}), 400

    removed = _remove_uploaded_file(upload_id, file_id)
    if not removed:
        return jsonify({"error": "Attachment not found or already removed."}), 404

    return jsonify({"status": "removed", "file_id": file_id}), 200


@whatsapp_bp.route("/send", methods=["POST"])
def api_whatsapp_send():
    cleanup_expired_uploads()

    raw_number = request.form.get("number", "")
    raw_message = request.form.get("message", "")
    upload_id = request.form.get("upload_id") or None
    requested_file_ids = request.form.getlist("file_ids")

    try:
        number = normalize_and_validate_number(raw_number)
        message = validate_message_text(raw_message)

        # Attachments must already be uploaded (via /api/whatsapp/upload)
        # before Send is clicked — we never accept raw files here.
        saved_files = []
        if upload_id and requested_file_ids:
            session = _get_upload_session(upload_id)
            if session is None:
                raise ValidationError(
                    "Your attachments session expired. Please re-attach your file(s) and try again.",
                    field="attachments",
                )
            for file_id in requested_file_ids:
                entry = session["files"].get(file_id)
                if entry is None or not os.path.isfile(entry["path"]):
                    raise ValidationError(
                        "One of your attachments is missing on the server. Please remove and re-attach it, then try again.",
                        field="attachments",
                    )
                saved_files.append(entry)

        if not message.strip() and not saved_files:
            raise ValidationError("Type a message or attach a file to send.", field="message")

    except ValidationError as ve:
        return jsonify({"error": ve.message, "field": ve.field}), 400
    except Exception:
        traceback.print_exc()
        return jsonify({"error": "Something went wrong while processing your request."}), 500

    job_id = uuid.uuid4().hex
    _set_job(job_id, status="queued", message="Queued for sending...")

    thread = threading.Thread(
        target=_run_send_job,
        args=(job_id, number, message, saved_files),
        daemon=True,
    )
    thread.start()

    return jsonify({"job_id": job_id, "status": "queued"}), 202


@whatsapp_bp.route("/status/<job_id>", methods=["GET"])
def api_whatsapp_status(job_id):
    job = _get_job(job_id)
    if not job:
        abort(404)
    return jsonify(job)


@whatsapp_bp.route("/file/<folder_id>/<path:filename>", methods=["GET"])
def api_whatsapp_file(folder_id, filename):
    # folder_id must be a plain hex uuid — reject anything else defensively.
    if not re.fullmatch(r"[0-9a-fA-F]{32}", folder_id):
        abort(404)
    folder_path = os.path.join(UPLOAD_ROOT, folder_id)
    safe_name = secure_filename(filename)
    if not safe_name or not os.path.isfile(os.path.join(folder_path, safe_name)):
        abort(404)
    return send_from_directory(folder_path, safe_name, as_attachment=True)


def register_whatsapp_messenger(app):
    """Call once from app.py: register_whatsapp_messenger(app)"""
    app.register_blueprint(whatsapp_bp)


# ══════════════════════════════════════════════════════════════════
#  ORIGINAL STANDALONE CLI (kept for manual/offline use)
# ══════════════════════════════════════════════════════════════════

def whatsapp_message():
    number = input("Enter phone number: ").strip()
    number = "".join(filter(str.isdigit, number))
    if not number.startswith("91"):
        number = "91" + number
    number = "+" + number
    print(f"Number: {number}")

    message = ""
    while not message:
        message = input("Type your message: ").strip()
        if not message:
            print("Please type a message.")

    print(f"Number : {number}")
    print(f"Message: {message}")

    if not is_whatsapp_desktop_installed():
        print("[SNETCH] WhatsApp Desktop application isn't installed. Aborting.")
        return

    print("[SNETCH] Opening WhatsApp Desktop application...")
    try:
        launch_whatsapp_desktop_chat(number, message)
        time.sleep(WA_APP_LOAD_WAIT)
        if _confirm_send_in_desktop_app():
            print("[SNETCH] Message sent successfully.")
        else:
            print("[SNETCH] WhatsApp Desktop opened, but the message could not be sent automatically. Please press Send manually.")
    except WhatsAppLaunchError as launch_err:
        print(f"[SNETCH] {launch_err.message}")


if __name__ == "__main__":
    whatsapp_message()