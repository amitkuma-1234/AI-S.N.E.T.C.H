"""
S.N.E.T.C.H — DAILY TASK MODULE (Web Edition)
Set | Update | Delete | List tasks, each with its own task-tone playlist.

Data:  daily_routine.json   (list of task dicts)
Tones: task_tone/           (downloaded / stored .mp3 tone files)

This module is the backend for the Daily Task Manager web feature. It is
imported by app.py and exposes small, non-interactive "api_*" functions
that the Flask routes call directly — mirroring the same pattern used by
alarm.py for its tones/alarms API.

TASK TONE PLAYLIST
------------------
Each task now stores an ORDERED list of tone filenames ("tones") instead
of a single tone. When the task is running, the frontend plays them back
Song1 -> Song2 -> Song3 -> ... -> repeat, in exactly the order the user
picked them in — never shuffled. If the user chose "Skip", the task's
"skip" flag is set and "tones" is forced empty: no background music plays
for that task at all.

FIRE ALARM (TASK START / END WARNING)
--------------------------------------
task_tone/fire_alarm.mp3 is a reserved system warning tone. It must NEVER
appear in the Task Tone List and must NEVER be selectable by the user as
a task tone. It is deliberately excluded from get_task_tones() /
api_get_tone_list() and from every validated tone list. It is only
exposed through the dedicated api_get_fire_alarm() function, which the
frontend uses to play it for exactly 2 seconds before a task starts and
exactly 2 seconds before a task ends.
"""

import base64
import json
import mimetypes
import os
import re
import threading
from datetime import datetime

# ════════════════════════════════════════════════════════════════
#  PATHS
# ════════════════════════════════════════════════════════════════

ROUTINE_FILE = "daily_routine.json"
TONE_FOLDER = "task_tone"

# Reserved Task Start/End Warning tone. Hidden from the Task Tone List and
# can never be selected/stored as a task's playlist tone.
FIRE_ALARM_FILENAME = "fire_alarm.mp3"

os.makedirs(TONE_FOLDER, exist_ok=True)

_routine_lock = threading.Lock()

VALID_TONE_EXTS = (".mp3", ".wav", ".ogg", ".m4a")
NAME_SAFE_RE = re.compile(r'[\\/*?:"<>|]')


# ════════════════════════════════════════════════════════════════
#  JSON STORAGE HELPERS
# ════════════════════════════════════════════════════════════════

def load_routine() -> list:
    """Read every saved task from disk. Always returns a list."""
    try:
        with open(ROUTINE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_routine(routine: list) -> None:
    with open(ROUTINE_FILE, "w", encoding="utf-8") as f:
        json.dump(routine, f, indent=4)


def next_id(routine: list) -> int:
    return max((t.get("id", 0) for t in routine), default=0) + 1


def _norm_time(value: str) -> str:
    """Accept 'HH:MM' or 'HH:MM:SS' and normalize to 'HH:MM'."""
    if not value:
        return ""
    return str(value).strip()[:5]


def _is_fire_alarm(filename: str) -> bool:
    return bool(filename) and filename.lower() == FIRE_ALARM_FILENAME.lower()


# ════════════════════════════════════════════════════════════════
#  TONE HELPERS  (task_tone/ folder)
# ════════════════════════════════════════════════════════════════

def get_task_tones() -> list:
    """List every tone file currently stored in task_tone/ that the user
    is allowed to pick as a task tone. fire_alarm.mp3 is a reserved
    system warning tone and is always excluded — it must never appear
    in the Task Tone List."""
    if not os.path.isdir(TONE_FOLDER):
        return []
    return sorted(
        f for f in os.listdir(TONE_FOLDER)
        if f.lower().endswith(VALID_TONE_EXTS) and not _is_fire_alarm(f)
    )


def _file_data_uri(folder: str, filename: str) -> str:
    """Read a file and return it as a base64 data URI so the browser can
    play it with a plain <audio> element / Audio() object — no dedicated
    file-serving route is needed (this module cannot register Flask
    routes of its own; app.py only calls these api_* functions and
    forwards whatever they return as JSON)."""
    if not filename:
        return ""
    path = os.path.join(folder, filename)
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


def _tone_data_uri(filename: str) -> str:
    return _file_data_uri(TONE_FOLDER, filename)


def api_get_tone_list() -> list:
    """
    Web API: return every selectable stored task tone with its display
    name and its audio data (base64 data URI). fire_alarm.mp3 is never
    included here. The Task Tone List picker in the Set/Update Task
    wizard uses the filename + name fields, and the Task Execution
    Engine plays the selected playlist client-side using this data.
    """
    return [
        {
            "filename": f,
            "name": os.path.splitext(f)[0],
            "data": _tone_data_uri(f),
        }
        for f in get_task_tones()
    ]


def api_get_fire_alarm() -> dict:
    """
    Web API: return the reserved Task Start/End Warning tone
    (task_tone/fire_alarm.mp3) as a base64 data URI. This is fetched
    separately from api_get_tone_list() and is never offered as a
    selectable task tone. The frontend plays it for exactly 2 seconds
    before a task starts and exactly 2 seconds before a task ends.
    """
    path = os.path.join(TONE_FOLDER, FIRE_ALARM_FILENAME)
    if not os.path.exists(path):
        return {"ok": False, "filename": FIRE_ALARM_FILENAME, "data": "", "error": "fire_alarm.mp3 not found."}
    data = _file_data_uri(TONE_FOLDER, FIRE_ALARM_FILENAME)
    if not data:
        return {"ok": False, "filename": FIRE_ALARM_FILENAME, "data": "", "error": "Could not read fire_alarm.mp3."}
    return {"ok": True, "filename": FIRE_ALARM_FILENAME, "data": data, "error": None}


def _safe_tone_filename(tone: str) -> str:
    """Given a filename or a 'default'/empty value, resolve it to a
    filename that actually exists inside task_tone/, else ''. The
    reserved fire_alarm.mp3 can never be resolved here — it is never a
    valid task tone selection."""
    if not tone or tone.lower() == "default":
        return ""
    base = os.path.basename(tone)
    if _is_fire_alarm(base):
        return ""
    if os.path.exists(os.path.join(TONE_FOLDER, base)):
        return base
    return ""


def _safe_tone_list(tones) -> list:
    """Validate an ordered list of tone filenames for a task's playback
    playlist. Keeps the user's exact order, drops anything that doesn't
    exist in task_tone/, and always drops the reserved fire_alarm.mp3.
    Duplicate filenames are collapsed (keeping the first occurrence)
    since the picker only lets a song be selected once."""
    if not tones:
        return []
    seen = set()
    ordered = []
    for t in tones:
        safe = _safe_tone_filename(t)
        if safe and safe not in seen:
            seen.add(safe)
            ordered.append(safe)
    return ordered


_DT_DIR = os.path.dirname(os.path.abspath(__file__))


def _resolve_cookies_file() -> str:
    """Find the youtube cookies file — checks env var, then common
    filenames, then any '*cookies*.txt' in the project folder."""
    env_path = os.getenv("YTDLP_COOKIES_FILE")
    if env_path and os.path.exists(env_path):
        return env_path
    for candidate in ("www.youtube.com_cookies.txt", "youtube_cookies.txt"):
        p = os.path.join(_DT_DIR, candidate)
        if os.path.exists(p):
            return p
    try:
        for fname in os.listdir(_DT_DIR):
            if "cookies" in fname.lower() and fname.lower().endswith(".txt"):
                return os.path.join(_DT_DIR, fname)
    except OSError:
        pass
    return os.path.join(_DT_DIR, "youtube_cookies.txt")


YTDLP_COOKIES_FILE = _resolve_cookies_file()


def download_tone_by_name(name: str) -> dict:
    """
    Non-interactive tone download for the web API.
    Downloads `name` as an mp3 into task_tone/ using yt-dlp and returns
    {"ok": bool, "filename": str, "error": str|None}.

    IMPORTANT (per feature spec): this call BLOCKS until the download
    has fully completed and the file is confirmed to exist inside
    task_tone/. The frontend keeps its Save button disabled for the
    entire duration of this request, and only enables it once this
    function returns ok=True.
    """
    name = (name or "").strip()
    if not name:
        return {"ok": False, "filename": "", "error": "Tone name is required."}

    safe_name = NAME_SAFE_RE.sub("", name).strip() or "task_tone"

    # fire_alarm is a reserved system filename and can never be
    # (re)created / overwritten through the download flow.
    if safe_name.lower() == os.path.splitext(FIRE_ALARM_FILENAME)[0].lower():
        return {"ok": False, "filename": "", "error": "That name is reserved and cannot be used."}

    try:
        import yt_dlp
    except ImportError:
        return {"ok": False, "filename": "", "error": "yt-dlp is not installed on the server."}

    os.makedirs(TONE_FOLDER, exist_ok=True)
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
    if os.path.exists(YTDLP_COOKIES_FILE):
        ydl_opts["cookiefile"] = YTDLP_COOKIES_FILE

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.extract_info(f"ytsearch1:{safe_name}", download=True)
    except Exception as e:
        return {"ok": False, "filename": "", "error": f"Download failed: {e}"}

    final_file = f"{safe_name}.mp3"
    final_path = os.path.join(TONE_FOLDER, final_file)

    # Only report success once the file is truly present in task_tone/.
    if os.path.exists(final_path) and os.path.getsize(final_path) > 0:
        return {"ok": True, "filename": final_file, "error": None}

    return {"ok": False, "filename": "", "error": "Tone did not save correctly. Please try again."}


# ════════════════════════════════════════════════════════════════
#  PUBLIC SHAPE  (what the frontend receives per task)
# ════════════════════════════════════════════════════════════════

def _public_task(t: dict) -> dict:
    tones = _safe_tone_list(t.get("tones") or [])
    skip = bool(t.get("skip", False))
    tone_names = [os.path.splitext(os.path.basename(f))[0] for f in tones]

    if skip:
        tone_summary = "Skip (No Music)"
    elif tone_names:
        tone_summary = " → ".join(tone_names)
    else:
        tone_summary = "No Tone Selected"

    return {
        "id": t.get("id"),
        "task_name": t.get("task_name", ""),
        "start": t.get("start", ""),
        "end": t.get("end", ""),
        "tones": tones,
        "tone_names": tone_names,
        "skip": skip,
        # Backward-compatible summary field for any display code that
        # just wants one string to show.
        "tone_name": tone_summary,
        "created": t.get("created", ""),
    }


# ════════════════════════════════════════════════════════════════
#  1. SET TASK  (create)
# ════════════════════════════════════════════════════════════════

def api_get_tasks() -> list:
    """Return every saved task (sorted by Start Time), web-shaped."""
    with _routine_lock:
        routine = load_routine()
    ordered = sorted(routine, key=lambda t: t.get("start", ""))
    return [_public_task(t) for t in ordered]


def api_create_task(task_name: str, start: str, end: str, tones=None, skip: bool = False) -> dict:
    """
    Create a new task.
    tones: ordered list of filenames inside task_tone/ (as returned by
    api_get_tone_list()), forming the Song1 -> Song2 -> ... playback
    playlist for this task. fire_alarm.mp3 can never be part of this
    list — it is filtered out even if somehow passed in.
    skip: True means "Skip" was chosen — no background task music plays
    at all, and `tones` is forced empty regardless of what was passed.
    """
    task_name = (task_name or "").strip()
    if not task_name:
        raise ValueError("Task name is required.")

    skip = bool(skip)
    safe_tones = [] if skip else _safe_tone_list(tones)

    if not skip and not safe_tones:
        raise ValueError("Select at least one task tone, or choose Skip.")

    with _routine_lock:
        routine = load_routine()
        task = {
            "id": next_id(routine),
            "task_name": task_name,
            "start": _norm_time(start),
            "end": _norm_time(end),
            "tones": safe_tones,
            "skip": skip,
            "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        routine.append(task)
        save_routine(routine)

    return _public_task(task)


# ════════════════════════════════════════════════════════════════
#  2. UPDATE TASK
# ════════════════════════════════════════════════════════════════

def api_update_task(task_id: int, task_name: str = None, start: str = None,
                     end: str = None, tones=None, keep_tone: bool = False,
                     skip: bool = False) -> dict:
    """
    Update an existing task.
    - task_name / start / end: overwrite if provided (not None).
    - tones: overwrite with a newly selected ordered playlist of
      filenames (Song1 -> Song2 -> ...).
    - skip=True (Skip during update): the playlist is cleared and no
      background task music plays.
    - keep_tone=True ("leave the playlist untouched"): tones/skip are
      left completely untouched, regardless of whatever is passed in.
    Returns the updated task dict, or None if task_id doesn't exist.
    """
    with _routine_lock:
        routine = load_routine()
        idx = next((i for i, t in enumerate(routine) if t.get("id") == task_id), None)
        if idx is None:
            return None

        if task_name is not None and task_name.strip():
            routine[idx]["task_name"] = task_name.strip()
        if start is not None:
            routine[idx]["start"] = _norm_time(start)
        if end is not None:
            routine[idx]["end"] = _norm_time(end)

        if not keep_tone:
            if skip:
                routine[idx]["tones"] = []
                routine[idx]["skip"] = True
            elif tones is not None:
                routine[idx]["tones"] = _safe_tone_list(tones)
                routine[idx]["skip"] = False
        # keep_tone=True -> leave routine[idx]["tones"] / ["skip"] exactly as-is

        save_routine(routine)
        updated = routine[idx]

    return _public_task(updated)


# ════════════════════════════════════════════════════════════════
#  3. DELETE TASK(S)
# ════════════════════════════════════════════════════════════════

def api_delete_tasks(ids: list) -> int:
    """Delete any number of tasks by id. Returns how many were removed."""
    ids = {int(i) for i in ids if str(i).lstrip("-").isdigit()}
    if not ids:
        return 0

    with _routine_lock:
        routine = load_routine()
        remaining = [t for t in routine if t.get("id") not in ids]
        removed = len(routine) - len(remaining)
        save_routine(remaining)

    return removed


# ════════════════════════════════════════════════════════════════
#  4. LIST TASKS
# ════════════════════════════════════════════════════════════════

def api_list_tasks() -> list:
    """Alias of api_get_tasks(), kept for readability in app.py."""
    return api_get_tasks()


if __name__ == "__main__":
    # Small manual smoke test when run directly (no CLI menu — this
    # module is driven entirely by the Flask web API now).
    print("S.N.E.T.C.H Daily Task backend module.")
    print(f"Tasks on file: {len(api_get_tasks())}")
    print(f"Tones available: {api_get_tone_list()}")
    print(f"Fire alarm present: {api_get_fire_alarm()['ok']}")