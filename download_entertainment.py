# ══════════════════════════════════════════════════════════════════
#  download_entertainment.py — S.N.E.T.C.H Entertainment Downloader
#  Backend API for searching & downloading entertainment content
#  via Jackett (torznab) + qBittorrent.
# ══════════════════════════════════════════════════════════════════

import os
import re
import time
import threading
import requests
import xmltodict

try:
    import qbittorrentapi
except ImportError:
    qbittorrentapi = None

from flask import request, jsonify

# ── Config ────────────────────────────────────────────────────────
API_KEY = "9wtu2a8f18yczy5htooq6ytj575kuxvm"
INDEXER = "all"
JACKETT_URL = f"http://localhost:9117/api/v2.0/indexers/{INDEXER}/results/torznab/api"

QB_HOST = "localhost:8080"
QB_USER = "admin"
QB_PASS = "snetch"

DOWNLOADS_DIR = os.path.join(os.path.expanduser("~"), "Downloads")

# ── Category definitions ──────────────────────────────────────────
CATEGORIES = {
    "movies":  {"name": "Movie / Web Series", "icon": "fa-film",
                "keywords": ["movie", "web series", "series", "show", "episode"],
                "strip": ["download", "movie", "web series", "series", "get", "watch"]},
    "pcgame":  {"name": "PC Game", "icon": "fa-gamepad",
                "keywords": ["game", "pc game", "crack", "repack"],
                "strip": ["download", "game", "pc game", "get", "install"]},
    "book":    {"name": "Book", "icon": "fa-book",
                "keywords": ["book", "ebook", "pdf", "epub"],
                "strip": ["download", "book", "ebook", "get", "read"]},
    "audio":   {"name": "Audio", "icon": "fa-music",
                "keywords": ["audio", "music", "song", "album", "mp3"],
                "strip": ["download", "audio", "music", "song", "get", "listen"]},
    "tv":      {"name": "TV", "icon": "fa-tv",
                "keywords": ["tv", "television", "channel"],
                "strip": ["download", "tv", "television", "get", "watch"]},
    "others":  {"name": "Other", "icon": "fa-ellipsis-h",
                "keywords": [],
                "strip": ["download", "get"]},
}


# ── Helpers ───────────────────────────────────────────────────────

def _parse_year(title):
    """Try to extract a 4-digit year from the title."""
    m = re.search(r'\b(19|20)\d{2}\b', title)
    return m.group() if m else None


def _parse_quality(title):
    """Try to guess quality from the title."""
    title_lower = title.lower()
    for q in ["2160p", "4K", "1080p", "720p", "480p", "360p",
              "BluRay", "BDRip", "WEB-DL", "WEBRip", "HDRip",
              "DVDRip", "HDTV", "FLAC", "320kbps", "256kbps", "MP3"]:
        if q.lower() in title_lower:
            return q
    return None


def _is_good_torrent(title, size_gb, category):
    """Filter out cam rips, too-large, and too-small results."""
    title_lower = title.lower()
    bad_words = ["cam", "ts", "telesync", "hdcam"]
    for bad in bad_words:
        if re.search(rf'\b{re.escape(bad)}\b', title_lower):
            return False
    # Category-specific size limits
    if category == "book":
        if size_gb > 2:
            return False
        if size_gb < 0.001:  # < 1 MB
            return False
    elif category == "audio":
        if size_gb > 5:
            return False
        if size_gb < 0.005:
            return False
    else:
        if size_gb > 50:
            return False
        if size_gb < 0.1:
            return False
    return True


def _extract_magnet(item):
    """Extract magnet/download URI from torznab item."""
    link = item.get("link")
    if link and link.startswith(("magnet:", "http")):
        return link
    attrs = item.get("torznab:attr", [])
    if isinstance(attrs, dict):
        attrs = [attrs]
    for attr in attrs:
        if attr.get("@name") == "magneturl" and attr.get("@value"):
            return attr["@value"]
    enclosure = item.get("enclosure")
    if isinstance(enclosure, dict) and enclosure.get("@url"):
        return enclosure["@url"]
    return None


def _get_seeders(item):
    attrs = item.get("torznab:attr", [])
    if isinstance(attrs, dict):
        attrs = [attrs]
    for attr in attrs:
        if attr.get("@name") == "seeders":
            try:
                return int(attr.get("@value", -1))
            except (TypeError, ValueError):
                return -1
    return -1


def _format_size(size_bytes):
    """Human-readable size string."""
    try:
        sb = int(size_bytes)
    except (TypeError, ValueError):
        return "Unknown"
    if sb >= 1024 ** 3:
        return f"{sb / (1024**3):.2f} GB"
    elif sb >= 1024 ** 2:
        return f"{sb / (1024**2):.1f} MB"
    elif sb >= 1024:
        return f"{sb / 1024:.0f} KB"
    return f"{sb} B"


def _format_speed(speed_bytes):
    """Human-readable speed string."""
    if speed_bytes >= 1024 ** 2:
        return f"{speed_bytes / (1024**2):.1f} MB/s"
    elif speed_bytes >= 1024:
        return f"{speed_bytes / 1024:.0f} KB/s"
    return f"{speed_bytes} B/s"


def _format_eta(seconds):
    """Human-readable ETA."""
    if seconds < 0 or seconds > 86400 * 7:
        return "Calculating..."
    if seconds < 60:
        return f"{int(seconds)}s"
    if seconds < 3600:
        return f"{int(seconds // 60)}m {int(seconds % 60)}s"
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    return f"{h}h {m}m"


# ── API: Search ───────────────────────────────────────────────────

def _api_search():
    """POST /api/entertainment/search
    Body: { "category": "movies", "query": "Avengers Endgame" }
    """
    data = request.get_json(force=True, silent=True) or {}
    category = (data.get("category") or "").strip().lower()
    query = (data.get("query") or "").strip()

    if not query:
        return jsonify({"error": "Search query is required."}), 400

    cat_info = CATEGORIES.get(category, CATEGORIES["others"])

    # Clean up query
    clean = query.lower()
    for word in cat_info.get("strip", []):
        clean = clean.replace(word, "")
    clean = re.sub(r'\s+', ' ', clean).strip()

    # Add category context keyword
    search_query = clean
    if cat_info["keywords"]:
        kw = cat_info["keywords"][0]
        if kw not in clean:
            search_query = f"{clean} {kw}"

    params = {"apikey": API_KEY, "t": "search", "q": search_query}

    # Search Jackett
    try:
        resp = requests.get(JACKETT_URL, params=params, timeout=30)
        resp.raise_for_status()
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Jackett is not running. Please start Jackett on port 9117."}), 503
    except requests.exceptions.Timeout:
        return jsonify({"error": "Jackett connection timed out."}), 504
    except requests.exceptions.HTTPError:
        if resp.status_code == 500:
            return jsonify({"error": "All Jackett indexers failed. Check your Jackett dashboard."}), 502
        return jsonify({"error": f"Jackett error: {resp.status_code} {resp.reason}"}), 502
    except Exception as e:
        return jsonify({"error": f"Could not reach Jackett: {e}"}), 503

    # Parse XML results
    try:
        xml_data = xmltodict.parse(resp.text)
        items = xml_data["rss"]["channel"].get("item", [])
        if isinstance(items, dict):
            items = [items]
    except Exception as e:
        return jsonify({"error": f"Failed to parse results: {e}"}), 500

    if not items:
        return jsonify({"error": "No results found. Try a different search term."}), 404

    # Build candidates
    candidates = []
    for item in items:
        title = item.get("title", "Unknown")
        size_bytes = item.get("size")
        try:
            size_gb = int(size_bytes) / (1024 ** 3)
        except (TypeError, ValueError):
            size_gb = 0

        if not _is_good_torrent(title, size_gb, category):
            continue

        magnet = _extract_magnet(item)
        if not magnet:
            continue

        seeders = _get_seeders(item)
        if seeders == 0:
            continue

        candidates.append({
            "id": len(candidates),
            "title": title,
            "magnet": magnet,
            "size": _format_size(size_bytes),
            "size_bytes": int(size_bytes) if size_bytes else 0,
            "seeders": seeders if seeders >= 0 else "N/A",
            "quality": _parse_quality(title) or "Standard",
            "year": _parse_year(title) or "N/A",
            "category": cat_info["name"],
            "description": f"{cat_info['name']} · {_parse_quality(title) or 'Standard'} · {seeders if seeders >= 0 else '?'} seeders",
            "source": item.get("jackettindexer", {}).get("#text", "Unknown") if isinstance(item.get("jackettindexer"), dict) else (item.get("jackettindexer") or "Unknown"),
        })

    if not candidates:
        return jsonify({"error": "No downloadable content found. No seeders or quality matches."}), 404

    candidates.sort(key=lambda c: c["seeders"] if isinstance(c["seeders"], int) else -1, reverse=True)

    return jsonify({"status": "ok", "results": candidates[:15]})


# ── API: Download ─────────────────────────────────────────────────

def _api_download():
    """POST /api/entertainment/download
    Body: { "magnet": "magnet:...", "title": "...", "category": "..." }
    """
    if qbittorrentapi is None:
        return jsonify({"error": "qBittorrent API not installed. Run: pip install qbittorrent-api"}), 500

    data = request.get_json(force=True, silent=True) or {}
    magnet = (data.get("magnet") or "").strip()
    title = (data.get("title") or "Unknown").strip()

    if not magnet:
        return jsonify({"error": "Magnet link is required."}), 400

    try:
        client = qbittorrentapi.Client(host=QB_HOST, username=QB_USER, password=QB_PASS)
        client.auth_log_in()
    except Exception as e:
        err_name = type(e).__name__
        if "LoginFailed" in err_name:
            return jsonify({"error": "qBittorrent login failed. Check username/password."}), 401
        return jsonify({"error": "qBittorrent is not running. Start it and enable Web UI on port 8080."}), 503

    try:
        client.torrents_add(
            urls=magnet,
            save_path=DOWNLOADS_DIR,
            tags="snetch-entertainment",
        )
    except Exception as e:
        return jsonify({"error": f"Failed to add torrent: {e}"}), 500

    # Try to get the torrent hash (qBit may take a moment to register it)
    torrent_hash = None
    for attempt in range(10):
        time.sleep(0.5)
        try:
            torrents = client.torrents_info(tag="snetch-entertainment")
            for t in torrents:
                if title.lower()[:20] in t.name.lower() or t.state in ("downloading", "stalledDL", "metaDL", "allocating", "checkingDL"):
                    torrent_hash = t.hash
                    break
            if torrent_hash:
                break
            # Also try getting most recently added torrent
            all_torrents = client.torrents_info(sort="added_on", reverse=True, limit=5)
            if all_torrents:
                torrent_hash = all_torrents[0].hash
                break
        except Exception:
            continue

    if not torrent_hash:
        # Return success anyway — torrent was added
        return jsonify({
            "status": "ok",
            "message": "Download started",
            "hash": "pending",
            "title": title,
            "save_path": DOWNLOADS_DIR,
        })

    return jsonify({
        "status": "ok",
        "message": "Download started",
        "hash": torrent_hash,
        "title": title,
        "save_path": DOWNLOADS_DIR,
    })


# ── API: Progress ─────────────────────────────────────────────────

def _api_progress(torrent_hash):
    """GET /api/entertainment/progress/<hash>"""
    if qbittorrentapi is None:
        return jsonify({"error": "qBittorrent API not installed."}), 500

    if torrent_hash == "pending":
        return jsonify({
            "status": "ok",
            "progress": 0,
            "download_speed": "0 B/s",
            "downloaded": "0 B",
            "total_size": "Calculating...",
            "eta": "Calculating...",
            "state": "Connecting...",
            "name": "Fetching metadata...",
        })

    try:
        client = qbittorrentapi.Client(host=QB_HOST, username=QB_USER, password=QB_PASS)
        client.auth_log_in()
        torrents = client.torrents_info(torrent_hashes=torrent_hash)
    except Exception as e:
        return jsonify({"error": f"Cannot connect to qBittorrent: {e}"}), 503

    if not torrents:
        return jsonify({"error": "Torrent not found."}), 404

    t = torrents[0]
    progress = round(t.progress * 100, 1)

    # Map qBittorrent states to user-friendly strings
    state_map = {
        "downloading": "Downloading",
        "stalledDL": "Stalled (waiting for peers)",
        "metaDL": "Fetching metadata...",
        "allocating": "Allocating disk space...",
        "checkingDL": "Checking files...",
        "pausedDL": "Paused",
        "queuedDL": "Queued",
        "uploading": "Complete (Seeding)",
        "stalledUP": "Complete (Seeding)",
        "pausedUP": "Complete",
        "checkingUP": "Verifying...",
        "forcedDL": "Downloading (forced)",
        "forcedUP": "Seeding (forced)",
        "missingFiles": "Error: Missing Files",
        "error": "Error",
    }
    state_str = state_map.get(t.state, t.state)
    is_complete = progress >= 100 or t.state in ("uploading", "stalledUP", "pausedUP")

    return jsonify({
        "status": "ok",
        "progress": min(progress, 100),
        "download_speed": _format_speed(t.dlspeed),
        "downloaded": _format_size(t.completed),
        "total_size": _format_size(t.total_size),
        "eta": _format_eta(t.eta) if t.eta and t.eta < 8640000 else "Calculating...",
        "state": state_str,
        "name": t.name,
        "save_path": t.save_path or DOWNLOADS_DIR,
        "is_complete": is_complete,
    })


# ── API: Cancel ───────────────────────────────────────────────────

def _api_cancel(torrent_hash):
    """POST /api/entertainment/cancel/<hash>"""
    if qbittorrentapi is None:
        return jsonify({"error": "qBittorrent API not installed."}), 500

    if torrent_hash == "pending":
        return jsonify({"status": "ok", "message": "Download cancelled."})

    try:
        client = qbittorrentapi.Client(host=QB_HOST, username=QB_USER, password=QB_PASS)
        client.auth_log_in()
        client.torrents_delete(delete_files=True, torrent_hashes=torrent_hash)
    except Exception as e:
        return jsonify({"error": f"Failed to cancel download: {e}"}), 500

    return jsonify({"status": "ok", "message": "Download cancelled."})


# ── Flask Registration ────────────────────────────────────────────

def register_entertainment_downloader(app):
    """Register all entertainment downloader API routes on the Flask app."""

    @app.route("/api/entertainment/search", methods=["POST"])
    def api_entertainment_search():
        return _api_search()

    @app.route("/api/entertainment/download", methods=["POST"])
    def api_entertainment_download():
        return _api_download()

    @app.route("/api/entertainment/progress/<torrent_hash>", methods=["GET"])
    def api_entertainment_progress(torrent_hash):
        return _api_progress(torrent_hash)

    @app.route("/api/entertainment/cancel/<torrent_hash>", methods=["POST"])
    def api_entertainment_cancel(torrent_hash):
        return _api_cancel(torrent_hash)

    @app.route("/api/entertainment/categories", methods=["GET"])
    def api_entertainment_categories():
        cats = []
        for key, val in CATEGORIES.items():
            cats.append({"id": key, "name": val["name"], "icon": val["icon"]})
        return jsonify({"status": "ok", "categories": cats})