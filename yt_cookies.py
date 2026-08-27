# =============================================================
#  yt_cookies.py — shared helper for every feature that uses
#  yt-dlp against YouTube (alarm tones, song/video download,
#  song/video play, daily task & reminder tones, YouTube chatbot).
# =============================================================
#
#  WHY THIS FILE EXISTS
#  ---------------------
#  yt-dlp doesn't just READ a cookies file you give it — it also
#  WRITES back to it after every run, to persist refreshed session
#  tokens (things like updated __Secure-1PSIDTS values). That's
#  normally a helpful feature. But when many different features on
#  this server all point straight at the SAME cookies file:
#
#  1. If the file is writable, repeated yt-dlp runs can end up
#     silently stripping out the real login cookies (SID, SSID,
#     LOGIN_INFO) over time, leaving only harmless tracking cookies
#     — which makes every download look like an anonymous bot again.
#  2. If the file is made read-only to stop that, yt-dlp instead
#     crashes outright with "Permission denied" the moment it tries
#     to save back.
#
#  THE FIX
#  --------
#  Keep exactly one master cookies file, exported by hand from a
#  real logged-in browser, and make it read-only forever — nothing
#  in this codebase should ever be able to modify it. Every time a
#  feature actually needs to call yt-dlp, it asks this module for a
#  cookiefile, which hands back a disposable TEMP COPY instead. Any
#  writes yt-dlp makes only ever touch that throwaway copy. The
#  master file is never opened for writing by anything, ever.
# =============================================================

import os
import shutil
import tempfile

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MASTER_COOKIES_FILE = os.path.join(BASE_DIR, "www.youtube.com_cookies.txt")


def get_cookiefile_for_this_run():
    """Returns a path to a fresh, writable, disposable copy of the
    master cookies file for a single yt-dlp call — or None if no
    master cookies file exists yet on this server.

    Callers should pass the returned path as `cookiefile` in their
    yt_dlp.YoutubeDL options. Cleanup of the temp copy is best-effort
    (see cleanup_cookiefile) — leftover copies are a few KB each in
    the OS temp directory and are not worth blocking a request over.
    """
    if not os.path.exists(MASTER_COOKIES_FILE):
        return None
    try:
        fd, tmp_path = tempfile.mkstemp(prefix="ytdlp_cookies_", suffix=".txt")
        os.close(fd)
        shutil.copyfile(MASTER_COOKIES_FILE, tmp_path)
        return tmp_path
    except OSError:
        # If anything goes wrong making the temp copy (disk full,
        # permissions, etc.), fail soft — the caller just proceeds
        # without cookies rather than crashing the whole request.
        return None


def cleanup_cookiefile(path):
    """Best-effort deletion of a temp cookie copy returned above.
    Safe to call with None or an already-deleted path."""
    if not path:
        return
    try:
        os.remove(path)
    except OSError:
        pass