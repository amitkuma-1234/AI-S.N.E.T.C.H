# =============================================================
#  yt_cookies.py — shared helper for every feature that uses
#  yt-dlp against YouTube (alarm tones, song/video download,
#  song/video play, daily task & reminder tones, YouTube chatbot).
# =============================================================
#
#  THE PROBLEM, IN TWO PARTS
#  ---------------------------
#  1. yt-dlp doesn't just READ a cookies file — it also WRITES back
#     to it after every run, to refresh short-lived session tokens
#     (things like __Secure-1PSIDTS). This refresh is actually what
#     keeps a YouTube login session alive for a long time — real
#     browsers do the same thing constantly in the background.
#  2. But when several requests hit this server around the same
#     time, more than one yt-dlp process can end up reading and
#     writing the SAME cookies file concurrently. Two overlapping
#     writes can corrupt the file — stripping out the real login
#     cookies (SID, LOGIN_INFO) and leaving only harmless tracking
#     cookies — which is exactly what happened here after a few
#     days of normal use.
#
#  An earlier version of this file "solved" #2 by giving yt-dlp a
#  disposable temp copy every time and throwing it away afterward.
#  That stopped the corruption, but it also threw away every
#  legitimate refresh yt-dlp made — so the session could never
#  renew itself and went stale (and got fully logged out by
#  YouTube) in just a few days instead of lasting for weeks.
#
#  THE FIX — SYNC BACK, BUT ONLY IF IT'S ACTUALLY HEALTHY
#  ---------------------------------------------------------
#  Every yt-dlp call still gets its own private temp copy (so
#  concurrent runs can never corrupt each other — problem #2 stays
#  fixed). But after the call finishes, this module checks whether
#  that copy still contains the real login cookies. If it does,
#  it's promoted to become the new master file, carrying its
#  refreshed tokens forward — this is what lets the session renew
#  itself and last far longer (problem #1 is now actually fixed,
#  not just avoided).
#
#  If a copy ever comes back looking broken (login cookies missing,
#  file empty, wrong format, etc.), it's discarded instead — the
#  master file is left exactly as it was, so a single bad run can
#  never corrupt anything. A dated backup of the last known-good
#  master is also kept, so a person can manually restore it if
#  something ever goes wrong beyond what this module catches.
#
#  This makes the cookies effectively self-healing: legitimate use
#  extends their life indefinitely, and any corruption self-repairs
#  back to the last good state instead of requiring a person to
#  notice the failure and manually re-export new cookies.
#
#  IMPORTANT HONESTY NOTE — there is still no way to make this
#  100% permanent. YouTube can always force a real logout (a
#  password change, an explicit "sign out of all devices", or the
#  account being flagged) and there's nothing any code here can do
#  about that — a person would need to export fresh cookies again
#  in that case. What this module fixes is the SELF-INFLICTED
#  expiry this server was causing through file corruption and lost
#  refreshes — the everyday case, not the rare account-level one.
# =============================================================

import os
import shutil
import tempfile
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MASTER_COOKIES_FILE = os.path.join(BASE_DIR, "www.youtube.com_cookies.txt")
BACKUP_COOKIES_FILE = os.path.join(BASE_DIR, "www.youtube.com_cookies.backup.txt")

# Guards the "promote a temp copy to master" step so two concurrent
# requests can never both write to the master file at the same time.
_sync_lock = threading.Lock()

# Cookie names that only ever appear on a genuinely logged-in
# session. If a file has none of these, it's either a fresh/empty
# export or a corrupted one — never something safe to promote.
_LOGIN_COOKIE_MARKERS = ("LOGIN_INFO", "SID", "SSID", "__Secure-1PSID")


def _looks_like_healthy_login_cookiejar(path):
    """True only if `path` is a well-formed Netscape cookies file
    that still contains real login cookies (not just tracking
    cookies like _ga/VISITOR_INFO1_LIVE, which survive even after a
    real logout and would otherwise look "fine" at a glance)."""
    try:
        if not os.path.isfile(path) or os.path.getsize(path) < 50:
            return False
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
    except OSError:
        return False

    if "# Netscape HTTP Cookie File" not in content:
        return False
    # Each cookie is one tab-separated line; the 6th field is the name.
    names = set()
    for line in content.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 6:
            names.add(parts[5])
    return any(marker in names for marker in _LOGIN_COOKIE_MARKERS)


def get_cookiefile_for_this_run():
    """Returns a path to a private, writable temp copy of the master
    cookies file for one yt-dlp call — or None if no master cookies
    file exists yet on this server.

    Pass the returned path as `cookiefile` in the yt_dlp.YoutubeDL
    options, and pass it to sync_back_if_healthy() when the call is
    done (see cleanup_cookiefile / sync_back_if_healthy below).
    """
    if not os.path.exists(MASTER_COOKIES_FILE):
        return None
    try:
        fd, tmp_path = tempfile.mkstemp(prefix="ytdlp_cookies_", suffix=".txt")
        os.close(fd)
        shutil.copyfile(MASTER_COOKIES_FILE, tmp_path)
        return tmp_path
    except OSError:
        return None


def sync_back_if_healthy(tmp_path):
    """Call this after yt-dlp has finished using a cookiefile
    returned by get_cookiefile_for_this_run(). If yt-dlp refreshed
    the cookies and the result still looks like a real, logged-in
    session, this promotes it to be the new master file (backing up
    the previous one first) — carrying the refreshed tokens forward
    so the session keeps renewing itself instead of going stale.

    If the copy looks broken instead, nothing is touched — the
    existing master file is left exactly as it was.
    """
    if not tmp_path or not os.path.exists(tmp_path):
        return
    if not _looks_like_healthy_login_cookiejar(tmp_path):
        return  # don't promote a broken/empty/logged-out copy

    with _sync_lock:
        try:
            if os.path.exists(MASTER_COOKIES_FILE):
                shutil.copyfile(MASTER_COOKIES_FILE, BACKUP_COOKIES_FILE)
            shutil.copyfile(tmp_path, MASTER_COOKIES_FILE)
        except OSError:
            pass  # best-effort — a failed sync just means next run reuses the old master


def cleanup_cookiefile(path):
    """Best-effort deletion of a temp cookie copy. Safe to call with
    None or an already-deleted path. Call sync_back_if_healthy(path)
    BEFORE this, if the caller wants refreshed cookies to persist."""
    if not path:
        return
    try:
        os.remove(path)
    except OSError:
        pass


def restore_from_backup():
    """Manual escape hatch: if the master file is ever in a bad
    state despite the safeguards above, this restores the last
    known-good backup. Not called automatically — available for a
    person to invoke (e.g. via a one-off script or Python shell) if
    they ever need it."""
    if not os.path.exists(BACKUP_COOKIES_FILE):
        return False
    shutil.copyfile(BACKUP_COOKIES_FILE, MASTER_COOKIES_FILE)
    return True