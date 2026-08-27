# ============================================================
# downloadvideo.py
# S.N.E.T.C.H · YouTube Video Downloader (backend)
#
# Exposes a Flask Blueprint with a small JSON API used by
# templates/downloadvideo.html + js/downloadvideo.js:
#
#   POST /api/downloadvideo/resolve      -> look up a video (URL or name), no download
#   POST /api/downloadvideo/start        -> start a background download, returns job_id
#   GET  /api/downloadvideo/progress/<id>-> poll live progress for a job_id
#   POST /api/downloadvideo/cancel/<id>  -> best-effort cancel of an in-flight download
#
# Wiring note: the page route itself (GET /downloadvideo) already lives in
# app.py and is untouched. To expose the API above on the same Flask app,
# app.py needs exactly two additional lines (see bottom of this file for
# the snippet) — nothing about any other feature is touched.
# ============================================================

import os
import re
import uuid
import shutil
import threading
import traceback

from flask import Blueprint, request, jsonify

# ANSI escape sequence pattern (used to clean yt-dlp error messages)
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

try:
    import yt_dlp
    import yt_cookies
except ImportError:  # pragma: no cover - surfaced as a clean error at request time
    yt_dlp = None

downloadvideo_bp = Blueprint("downloadvideo_api", __name__, url_prefix="/api/downloadvideo")


@downloadvideo_bp.errorhandler(Exception)
def handle_exception(e):
    """Ensure every error from this blueprint is JSON, never HTML."""
    code = getattr(e, "code", 500)
    return jsonify({"ok": False, "error": str(e) or "Internal server error"}), code

# ------------------------------------------------------------
# In-memory job store
# ------------------------------------------------------------
# jobs[job_id] = {
#   "status": "queued" | "downloading" | "processing" | "finished" | "error" | "cancelled",
#   "percent": float,
#   "speed": str,              # human readable, e.g. "3.2 MB/s"
#   "downloaded": str,         # human readable size
#   "total": str,              # human readable size
#   "eta": str,                # human readable time
#   "title": str,
#   "channel": str,
#   "duration": str,
#   "thumbnail": str,
#   "filepath": str,
#   "error": str,
#   "_cancel": bool,           # internal cancel flag
# }
jobs = {}
jobs_lock = threading.Lock()

YOUTUBE_URL_RE = re.compile(
    r"^(https?://)?(www\.)?(youtube\.com/(watch\?v=|shorts/|embed/)|youtu\.be/)[\w\-]+",
    re.IGNORECASE,
)


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------
def is_youtube_url(text: str) -> bool:
    return bool(YOUTUBE_URL_RE.match(text.strip()))


def find_ffmpeg():
    return shutil.which("ffmpeg")


def downloads_folder() -> str:
    path = os.path.join(os.path.expanduser("~"), "Downloads")
    os.makedirs(path, exist_ok=True)
    return path


def human_size(num_bytes):
    if not num_bytes:
        return "—"
    num_bytes = float(num_bytes)
    for unit in ["B", "KB", "MB", "GB"]:
        if num_bytes < 1024:
            return f"{num_bytes:.1f} {unit}"
        num_bytes /= 1024
    return f"{num_bytes:.1f} TB"


def human_speed(bytes_per_sec):
    if not bytes_per_sec:
        return "—"
    return f"{human_size(bytes_per_sec)}/s"


def human_eta(seconds):
    if seconds is None:
        return "—"
    seconds = int(seconds)
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def human_duration(seconds):
    if not seconds:
        return "—"
    seconds = int(seconds)
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences (color codes) from yt-dlp error strings."""
    return _ANSI_RE.sub("", text)


def _is_retryable_error(msg: str) -> bool:
    """Return True if the error message suggests retrying with browser cookies."""
    msg = _strip_ansi(msg).lower()
    return any(kw in msg for kw in (
        "bot", "sign in", "age", "403", "forbidden",
        "http error", "login required", "confirm your age",
        "requested format",
    ))


def friendly_error(exc: Exception) -> str:
    """Map yt-dlp / network exceptions to clean, user-facing messages."""
    raw = _strip_ansi(str(exc))
    msg = raw.lower()

    if "private video" in msg:
        return "This video is private and can't be downloaded."
    if "sign in to confirm your age" in msg or ("age" in msg and "restrict" in msg):
        return "This video is age-restricted and can't be downloaded."
    if "video unavailable" in msg or "has been removed" in msg:
        return "This video has been removed or is unavailable."
    if "unable to download webpage" in msg or "network" in msg or "timed out" in msg or "connection" in msg:
        return "Network error. Please check your internet connection and try again."
    if "no video results" in msg or "not found" in msg:
        return "Couldn't find a matching video. Try a different name."
    if "unsupported url" in msg or "is not a valid url" in msg:
        return "That doesn't look like a valid YouTube link."
    if "ffmpeg" in msg:
        return "FFmpeg is required to merge video/audio but wasn't found on this system."
    if "403" in msg or "forbidden" in msg:
        return "YouTube blocked the request (403 Forbidden). Please try again — if it persists, close your browser and retry so cookies can be read."
    if "cookie" in msg:
        return "Could not read browser cookies. Try closing Chrome/Edge and retrying."
    return f"Download failed. Please try again. (Details: {raw})"


def build_ydl_opts(download_path=None, progress_hook=None, browser=None):
    ffmpeg_path = find_ffmpeg()

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": "bv*+ba/bv+ba/b/best" if ffmpeg_path else "b/best",
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
        "retries": 5,
        "fragment_retries": 5,
        "file_access_retries": 3,
        "http_chunk_size": 10 * 1024 * 1024,
        # YouTube has been serving no usable formats to the default "web"
        # client for some videos; falling back through these player clients
        # avoids the "Requested format is not available" error.
        "extractor_args": {
            "youtube": {"player_client": ["android", "web", "ios", "tv"]}
        },
    }

    if browser:
        opts["cookiesfrombrowser"] = (browser, )
    else:
        # On a deployed server there's no local Chrome/Edge to pull
        # cookies from — fall back to a disposable COPY of the
        # exported cookies file instead (never the real one — see
        # yt_cookies.py for why). Without this, "Requested format is
        # not available" / bot-check failures happen on cloud IPs
        # even though the same code works fine on a local PC.
        _cookie_copy = yt_cookies.get_cookiefile_for_this_run()
        if _cookie_copy:
            opts["cookiefile"] = _cookie_copy

    if ffmpeg_path:
        opts["ffmpeg_location"] = ffmpeg_path
        opts["merge_output_format"] = "mp4"

    if download_path:
        opts["outtmpl"] = download_path

    if progress_hook:
        opts["progress_hooks"] = [progress_hook]

    return opts


def extract_metadata(query: str, browser: str = None):
    """Look up a video's metadata without downloading it.

    `query` is either a direct YouTube URL or a free-text video name.
    Returns a dict of metadata, or raises an exception on failure.
    """
    if yt_dlp is None:
        raise RuntimeError("yt-dlp is not installed on the server.")

    target = query if is_youtube_url(query) else f"ytsearch1:{query}"

    # For metadata-only extraction, skip format selection entirely to avoid
    # "Requested format is not available" errors
    meta_opts = build_ydl_opts(browser=browser)
    meta_opts.pop("format", None)               # remove format selector
    meta_opts.pop("merge_output_format", None)   # not merging anything
    meta_opts["skip_download"] = True
    meta_opts["ignore_no_formats_error"] = True  # don't fail if no formats match

    with yt_dlp.YoutubeDL(meta_opts) as ydl:
        try:
            info = ydl.extract_info(target, download=False)
        except yt_dlp.utils.DownloadError as e:
            if "Requested format is not available" in str(e):
                # Some videos have no format yt-dlp is willing to auto-select.
                # For metadata-only lookups we don't need a format picked at
                # all, so retry with process=False to skip format
                # selection/processing entirely and just get the raw info.
                info = ydl.extract_info(target, download=False, process=False)
            else:
                raise

    if info is None:
        raise ValueError("No video results found")

    if "entries" in info:
        entries = [e for e in info["entries"] if e]
        if not entries:
            raise ValueError("No video results found")
        info = entries[0]

    return {
        "video_url": info.get("webpage_url") or info.get("url"),
        "title": info.get("title") or "Untitled video",
        "channel": info.get("uploader") or info.get("channel") or "Unknown channel",
        "duration": human_duration(info.get("duration")),
        "duration_seconds": info.get("duration") or 0,
        "thumbnail": info.get("thumbnail") or "",
    }


def run_download(job_id: str, video_url: str, browser: str = None):
    with jobs_lock:
        jobs[job_id]["status"] = "downloading"

    def hook(d):
        with jobs_lock:
            job = jobs.get(job_id)
            if not job:
                return
            if job.get("_cancel"):
                raise yt_dlp.utils.DownloadError("Download cancelled by user")

            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                downloaded = d.get("downloaded_bytes", 0)
                percent = round((downloaded / total) * 100, 1) if total else job.get("percent", 0)

                job.update({
                    "status": "downloading",
                    "percent": percent,
                    "speed": human_speed(d.get("speed")),
                    "downloaded": human_size(downloaded),
                    "total": human_size(total),
                    "eta": human_eta(d.get("eta")),
                })

            elif d["status"] == "finished":
                job.update({
                    "status": "processing",
                    "percent": 99.0,
                    "eta": "—",
                })

    try:
        download_path = os.path.join(downloads_folder(), "%(title)s.%(ext)s")
        opts = build_ydl_opts(download_path=download_path, progress_hook=hook, browser=browser)

        # --- FIX: retry with plain "best" if the first format pick fails ---
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(video_url, download=True)
                final_path = ydl.prepare_filename(info)
                # If ffmpeg merged into mp4, the actual extension may differ from the template
                if find_ffmpeg():
                    root, _ext = os.path.splitext(final_path)
                    mp4_path = root + ".mp4"
                    if os.path.exists(mp4_path):
                        final_path = mp4_path
        except yt_dlp.utils.DownloadError as exc:
            if "Requested format is not available" in str(exc):
                opts["format"] = "best"
                opts.pop("merge_output_format", None)
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(video_url, download=True)
                    final_path = ydl.prepare_filename(info)
            else:
                raise
        # ------------------------------------------------------------------

        with jobs_lock:
            jobs[job_id].update({
                "status": "finished",
                "percent": 100.0,
                "eta": "0s",
                "filepath": final_path,
                "downloads_folder": downloads_folder(),
            })

    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        with jobs_lock:
            job = jobs.get(job_id)
            if job:
                if job.get("_cancel"):
                    job["status"] = "cancelled"
                else:
                    job["status"] = "error"
                    job["error"] = friendly_error(exc)


# ------------------------------------------------------------
# Routes
# ------------------------------------------------------------
@downloadvideo_bp.route("/resolve", methods=["POST"])
def api_resolve():
    data = request.get_json(silent=True) or {}
    query = (data.get("query") or "").strip()

    if not query:
        return jsonify({"ok": False, "error": "Please enter a YouTube link or a video name."}), 400

    if yt_dlp is None:
        return jsonify({"ok": False, "error": "yt-dlp is not installed on the server. Run: pip install yt-dlp"}), 500

    try:
        browser_used = None
        try:
            meta = extract_metadata(query)
        except Exception as e:
            if _is_retryable_error(str(e)):
                # Try with browser cookies — Chrome first, then Edge
                for browser_name in ("chrome", "edge"):
                    try:
                        meta = extract_metadata(query, browser=browser_name)
                        browser_used = browser_name
                        break
                    except Exception:
                        continue
                else:
                    # All browser cookie attempts failed — re-raise original
                    raise e
            else:
                raise e
                
        return jsonify({"ok": True, "browser": browser_used, **meta})
    except Exception as exc:  # noqa: BLE001
        import traceback
        with open('yt_error.txt', 'w') as f:
            f.write(traceback.format_exc())
        traceback.print_exc()
        return jsonify({"ok": False, "error": friendly_error(exc)}), 400


@downloadvideo_bp.route("/start", methods=["POST"])
def api_start():
    data = request.get_json(silent=True) or {}
    video_url = (data.get("video_url") or "").strip()
    browser = data.get("browser")

    if not video_url:
        return jsonify({"ok": False, "error": "No video selected to download."}), 400

    if yt_dlp is None:
        return jsonify({"ok": False, "error": "yt-dlp is not installed on the server. Run: pip install yt-dlp"}), 500

    job_id = uuid.uuid4().hex
    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "percent": 0.0,
            "speed": "—",
            "downloaded": "—",
            "total": "—",
            "eta": "—",
            "title": data.get("title", ""),
            "channel": data.get("channel", ""),
            "duration": data.get("duration", ""),
            "thumbnail": data.get("thumbnail", ""),
            "filepath": "",
            "error": "",
            "_cancel": False,
        }

    thread = threading.Thread(target=run_download, args=(job_id, video_url, browser), daemon=True)
    thread.start()

    return jsonify({"ok": True, "job_id": job_id})


@downloadvideo_bp.route("/progress/<job_id>", methods=["GET"])
def api_progress(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return jsonify({"ok": False, "error": "Unknown download job."}), 404
        payload = {k: v for k, v in job.items() if not k.startswith("_")}

    return jsonify({"ok": True, **payload})


@downloadvideo_bp.route("/cancel/<job_id>", methods=["POST"])
def api_cancel(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return jsonify({"ok": False, "error": "Unknown download job."}), 404
        job["_cancel"] = True

    return jsonify({"ok": True})


# ============================================================
# ONE-TIME WIRING (required, ~2 lines in app.py)
# ============================================================
# This blueprint must be registered on the shared Flask `app`
# instance so the API routes above become reachable. Add, near
# the other feature imports at the top of app.py:
#
#     from downloadvideo import downloadvideo_bp
#
# and, anywhere after `app = Flask(__name__, ...)` is created:
#
#     app.register_blueprint(downloadvideo_bp)
#
# Nothing else in app.py needs to change — the existing
# `GET /downloadvideo` page route is untouched.
# ============================================================