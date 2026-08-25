"""
videoplay.py — S.N.E.T.C.H AI Video Player (backend)

Finds the best-matching YouTube video for a free-text query and returns
everything the frontend needs to run it inside the app's embedded
"YouTube Mode" player, plus a short rail of related results.

IMPORTANT TECHNICAL NOTE (read before touching this file):
YouTube's own security policy (X-Frame-Options / frame-ancestors CSP)
blocks *youtube.com itself* from ever being iframed by another site —
that is enforced by YouTube's servers and can't be bypassed from here
or anywhere else. What YouTube *does* allow to be embedded is its
official player at youtube.com/embed/<id>, which is exactly what this
feature uses. That gives real playback, real controls, and real
click-through to the next video, all served live from YouTube — it's
just the official player instead of the full site chrome (no login,
no channel-subscribe page, etc. inside the frame).

No API key is required: search + metadata come from yt-dlp, which is
already a project dependency (see songplay.py / alarm.py).

Public functions used by app.py:
    search_video(query)   -> dict   (raises VideoNotFoundError / VideoServiceError)

Both exceptions carry a clean, user-friendly message so app.py can turn
them into JSON error responses without any extra translation.
"""

import os
import re
import yt_dlp

REQUEST_TIMEOUT = 15  # seconds
RELATED_RESULTS = 6   # how many extra results to pull for the "related" rail
YT_COOKIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "www.youtube.com_cookies.txt")


class VideoNotFoundError(Exception):
    """Raised when no matching video could be found for the query."""


class VideoServiceError(Exception):
    """Raised when YouTube can't be reached / the response can't be parsed."""


def _clean_query(raw_query: str) -> str:
    """Trim filler words a voice/text command often carries (mirrors the
    light cleanup already used in songplay.py / videoplay.py's old version)."""
    query = (raw_query or "").strip()
    query = re.sub(r"\s+", " ", query)
    return query


def _ydl_opts(extra=None):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": REQUEST_TIMEOUT,
        "extract_flat": "in_playlist",
        "default_search": "ytsearch",
        # See songplay.py / songdownload.py — same reasoning: cloud
        # server IPs get bot-challenged by YouTube far more than home
        # internet, so real browser cookies are needed once deployed.
        "extractor_args": {"youtube": {"player_client": ["android", "web", "ios", "tv"]}},
    }
    if os.path.exists(YT_COOKIES_FILE):
        opts["cookiefile"] = YT_COOKIES_FILE
    if extra:
        opts.update(extra)
    return opts


def _best_thumbnail(entry: dict) -> str:
    thumbs = entry.get("thumbnails") or []
    if thumbs:
        # yt-dlp returns them roughly smallest -> largest; take the largest.
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


def _entry_to_result(entry: dict) -> dict:
    video_id = entry.get("id")
    return {
        "video_id": video_id,
        "title": entry.get("title") or "Untitled",
        "channel": entry.get("uploader") or entry.get("channel") or "Unknown channel",
        "thumbnail": _best_thumbnail(entry),
        "duration": _format_duration(entry.get("duration")),
        "views": entry.get("view_count"),
        "watch_url": entry.get("webpage_url") or (
            f"https://www.youtube.com/watch?v={video_id}" if video_id else ""
        ),
        # youtube-nocookie's official embeddable player — the one surface
        # YouTube actually allows other sites to iframe.
        "embed_url": (
            f"https://www.youtube-nocookie.com/embed/{video_id}"
            f"?autoplay=1&rel=1&modestbranding=1&iv_load_policy=3&playsinline=1"
        ) if video_id else "",
    }


def search_video(raw_query: str) -> dict:
    """
    Search YouTube for the best match to `raw_query`.

    Returns:
        {
          "query": str,
          "result": {...best match, see _entry_to_result...},
          "related": [ {...up to RELATED_RESULTS more matches...} ]
        }

    Raises:
        VideoNotFoundError  - query empty, or nothing matched
        VideoServiceError   - network / extraction failure
    """
    query = _clean_query(raw_query)
    if not query:
        raise VideoNotFoundError("Please enter a video name to search.")

    search_target = f"ytsearch{RELATED_RESULTS + 1}:{query}"

    try:
        with yt_dlp.YoutubeDL(_ydl_opts()) as ydl:
            info = ydl.extract_info(search_target, download=False)
    except Exception as exc:
        raise VideoServiceError(
            "Could not reach YouTube right now. Please check your network connection."
        ) from exc

    entries = [e for e in (info.get("entries") or []) if e]
    if not entries:
        raise VideoNotFoundError(f'No video found for "{query}". Try a different name.')

    best = _entry_to_result(entries[0])
    if not best.get("video_id"):
        raise VideoNotFoundError(f'No playable video found for "{query}".')

    related = [
        _entry_to_result(e) for e in entries[1:RELATED_RESULTS + 1] if e.get("id")
    ]

    return {"query": query, "result": best, "related": related}


def get_related_videos(raw_query: str, offset: int = 0, limit: int = 10) -> list:
    """Fetch additional related videos using pagination for infinite scroll."""
    query = _clean_query(raw_query)
    if not query:
        return []

    search_target = f"ytsearch{offset + limit}:{query}"

    try:
        with yt_dlp.YoutubeDL(_ydl_opts()) as ydl:
            info = ydl.extract_info(search_target, download=False)
    except Exception as exc:
        raise VideoServiceError(
            "Could not reach YouTube right now. Please check your network connection."
        ) from exc

    entries = [e for e in (info.get("entries") or []) if e]
    if not entries:
        return []

    slice_entries = entries[offset : offset + limit]
    return [_entry_to_result(e) for e in slice_entries if e.get("id")]


if __name__ == "__main__":
    try:
        data = search_video("interstellar trailer")
        print(f"Best match: {data['result']['title']} ({data['result']['video_id']})")
        print(f"Related: {[r['title'] for r in data['related']]}")
    except (VideoNotFoundError, VideoServiceError) as e:
        print(f"Error: {e}")