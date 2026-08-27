"""
songplay.py — S.N.E.T.C.H AI Music Player (backend)

Finds the best-matching song for a free-text query and returns rich
metadata (title, artist, album, duration, cover art) for the premium
"Now Playing" experience, plus everything app.py needs to proxy-stream
the audio to the browser's <audio> element (so playback works from any
machine, with no local VLC/desktop dependency).

Design mirrors the already-working videoplay.py pattern in this project:
search via yt-dlp (no API key required), raise clean exceptions that
app.py turns straight into JSON error responses, and keep all song
logic isolated in this module.

Public functions used by app.py:
    search_song(query)         -> dict  (raises SongNotFoundError / SongServiceError)
    get_audio_stream(video_id) -> dict  (raises SongNotFoundError / SongServiceError)

Both exception types carry a clean, user-friendly message.
"""

import os
import re
import yt_dlp
import yt_cookies

REQUEST_TIMEOUT = 15   # seconds
RELATED_RESULTS = 8    # extra matches pulled back for the recent/playlist rail
YT_COOKIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "www.youtube.com_cookies.txt")


class SongNotFoundError(Exception):
    """Raised when no matching song could be found for the query."""


class SongServiceError(Exception):
    """Raised when the audio source can't be reached / parsed."""


# --- Filler words a voice/text command often carries. Only stripped as
# whole leading words (never mid-word) so titles like "Songbird" or
# "Play That Funky Music" are never mangled. ---
_FILLER_PREFIX_RE = re.compile(
    r"^(play|song|sound)\s+", re.IGNORECASE
)


def _clean_query(raw_query: str) -> str:
    query = (raw_query or "").strip()
    query = re.sub(r"\s+", " ", query)
    # Strip a single leading filler word if the rest of the query isn't empty.
    stripped = _FILLER_PREFIX_RE.sub("", query, count=1)
    return stripped.strip() or query


def _ydl_opts(extra=None):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": REQUEST_TIMEOUT,
        "extract_flat": "in_playlist",
        "default_search": "ytsearch",
    }
    if extra:
        opts.update(extra)
    return opts


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


def _entry_to_song(entry: dict) -> dict:
    video_id = entry.get("id")
    duration_seconds = entry.get("duration") or 0
    artist = entry.get("artist") or entry.get("uploader") or entry.get("channel") or "Unknown Artist"
    album = entry.get("album") or "Single"
    return {
        "video_id": video_id,
        "title": entry.get("track") or entry.get("title") or "Untitled",
        "artist": artist,
        "album": album,
        "cover": _best_thumbnail(entry),
        "duration_seconds": duration_seconds,
        "duration_formatted": _format_duration(duration_seconds),
        "watch_url": entry.get("webpage_url") or (
            f"https://www.youtube.com/watch?v={video_id}" if video_id else ""
        ),
        # This is what the frontend actually points its <audio> element at —
        # a same-origin proxy route in app.py, never the raw source URL
        # (which expires quickly and is blocked by CORS in a browser anyway).
        "stream_url": f"/api/songplay/stream/{video_id}" if video_id else "",
    }


def search_song(raw_query: str) -> dict:
    """
    Search for the best match to `raw_query`.

    Returns:
        {
          "query": str,
          "result": {...best match, see _entry_to_song...},
          "related": [ {...up to RELATED_RESULTS more matches, for the
                         auto-maintained recently-played playlist...} ]
        }

    Raises:
        SongNotFoundError  - query empty, or nothing matched
        SongServiceError   - network / extraction failure
    """
    query = _clean_query(raw_query)
    if not query:
        raise SongNotFoundError("Please enter a song name to search.")

    search_target = f"ytsearch{RELATED_RESULTS + 1}:{query} audio"

    try:
        with yt_dlp.YoutubeDL(_ydl_opts()) as ydl:
            info = ydl.extract_info(search_target, download=False)
    except Exception as exc:
        raise SongServiceError(
            "Could not reach the music service right now. Please check your network connection."
        ) from exc

    entries = [e for e in (info.get("entries") or []) if e]
    if not entries:
        raise SongNotFoundError(f'No song found for "{query}". Try a different name.')

    best = _entry_to_song(entries[0])
    if not best.get("video_id"):
        raise SongNotFoundError(f'No playable song found for "{query}".')

    related = [
        _entry_to_song(e) for e in entries[1:RELATED_RESULTS + 1] if e.get("id")
    ]

    return {"query": query, "result": best, "related": related}


def get_audio_stream(video_id: str) -> dict:
    """
    Resolve a direct, short-lived audio URL for `video_id`, along with the
    HTTP headers required to fetch it (used by app.py's streaming proxy
    route so the browser never talks to the third-party host directly).

    Returns:
        { "url": str, "headers": dict, "mime_type": str }

    Raises:
        SongNotFoundError  - empty/invalid video id
        SongServiceError   - no playable audio stream could be resolved
    """
    if not video_id or not re.match(r"^[A-Za-z0-9_-]{6,20}$", video_id):
        raise SongNotFoundError("Invalid song reference.")

    watch_url = f"https://www.youtube.com/watch?v={video_id}"

    # Try a few extraction strategies, since YouTube periodically throttles
    # or blocks one client type but not another. "android" leads because
    # it's the most reliable for audio-only format resolution; "ios" was
    # dropped from this list — its audio-only streams frequently don't
    # match yt-dlp's "bestaudio" filter at all (a known yt-dlp/YouTube
    # quirk), causing a hard "Requested format is not available" error
    # instead of falling through to try another client.
    opts_list = [
        {
            "format": "bestaudio*/bestaudio/best",
            "quiet": True, "no_warnings": True, "noplaylist": True,
            "socket_timeout": REQUEST_TIMEOUT,
            "extractor_args": {"youtube": {"player_client": ["android"]}},
        },
        {
            "format": "bestaudio*/bestaudio/best",
            "quiet": True, "no_warnings": True, "noplaylist": True,
            "socket_timeout": REQUEST_TIMEOUT,
            "extractor_args": {"youtube": {"player_client": ["tv"]}},
        },
        {
            "format": "bestaudio*/bestaudio/best",
            "quiet": True, "no_warnings": True, "noplaylist": True,
            "socket_timeout": REQUEST_TIMEOUT,
            "extractor_args": {"youtube": {"player_client": ["web"]}},
        },
        {
            "format": "bestaudio*/bestaudio/best",
            "quiet": True, "no_warnings": True, "noplaylist": True,
            "socket_timeout": REQUEST_TIMEOUT,
        },
    ]
    # YouTube blocks/challenges data-center IPs far more than home
    # internet — passing real cookies alongside the client fallbacks
    # above is what makes this work reliably once deployed. All 4
    # strategies share ONE disposable temp copy (see yt_cookies.py) —
    # never the real cookies file, so yt-dlp's own write-back never
    # corrupts it.
    _cookie_copy = yt_cookies.get_cookiefile_for_this_run()
    if _cookie_copy:
        for _opts in opts_list:
            _opts["cookiefile"] = _cookie_copy

    last_error = None
    try:
        for opts in opts_list:
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(watch_url, download=False)
                    url = info.get("url")
                    if not url and info.get("requested_formats"):
                        url = info["requested_formats"][0].get("url")
                    if url:
                        headers = info.get("http_headers") or {
                            "User-Agent": (
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                "AppleWebKit/537.36 (KHTML, like Gecko) "
                                "Chrome/124.0 Safari/537.36"
                            )
                        }
                        return {
                            "url": url,
                            "headers": headers,
                            "mime_type": f"audio/{info.get('ext') or 'webm'}",
                        }
            except Exception as exc:
                last_error = exc
    finally:
        yt_cookies.cleanup_cookiefile(_cookie_copy)

    raise SongServiceError(
        "Playback failed — could not resolve an audio stream for this song."
    ) from last_error


if __name__ == "__main__":
    try:
        data = search_song("Believer")
        print(f"Best match: {data['result']['title']} by {data['result']['artist']}")
        print(f"Related: {[r['title'] for r in data['related']]}")
        stream = get_audio_stream(data["result"]["video_id"])
        print(f"Stream mime: {stream['mime_type']}")
    except (SongNotFoundError, SongServiceError) as e:
        print(f"Error: {e}")