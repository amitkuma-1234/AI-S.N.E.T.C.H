"""
S.N.E.T.C.H — REMINDER MODULE (Web Edition)
=============================================
Professional Reminder Management System backend.

Supports: Set | Update | Delete (one / multiple / all) | Show reminders,
each with its own optional reminder tone (pick from reminder_tone/,
download a new one, or skip to use the app's default tone).

Data:  db_storage/reminder_data.db   (SQLite — table "reminders")
Tones: reminder_tone/                (downloaded / stored audio files)

This module is imported by app.py and exposes small, non-interactive
"api_*" functions that the Flask routes call directly — mirroring the
exact same pattern used by alarm.py (alarms) and dailytask.py (tasks)
elsewhere in this project, so the Reminder feature slots into the
existing S.N.E.T.C.H architecture without touching any other feature.
"""

import base64
import datetime
import mimetypes
import os
import re
import shutil
import sqlite3
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "db_storage", "reminder_data.db")
TONE_FOLDER = os.path.join(BASE_DIR, "reminder_tone")
DEFAULT_TONE_FILENAME = "default_tone.mp3"

VALID_TONE_EXTS = (".mp3", ".wav", ".ogg", ".m4a")
NAME_SAFE_RE = re.compile(r'[\\/*?:"<>|]')

_lock = threading.Lock()  # guards the reminders table + tone folder


# ════════════════════════════════════════════════════════════════
#  DB SETUP
# ════════════════════════════════════════════════════════════════

def get_conn():
    folder = os.path.dirname(DB_PATH)
    if os.path.exists(folder) and not os.path.isdir(folder):
        os.remove(folder)
    os.makedirs(folder, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    ensure_tone_folder()
    ensure_default_tone()
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            hour INTEGER NOT NULL,
            minute INTEGER NOT NULL,
            ampm TEXT NOT NULL,
            day INTEGER NOT NULL,
            month INTEGER NOT NULL,
            year INTEGER NOT NULL,
            tone TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()


# ════════════════════════════════════════════════════════════════
#  TONE HELPERS  (reminder_tone/ folder)
# ════════════════════════════════════════════════════════════════

def ensure_tone_folder():
    os.makedirs(TONE_FOLDER, exist_ok=True)


def ensure_default_tone():
    """Make sure a default reminder tone file exists inside reminder_tone/,
    so 'Skip' during Set/Update Reminder always has something to fall back
    on. If it's missing, copy one of the audio assets already bundled with
    the project (no new external asset is introduced)."""
    ensure_tone_folder()
    dest = os.path.join(TONE_FOLDER, DEFAULT_TONE_FILENAME)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    candidates = [
        os.path.join(BASE_DIR, "alarm_tone", "wolf sound ringtone.mp3"),
        os.path.join(BASE_DIR, "task_tone", "on my way ringtone.mp3"),
    ]
    for src in candidates:
        if os.path.exists(src):
            try:
                shutil.copyfile(src, dest)
                return
            except Exception:
                continue


def get_tone_files() -> list:
    """List every tone file currently stored in reminder_tone/, default
    tone first, everything else alphabetical after it."""
    ensure_tone_folder()
    files = sorted(
        f for f in os.listdir(TONE_FOLDER)
        if f.lower().endswith(VALID_TONE_EXTS)
    )
    if DEFAULT_TONE_FILENAME in files:
        files.remove(DEFAULT_TONE_FILENAME)
        files.insert(0, DEFAULT_TONE_FILENAME)
    return files


def _tone_data_uri(filename: str) -> str:
    """Read a tone file from reminder_tone/ and return it as a base64 data
    URI so the browser can play it with a plain Audio object — no dedicated
    file-serving route is needed."""
    if not filename:
        return ""
    path = os.path.join(TONE_FOLDER, filename)
    if not os.path.exists(path):
        return ""
    mime, _ = mimetypes.guess_type(filename)
    mime = mime or "audio/mpeg"
    try:
        with open(path, "rb") as f:
            encoded = base64.b64encode(f.read()).decode("ascii")
        return f"data:{mime};base64,{encoded}"
    except Exception:
        return ""


def api_get_tone_list() -> list:
    """Web API: every stored reminder tone with its display name and its
    audio data (base64 data URI), default tone first."""
    tones = []
    for f in get_tone_files():
        is_default = f == DEFAULT_TONE_FILENAME
        tones.append({
            "filename": f,
            "name": "Default Tone" if is_default else os.path.splitext(f)[0],
            "data": _tone_data_uri(f),
            "is_default": is_default,
        })
    return tones


def _safe_tone_filename(tone: str) -> str:
    """Given a filename or a 'default'/empty value, resolve it to a
    filename that actually exists inside reminder_tone/, else the
    default tone filename."""
    default_exists = os.path.exists(os.path.join(TONE_FOLDER, DEFAULT_TONE_FILENAME))
    if not tone or tone.lower() == "default":
        return DEFAULT_TONE_FILENAME if default_exists else ""
    base = os.path.basename(tone)
    if os.path.exists(os.path.join(TONE_FOLDER, base)):
        return base
    return DEFAULT_TONE_FILENAME if default_exists else ""


def download_tone_by_name(name: str) -> dict:
    """Non-interactive tone download for the web API. Downloads `name` as
    an mp3 into reminder_tone/ using yt-dlp and returns
    {"ok": bool, "filename": str, "error": str|None}.

    IMPORTANT (per feature spec): this call BLOCKS until the download has
    fully completed and the file is confirmed to exist inside
    reminder_tone/. The frontend keeps its Save button disabled for the
    entire duration of this request, and only enables it once this
    function returns ok=True.
    """
    name = (name or "").strip()
    if not name:
        return {"ok": False, "filename": "", "error": "Tone name is required."}

    safe_name = NAME_SAFE_RE.sub("", name).strip() or "reminder_tone"

    try:
        import yt_dlp
        import yt_cookies
    except ImportError:
        return {"ok": False, "filename": "", "error": "yt-dlp is not installed on the server."}

    ensure_tone_folder()
    out_path = os.path.join(TONE_FOLDER, safe_name)
    ydl_opts = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "outtmpl": f"{out_path}.%(ext)s",
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        "extractor_args": {"youtube": {"player_client": ["android", "web", "ios", "tv"]}},
    }
    # Give yt-dlp a disposable COPY of the cookies file, never the
    # real one — see yt_cookies.py for why.
    _cookie_copy = yt_cookies.get_cookiefile_for_this_run()
    if _cookie_copy:
        ydl_opts["cookiefile"] = _cookie_copy

    # Some search results are blocked by YouTube's extra verification
    # checks regardless of cookies — try several candidates instead of
    # only the single top result, using the first one that works.
    try:
        with yt_dlp.YoutubeDL({**ydl_opts, "extract_flat": "in_playlist", "quiet": True}) as search_ydl:
            search_result = search_ydl.extract_info(f"ytsearch5:{safe_name}", download=False)
        candidates = (search_result or {}).get("entries") or []
        if not candidates:
            return {"ok": False, "filename": "", "error": "No results found for that search."}

        last_error = None
        downloaded = False
        for entry in candidates:
            video_id = entry.get("id")
            if not video_id:
                continue
            # Build the watch URL explicitly from the raw video ID —
            # entry.get("url") from a flat/in_playlist search often
            # holds just the bare ID (not a full URL), which yt-dlp
            # cannot resolve on its own, making every candidate look
            # like it failed even when it was actually fine.
            video_url = f"https://www.youtube.com/watch?v={video_id}"
            if not video_url:
                continue
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    ydl.extract_info(video_url, download=True)
                downloaded = True
                break
            except Exception as e:
                last_error = e
                continue
        if not downloaded:
            raise last_error or RuntimeError("All candidates failed.")
    except Exception as e:
        return {"ok": False, "filename": "", "error": f"Download failed: {e}"}
    finally:
        yt_cookies.sync_back_if_healthy(_cookie_copy)
        yt_cookies.cleanup_cookiefile(_cookie_copy)

    final_file = f"{safe_name}.mp3"
    final_path = os.path.join(TONE_FOLDER, final_file)

    if os.path.exists(final_path) and os.path.getsize(final_path) > 0:
        return {"ok": True, "filename": final_file, "error": None}

    return {"ok": False, "filename": "", "error": "Tone did not save correctly. Please try again."}


# ════════════════════════════════════════════════════════════════
#  DATE / TIME HELPERS
# ════════════════════════════════════════════════════════════════

def _to_datetime(day, month, year, hour, minute, ampm):
    """Builds a real datetime from 12-hour wall-clock fields.
    Returns (datetime, error_message)."""
    try:
        day, month, year, hour, minute = int(day), int(month), int(year), int(hour), int(minute)
    except (TypeError, ValueError):
        return None, "Please provide valid numeric date/time values."

    ampm = (ampm or "").strip().upper()
    if ampm not in ("AM", "PM"):
        return None, "AM/PM must be either 'AM' or 'PM'."
    if not (1 <= hour <= 12):
        return None, "Hour must be between 1 and 12."
    if not (0 <= minute <= 59):
        return None, "Minute must be between 0 and 59."

    hour_24 = hour % 12
    if ampm == "PM":
        hour_24 += 12

    try:
        dt = datetime.datetime(year, month, day, hour_24, minute, 0)
    except ValueError:
        return None, "That date doesn't exist. Please check the day/month/year."

    return dt, None


def _row_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "hour": row["hour"],
        "minute": row["minute"],
        "ampm": row["ampm"],
        "day": row["day"],
        "month": row["month"],
        "year": row["year"],
        "tone": row["tone"] or "",
        "created_at": row["created_at"],
    }


def _public_reminder(row) -> dict:
    d = _row_to_dict(row)
    dt, _ = _to_datetime(d["day"], d["month"], d["year"], d["hour"], d["minute"], d["ampm"])
    tone_file = d["tone"]
    d["tone_name"] = "Default Tone" if (not tone_file or tone_file == DEFAULT_TONE_FILENAME) else os.path.splitext(tone_file)[0]
    d["tone_data"] = _tone_data_uri(tone_file or DEFAULT_TONE_FILENAME)
    d["datetime_iso"] = dt.strftime("%Y-%m-%dT%H:%M:%S") if dt else None
    d["date_display"] = dt.strftime("%d %b %Y") if dt else ""
    d["time_display"] = f"{d['hour']:02d}:{d['minute']:02d} {d['ampm']}"
    d["is_due"] = bool(dt and dt <= datetime.datetime.now())
    return d


# ════════════════════════════════════════════════════════════════
#  1. SET REMINDER  (create)
# ════════════════════════════════════════════════════════════════

def api_get_reminders() -> list:
    """Return every saved reminder, soonest first, web-shaped."""
    with _lock:
        conn = get_conn()
        rows = conn.execute("SELECT * FROM reminders").fetchall()
        conn.close()
    reminders = [_public_reminder(r) for r in rows]
    reminders.sort(key=lambda r: r["datetime_iso"] or "9999")
    return reminders


def api_create_reminder(name, hour, minute, ampm, day, month, year, tone="") -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("Reminder name is required.")

    now = datetime.datetime.now()
    dt, err = _to_datetime(day, month, year, hour, minute, ampm)
    if err:
        raise ValueError(err)
    if dt <= now:
        raise ValueError(f"That time ({dt.strftime('%d %b %Y, %I:%M %p')}) is in the past. Please choose a future date/time.")

    with _lock:
        conn = get_conn()
        cur = conn.execute(
            """INSERT INTO reminders (name, hour, minute, ampm, day, month, year, tone, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, int(hour), int(minute), ampm.strip().upper(), int(day), int(month), int(year),
             _safe_tone_filename(tone), datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
        )
        conn.commit()
        new_id = cur.lastrowid
        row = conn.execute("SELECT * FROM reminders WHERE id = ?", (new_id,)).fetchone()
        conn.close()

    return _public_reminder(row)


# ════════════════════════════════════════════════════════════════
#  2. UPDATE REMINDER
# ════════════════════════════════════════════════════════════════

def api_update_reminder(reminder_id, name=None, hour=None, minute=None, ampm=None,
                         day=None, month=None, year=None, tone=None, keep_tone=False) -> dict:
    """Update an existing reminder. Any of name/hour/minute/ampm/day/month/
    year may be provided to overwrite that field; tone overwrites unless
    keep_tone=True (used when the user picks Skip during Update, which
    means: leave the previously selected tone unchanged).
    Returns the updated reminder dict, or None if reminder_id doesn't
    exist. Raises ValueError on invalid/past date-time."""
    with _lock:
        conn = get_conn()
        row = conn.execute("SELECT * FROM reminders WHERE id = ?", (reminder_id,)).fetchone()
        if row is None:
            conn.close()
            return None
        current = _row_to_dict(row)

        new_name = name.strip() if (name is not None and name.strip()) else current["name"]
        new_hour = int(hour) if hour is not None else current["hour"]
        new_minute = int(minute) if minute is not None else current["minute"]
        new_ampm = ampm.strip().upper() if ampm is not None else current["ampm"]
        new_day = int(day) if day is not None else current["day"]
        new_month = int(month) if month is not None else current["month"]
        new_year = int(year) if year is not None else current["year"]

        dt, err = _to_datetime(new_day, new_month, new_year, new_hour, new_minute, new_ampm)
        if err:
            conn.close()
            raise ValueError(err)
        if dt <= datetime.datetime.now():
            conn.close()
            raise ValueError(f"That time ({dt.strftime('%d %b %Y, %I:%M %p')}) is in the past. Please choose a future date/time.")

        new_tone = current["tone"] if keep_tone else _safe_tone_filename(tone if tone is not None else current["tone"])

        conn.execute(
            """UPDATE reminders SET name=?, hour=?, minute=?, ampm=?, day=?, month=?, year=?, tone=?
               WHERE id=?""",
            (new_name, new_hour, new_minute, new_ampm, new_day, new_month, new_year, new_tone, reminder_id),
        )
        conn.commit()
        updated_row = conn.execute("SELECT * FROM reminders WHERE id = ?", (reminder_id,)).fetchone()
        conn.close()

    return _public_reminder(updated_row)


# ════════════════════════════════════════════════════════════════
#  3. DELETE REMINDER(S)  — one / multiple / all
# ════════════════════════════════════════════════════════════════

def api_delete_reminders(ids: list) -> int:
    """Delete any number of reminders by id. Returns how many were removed."""
    clean_ids = {int(i) for i in ids if str(i).lstrip("-").isdigit()}
    if not clean_ids:
        return 0

    with _lock:
        conn = get_conn()
        placeholders = ",".join("?" for _ in clean_ids)
        cur = conn.execute(f"DELETE FROM reminders WHERE id IN ({placeholders})", tuple(clean_ids))
        conn.commit()
        removed = cur.rowcount
        conn.close()

    return removed


def api_delete_all_reminders() -> int:
    with _lock:
        conn = get_conn()
        cur = conn.execute("DELETE FROM reminders")
        conn.commit()
        removed = cur.rowcount
        conn.close()
    return removed


# ════════════════════════════════════════════════════════════════
#  4. SHOW REMINDERS / UPCOMING
# ════════════════════════════════════════════════════════════════

def api_list_reminders() -> list:
    """Alias of api_get_reminders(), kept for readability in app.py."""
    return api_get_reminders()


def api_get_upcoming():
    """Return the single nearest reminder (soonest first, including any
    that are already due), or None if there are no reminders at all."""
    reminders = api_get_reminders()
    return reminders[0] if reminders else None


def api_fire_reminder(reminder_id) -> dict:
    """Called by the frontend the moment a reminder's full-screen alert
    has finished (after the 10-second cycle). Removes the reminder so it
    doesn't fire again, and returns its last known data (for logging)."""
    with _lock:
        conn = get_conn()
        row = conn.execute("SELECT * FROM reminders WHERE id = ?", (reminder_id,)).fetchone()
        if row is None:
            conn.close()
            return None
        data = _public_reminder(row)
        conn.execute("DELETE FROM reminders WHERE id = ?", (reminder_id,))
        conn.commit()
        conn.close()
    return data


if __name__ == "__main__":
    # Small manual smoke test when run directly (no CLI menu — this
    # module is driven entirely by the Flask web API now).
    init_db()
    print("S.N.E.T.C.H Reminder backend module.")
    print(f"Reminders on file: {len(api_get_reminders())}")
    print(f"Tones available: {[t['name'] for t in api_get_tone_list()]}")