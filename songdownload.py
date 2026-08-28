"""
songdownload.py — S.N.E.T.C.H AI Music Downloader (backend)

Searches for the best-matching song via yt-dlp, downloads it as a
high-quality MP3 to the user's system Downloads folder, and exposes
real-time progress data (percentage, speed, ETA, etc.) that the
frontend polls for live UI updates.

Design mirrors the already-working songplay.py pattern in this project:
search via yt-dlp (no API key required), raise clean exceptions that
app.py turns into JSON error responses, and keep all download logic
isolated in this module.

Public functions used by app.py:
    search_song(query)                -> dict   (raises SongNotFoundError / SongDownloadError)
    start_download(video_id, title)   -> str    (download_id; raises SongDownloadError)
    get_progress(download_id)         -> dict
"""

import os
import re
import uuid
import threading
import time
import yt_dlp
import yt_cookies

REQUEST_TIMEOUT = 15  # seconds

# ── Thread-safe download state store ──────────────────────────────
_downloads = {}       # download_id -> progress dict
_downloads_lock = threading.Lock()

# ── Custom exceptions ─────────────────────────────────────────────

class SongNotFoundError(Exception):
    """Raised when no matching song could be found for the query."""


class SongDownloadError(Exception):
    """Raised when a download cannot be started or fails mid-way."""


# ── Internal helpers ──────────────────────────────────────────────

_FILLER_PREFIX_RE = re.compile(
    r"^(play|song|download|get|find)\s+", re.IGNORECASE
)


def _clean_query(raw_query: str) -> str:
    query = (raw_query or "").strip()
    query = re.sub(r"\s+", " ", query)
    stripped = _FILLER_PREFIX_RE.sub("", query, count=1)
    return stripped.strip() or query


def _get_downloads_dir() -> str:
    """Return the system's default Downloads folder."""
    home = os.path.expanduser("~")
    dl_dir = os.path.join(home, "Downloads")
    if not os.path.isdir(dl_dir):
        os.makedirs(dl_dir, exist_ok=True)
    return dl_dir


def _best_thumbnail(entry: dict) -> str:
    thumbs = entry.get("thumbnails") or []
    if thumbs:
        return thumbs[-1].get("url", "")
    vid = entry.get("id")
    return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if vid else ""


def _format_duration(seconds) -> str:
    if not seconds:
        return ""
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _sanitize_filename(name: str) -> str:
    """Remove characters invalid in Windows/macOS/Linux filenames."""
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = name.strip('. ')
    return name or "download"


# ── Public API ────────────────────────────────────────────────────

def search_song(raw_query: str) -> dict:
    """
    Search for the best match to `raw_query`.

    Returns:
        {
          "video_id": str,
          "title": str,
          "artist": str,
          "album": str,
          "cover": str,
          "duration_seconds": int,
          "duration_formatted": str,
        }

    Raises:
        SongNotFoundError  – query empty or nothing matched
        SongDownloadError  – network / extraction failure
    """
    query = _clean_query(raw_query)
    if not query:
        raise SongNotFoundError("Please enter a song name.")

    # Fetch several candidates instead of just the top one — some
    # results are blocked by YouTube's extra verification checks
    # regardless of cookies, and if that happens to be the very first
    # result, a single-result search would fail the whole request even
    # though other (often near-duplicate) uploads of the same song work
    # fine. This picks the first candidate that's actually accessible,
    # so the "same song" experience is preserved for the user.
    search_target = f"ytsearch5:{query} audio"

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": REQUEST_TIMEOUT,
        "extract_flat": False,
        "default_search": "ytsearch",
        "extractor_args": {"youtube": {"player_client": ["android", "web", "ios", "tv"]}},
        # If one of the 5 results is blocked by YouTube's extra
        # verification checks, this makes yt-dlp skip just that entry
        # instead of failing the whole search — so `entries` naturally
        # ends up containing only the candidates that are actually
        # accessible, in original relevance order.
        "ignoreerrors": True,
    }
    # Give yt-dlp a disposable COPY of the cookies file, never the
    # real one — see yt_cookies.py for why.
    _cookie_copy = yt_cookies.get_cookiefile_for_this_run()
    if _cookie_copy:
        opts["cookiefile"] = _cookie_copy

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(search_target, download=False)
    except Exception as exc:
        raise SongDownloadError(
            "Could not reach the music service. Please check your network connection."
        ) from exc
    finally:
        yt_cookies.sync_back_if_healthy(_cookie_copy)
        yt_cookies.cleanup_cookiefile(_cookie_copy)

    entries = info.get("entries") or ([info] if info.get("id") else [])
    entries = [e for e in entries if e and e.get("id")]
    if not entries:
        raise SongNotFoundError(f'No song found for "{query}". Try a different name.')

    entry = entries[0]
    video_id = entry.get("id")
    if not video_id:
        raise SongNotFoundError(f'No playable song found for "{query}".')

    artist = (
        entry.get("artist")
        or entry.get("creator")
        or entry.get("uploader")
        or entry.get("channel")
        or "Unknown Artist"
    )
    album = entry.get("album") or "Single"
    duration_seconds = entry.get("duration") or 0

    return {
        "video_id": video_id,
        "title": entry.get("track") or entry.get("title") or "Untitled",
        "artist": artist,
        "album": album,
        "cover": _best_thumbnail(entry),
        "duration_seconds": duration_seconds,
        "duration_formatted": _format_duration(duration_seconds),
    }


def start_download(video_id: str, title: str = "song") -> str:
    """
    Start an asynchronous download of `video_id` as MP3.

    Returns:
        download_id – a UUID used to poll progress.

    Raises:
        SongDownloadError – invalid video id or immediate failure.
    """
    if not video_id or not re.match(r"^[A-Za-z0-9_-]{6,20}$", video_id):
        raise SongDownloadError("Invalid song reference.")

    download_id = uuid.uuid4().hex[:12]
    safe_title = _sanitize_filename(title)
    downloads_dir = _get_downloads_dir()
    output_template = os.path.join(downloads_dir, f"{safe_title}.%(ext)s")

    # Initialize progress state
    progress = {
        "status": "searching",
        "percentage": 0.0,
        "speed": "",
        "downloaded": "",
        "total": "",
        "eta": "",
        "filename": "",
        "error": None,
        "title": title,
    }

    with _downloads_lock:
        _downloads[download_id] = progress

    def _progress_hook(d):
        with _downloads_lock:
            state = _downloads.get(download_id)
            if not state:
                return

            status = d.get("status", "")

            if status == "downloading":
                state["status"] = "downloading"

                # Percentage
                total_bytes = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded_bytes = d.get("downloaded_bytes") or 0
                if total_bytes > 0:
                    state["percentage"] = round(
                        (downloaded_bytes / total_bytes) * 100, 1
                    )
                else:
                    # Fallback: parse _percent_str
                    pct_str = d.get("_percent_str", "0%").strip().replace("%", "")
                    try:
                        state["percentage"] = round(float(pct_str), 1)
                    except ValueError:
                        pass

                # Speed
                speed = d.get("speed")
                if speed and speed > 0:
                    if speed >= 1048576:
                        state["speed"] = f"{speed / 1048576:.1f} MB/s"
                    elif speed >= 1024:
                        state["speed"] = f"{speed / 1024:.1f} KB/s"
                    else:
                        state["speed"] = f"{speed:.0f} B/s"
                else:
                    state["speed"] = "Calculating..."

                # Downloaded size
                if downloaded_bytes >= 1048576:
                    state["downloaded"] = f"{downloaded_bytes / 1048576:.1f} MB"
                elif downloaded_bytes >= 1024:
                    state["downloaded"] = f"{downloaded_bytes / 1024:.1f} KB"
                else:
                    state["downloaded"] = f"{downloaded_bytes} B"

                # Total size
                if total_bytes >= 1048576:
                    state["total"] = f"{total_bytes / 1048576:.1f} MB"
                elif total_bytes >= 1024:
                    state["total"] = f"{total_bytes / 1024:.1f} KB"
                elif total_bytes > 0:
                    state["total"] = f"{total_bytes} B"
                else:
                    state["total"] = "Unknown"

                # ETA
                eta = d.get("eta")
                if eta is not None and eta >= 0:
                    if eta >= 60:
                        state["eta"] = f"{eta // 60}m {eta % 60}s"
                    else:
                        state["eta"] = f"{eta}s"
                else:
                    state["eta"] = "Calculating..."

            elif status == "finished":
                state["status"] = "processing"
                state["percentage"] = 100.0
                state["speed"] = ""
                state["eta"] = ""
                filename = d.get("filename", "")
                state["filename"] = filename

    def _run_download():
        watch_url = f"https://www.youtube.com/watch?v={video_id}"

        ydl_opts = {
            "format": "bestaudio/best",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "socket_timeout": REQUEST_TIMEOUT,
            "outtmpl": output_template,
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "320",
            }],
            "progress_hooks": [_progress_hook],
            # YouTube blocks/challenges requests from data-center IPs (cloud
            # servers) far more aggressively than home internet. Passing a
            # real browser's cookies, plus falling back across player
            # clients, is what gets around that on a deployed server.
            "extractor_args": {"youtube": {"player_client": ["android", "web", "ios", "tv"]}},
        }
        _cookie_copy = yt_cookies.get_cookiefile_for_this_run()
        if _cookie_copy:
            ydl_opts["cookiefile"] = _cookie_copy

        try:
            with _downloads_lock:
                state = _downloads.get(download_id)
                if state:
                    state["status"] = "downloading"
                    state["percentage"] = 0.0

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([watch_url])

            # Find the actual output mp3 file
            expected_mp3 = os.path.join(downloads_dir, f"{safe_title}.mp3")

            with _downloads_lock:
                state = _downloads.get(download_id)
                if state:
                    state["status"] = "completed"
                    state["percentage"] = 100.0
                    state["speed"] = ""
                    state["eta"] = ""
                    state["filename"] = expected_mp3 if os.path.exists(expected_mp3) else state.get("filename", "")

        except Exception as exc:
            with _downloads_lock:
                state = _downloads.get(download_id)
                if state:
                    state["status"] = "error"
                    state["error"] = str(exc) or "Download failed. Please try again."
        finally:
            yt_cookies.sync_back_if_healthy(_cookie_copy)
            yt_cookies.cleanup_cookiefile(_cookie_copy)

    # Launch download in background thread
    thread = threading.Thread(target=_run_download, daemon=True)
    thread.start()

    return download_id


def get_progress(download_id: str) -> dict:
    """
    Return the current progress state for a download.

    Returns a dict with keys: status, percentage, speed, downloaded,
    total, eta, filename, error, title.
    """
    with _downloads_lock:
        state = _downloads.get(download_id)
        if state is None:
            return {
                "status": "error",
                "error": "Download not found.",
                "percentage": 0,
                "speed": "",
                "downloaded": "",
                "total": "",
                "eta": "",
                "filename": "",
                "title": "",
            }
        # Return a copy so callers can't mutate internal state
        return dict(state)


def cleanup_download(download_id: str):
    """Remove a completed/failed download from the state store."""
    with _downloads_lock:
        _downloads.pop(download_id, None)


if __name__ == "__main__":
    try:
        data = search_song("Believer")
        print(f"Found: {data['title']} by {data['artist']}")
        print(f"Duration: {data['duration_formatted']}")
        print(f"Cover: {data['cover']}")

        dl_id = start_download(data["video_id"], data["title"])
        print(f"Download started: {dl_id}")

        while True:
            time.sleep(1)
            prog = get_progress(dl_id)
            print(f"  [{prog['status']}] {prog['percentage']}% | {prog['speed']} | {prog['downloaded']}/{prog['total']} | ETA: {prog['eta']}")
            if prog["status"] in ("completed", "error"):
                if prog["status"] == "completed":
                    print(f"  Saved to: {prog['filename']}")
                else:
                    print(f"  Error: {prog['error']}")
                cleanup_download(dl_id)
                break
    except (SongNotFoundError, SongDownloadError) as e:
        print(f"Error: {e}")