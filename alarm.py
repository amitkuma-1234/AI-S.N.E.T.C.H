"""
S.N.E.T.C.H — ALARM MODULE (Type Input Version)
Supports: Set | Delete | Update | View alarms
Tones: alarm_tone/ folder
Data:  alarm.json
"""

import datetime, time, os, json, threading

from playsound import playsound
import yt_dlp

TONE_FOLDER = "alarm_tone"
ALARM_FILE  = "alarm.json"
os.makedirs(TONE_FOLDER, exist_ok=True)

# ════════════════════════════════════════════════════════════════
#  SPEAK & INPUT  (type karo)
# ════════════════════════════════════════════════════════════════

def speak(text: str):
    print(f"  [SNETCH] {text}")

def listen(prompt: str = "") -> str:
    if prompt:
        print(f"\n  {prompt}")
    try:
        return input("  >> ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        return ""


# ════════════════════════════════════════════════════════════════
#  ALARM JSON
# ════════════════════════════════════════════════════════════════

def load_alarms() -> list:
    if not os.path.exists(ALARM_FILE):
        return []
    try:
        with open(ALARM_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict) and "time" in data:
            if data.get("time"):
                return [{"id":1,"time":data["time"],"tone":data.get("ringtone",""),"active":True}]
            return []
        return data if isinstance(data, list) else []
    except Exception:
        return []

def save_alarms(alarms: list):
    with open(ALARM_FILE, "w") as f:
        json.dump(alarms, f, indent=4)

def next_id(alarms: list) -> int:
    return max((a["id"] for a in alarms), default=0) + 1


# ════════════════════════════════════════════════════════════════
#  TONE HELPERS
# ════════════════════════════════════════════════════════════════

def get_tones() -> list:
    return [f for f in os.listdir(TONE_FOLDER) if f.lower().endswith(".mp3")]

def show_tones() -> list:
    tones = get_tones()
    print(f"\n  {'#':<5} {'Tone Name'}")
    print(f"  {'-'*5} {'-'*40}")
    if not tones:
        print("  (no tones in alarm_tone/ folder)")
    for i, t in enumerate(tones, 1):
        print(f"  {i:<5} {t.replace('.mp3','')}")
    print()
    return tones

def select_tone() -> str:
    tones = show_tones()
    if not tones:
        ans = listen("No tones found. Type 'download' to add one, or 'skip':")
        if "download" in ans:
            return download_tone()
        return ""

    print("  Type tone number | 'download' | 'skip'")
    while True:
        choice = listen("Select tone:")
        if not choice:
            continue
        if "skip" in choice:
            return ""
        if "download" in choice:
            return download_tone()
        if choice.isdigit() and 1 <= int(choice) <= len(tones):
            selected = tones[int(choice)-1]
            speak(f"Tone selected: {selected.replace('.mp3','')}")
            return os.path.join(TONE_FOLDER, selected)
        print(f"  Enter 1 to {len(tones)}, 'download', or 'skip'.")

def download_tone() -> str:
    song = listen("Enter ringtone name:")
    if not song:
        return ""
    speak(f"Downloading {song}...")
    try:
        out_path = os.path.join(TONE_FOLDER, song)
        ydl_opts = {
            "format": "bestaudio/best", "noplaylist": True, "quiet": True,
            "outtmpl": f"{out_path}.%(ext)s",
            "postprocessors": [{"key":"FFmpegExtractAudio","preferredcodec":"mp3","preferredquality":"192"}],
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.extract_info(f"ytsearch1:{song}", download=True)
        full_path = os.path.join(TONE_FOLDER, f"{song}.mp3")
        speak(f"Downloaded: {song}")
        return full_path
    except Exception as e:
        print(f"  Download error: {e}")
        return ""


# ════════════════════════════════════════════════════════════════
#  TIME INPUT
# ════════════════════════════════════════════════════════════════

def get_alarm_time() -> str:
    print("\n  Enter alarm time:")
    print("  Examples: 730 = 7:30 AM | 1430 = 2:30 PM | 0800 = 8:00 AM")
    while True:
        raw = listen("Time (HHMM):")
        digits = "".join(filter(str.isdigit, raw))
        if len(digits) == 4:
            h, m = int(digits[:2]), int(digits[2:])
        elif len(digits) == 3:
            h, m = int(digits[0]),  int(digits[1:])
        elif len(digits) <= 2:
            h, m = int(digits) if digits else 0, 0
        else:
            print("  Invalid. Try again.")
            continue
        if 0 <= h <= 23 and 0 <= m <= 59:
            t = f"{h:02}:{m:02}"
            speak(f"Alarm time: {t}")
            return t
        print("  Invalid time. Try again.")


# ════════════════════════════════════════════════════════════════
#  DISPLAY TABLE
# ════════════════════════════════════════════════════════════════

def show_alarms_table(alarms: list, title: str = "Alarm Schedule"):
    print(f"\n  ╔══ {title} {'═'*(42-len(title))}╗")
    print(f"  {'#':<5} {'Time':<10} {'Tone':<30} {'Status'}")
    print(f"  {'-'*5} {'-'*10} {'-'*30} {'-'*10}")
    if not alarms:
        print("  (no alarms)")
    for i, a in enumerate(alarms, 1):
        tone   = os.path.basename(a.get("tone","")).replace(".mp3","") or "Default"
        status = "Active" if a.get("active") else "Off"
        print(f"  {i:<5} {a['time']:<10} {tone:<30} {status}")
    print(f"  {'═'*60}╝\n")


# ════════════════════════════════════════════════════════════════
#  SELECT ALARM(S)
# ════════════════════════════════════════════════════════════════

def select_alarms(alarms: list, multi: bool = False) -> list:
    show_alarms_table(alarms)
    if not alarms:
        return []

    if multi:
        print("  Type: number | '1 2 3' | 'all' | 'cancel'")
    else:
        print("  Type: number | 'cancel'")

    while True:
        choice = listen("Your selection:")
        if not choice or "cancel" in choice or "back" in choice:
            speak("Cancelled.")
            return []
        if "all" in choice and multi:
            return alarms[:]

        import re
        nums  = [int(n) for n in re.findall(r'\d+', choice)]
        valid = [n for n in nums if 1 <= n <= len(alarms)]
        if not valid:
            print(f"  Enter 1 to {len(alarms)}.")
            continue
        if not multi:
            return [alarms[valid[0]-1]]
        return [alarms[n-1] for n in valid]


# ════════════════════════════════════════════════════════════════
#  1. SET ALARM
# ════════════════════════════════════════════════════════════════

def set_alarm_flow():
    speak("Setting a new alarm.")
    alarm_time = get_alarm_time()
    print("\n  Select alarm tone:")
    tone   = select_tone()
    alarms = load_alarms()
    new_alarm = {"id": next_id(alarms), "time": alarm_time, "tone": tone, "active": True}
    alarms.append(new_alarm)
    save_alarms(alarms)
    tone_name = os.path.basename(tone).replace(".mp3","") if tone else "Default"
    speak(f"Alarm set for {alarm_time} with tone {tone_name}.")
    print(f"  Alarm #{new_alarm['id']} saved.")
    threading.Thread(target=monitor_alarm, args=(new_alarm,), daemon=True).start()


# ════════════════════════════════════════════════════════════════
#  2. DELETE ALARM
# ════════════════════════════════════════════════════════════════

def delete_alarm_flow():
    alarms = load_alarms()
    if not alarms:
        speak("No alarms to delete.")
        return
    speak("Which alarm do you want to delete?")
    selected = select_alarms(alarms, multi=True)
    if not selected:
        return
    ids_to_del = {a["id"] for a in selected}
    remaining  = [a for a in alarms if a["id"] not in ids_to_del]
    save_alarms(remaining)
    speak(f"Deleted {len(selected)} alarm(s).")
    show_alarms_table(remaining, "Remaining Alarms")


# ════════════════════════════════════════════════════════════════
#  3. UPDATE ALARM
# ════════════════════════════════════════════════════════════════

def update_alarm_flow():
    alarms = load_alarms()
    if not alarms:
        speak("No alarms to update.")
        return
    speak("Which alarm do you want to update?")
    selected = select_alarms(alarms, multi=False)
    if not selected:
        return
    alarm = selected[0]
    idx   = next(i for i, a in enumerate(alarms) if a["id"] == alarm["id"])
    print(f"\n  Current → Time: {alarm['time']} | Tone: {os.path.basename(alarm.get('tone','')) or 'Default'}")

    # Update time
    new_time = get_alarm_time()
    alarms[idx]["time"] = new_time

    # Update tone?
    ans = listen("Update tone too? (yes / no):")
    if "yes" in ans or "y" == ans:
        print("\n  Select new tone:")
        new_tone = select_tone()
        if new_tone:
            alarms[idx]["tone"] = new_tone
            speak(f"Tone updated to {os.path.basename(new_tone).replace('.mp3','')}")

    save_alarms(alarms)
    speak(f"Alarm updated to {new_time}.")
    show_alarms_table(alarms)


# ════════════════════════════════════════════════════════════════
#  4. VIEW ALARMS
# ════════════════════════════════════════════════════════════════

def view_alarms_flow():
    alarms = load_alarms()
    show_alarms_table(alarms, "All Alarms")
    if not alarms:
        speak("No alarms scheduled.")
    else:
        speak(f"You have {len(alarms)} alarm(s).")


# ════════════════════════════════════════════════════════════════
#  ALARM MONITOR
#
#  TIMING FIX (was firing ~15s late):
#  The old monitor compared `now.strftime("%H:%M") == alarm["time"]` once
#  per second. That has two problems:
#    1. Up to ~1s of slop even in the best case, plus whatever the OS/GIL
#       scheduler adds if the thread wakes up late.
#    2. If the thread is ever starved past the target minute (busy
#       process, laptop sleep/idle, etc.) the exact-string match is
#       simply never true again that day — the alarm silently never
#       rings until the next day.
#
#  Fix: compute the exact target datetime (epoch seconds) and always
#  compare "have we reached or passed it yet" instead of "does this
#  instant exactly equal it". Sleep in short, re-checked slices that get
#  finer as the target approaches (down to 50ms) instead of one coarse
#  1s poll, so the trigger fires within ~50ms of the scheduled time
#  instead of up to ~1s+ late — and still fires immediately even after
#  a long idle/suspend period, because the check is "now >= target",
#  not "now == target".
#
#  Timezone handling: both this scheduler and the browser countdown use
#  local wall-clock time (Python's datetime.now() / JS's `new Date()`),
#  so there is no UTC/local mismatch between frontend and backend.
# ════════════════════════════════════════════════════════════════

alarm_stop_event = threading.Event()


def _next_trigger_datetime(hhmm: str, now: datetime.datetime = None) -> datetime.datetime:
    """Return the next local datetime (today or tomorrow) at which an
    alarm scheduled for `hhmm` ("HH:MM", 24h) should ring."""
    now = now or datetime.datetime.now()
    h, m = map(int, hhmm.split(":"))
    target = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if target <= now:
        target += datetime.timedelta(days=1)
    return target

# The alarm that is *currently* ringing (None when nothing is ringing).
# Read by the web API (/api/alarms/ringing) so the frontend knows when to
# pop up the full-screen ringing UI, and written only from monitor_alarm().
_ringing_lock = threading.Lock()
current_ringing_alarm = None

def get_ringing_alarm():
    """Thread-safe read of whichever alarm is currently ringing (or None)."""
    with _ringing_lock:
        return dict(current_ringing_alarm) if current_ringing_alarm else None

def api_stop_ringing():
    """Web API version of typing 'stop': silences whichever alarm is
    currently ringing. Safe to call even if nothing is ringing."""
    global current_ringing_alarm
    alarm_stop_event.set()
    with _ringing_lock:
        current_ringing_alarm = None
    return True

def play_tone_loop(tone_path):
    """Play alarm tone in a loop until alarm_stop_event is set."""
    try:
        import pygame
        pygame.mixer.init()
        pygame.mixer.music.load(tone_path)
        pygame.mixer.music.play(-1)  # -1 = loop forever
        while not alarm_stop_event.is_set():
            time.sleep(0.3)
        pygame.mixer.music.stop()
        pygame.mixer.quit()
    except ImportError:
        # Fallback: play once with playsound (won't be stoppable mid-play)
        try:
            playsound(tone_path)
        except Exception:
            pass
    except Exception as e:
        print(f"  [Tone Error] {e}")

def monitor_alarm(alarm: dict):
    """Wait for `alarm`'s scheduled time, using a drift-free, wall-clock
    based scheduler (see comments above), then ring it.

    Re-reads the alarm from disk each wait cycle so edits/deletes made via
    Update/Delete Alarm while this thread is waiting take effect without
    needing a server restart.
    """
    global current_ringing_alarm
    alarm_id = alarm.get("id")

    while True:
        fresh = load_alarms()
        live = next((a for a in fresh if a["id"] == alarm_id), None)
        if live is None or not live.get("active"):
            return  # deleted, or turned off — nothing left to monitor

        target_epoch = _next_trigger_datetime(live["time"]).timestamp()

        # Wait until target_epoch, re-checking wall-clock time (never
        # accumulated sleep durations) so we can't drift, and re-checking
        # the alarm's live state every ~1s so edits/deletes are honored.
        while True:
            now_epoch = time.time()
            remaining = target_epoch - now_epoch
            if remaining <= 0:
                break
            if remaining > 1:
                time.sleep(1)
            elif remaining > 0.05:
                time.sleep(0.05)   # fine-grained final approach — no noticeable delay
            else:
                time.sleep(remaining)
                break

            fresh = load_alarms()
            still = next((a for a in fresh if a["id"] == alarm_id), None)
            if still is None or not still.get("active"):
                return
            if still.get("time") != live.get("time"):
                live = still  # time was edited mid-wait — recompute target
                target_epoch = _next_trigger_datetime(live["time"]).timestamp()

        # ---- FIRE (right on time, whether reached naturally or after an
        #      idle period that put us past the target instantly) ----
        print(f"\n  ⏰ ALARM! Time: {live['time']}")
        speak("Wake up! Alarm ringing!")

        # Mark this alarm as the one currently ringing, so the web UI's
        # /api/alarms/ringing poll picks it up and shows the full-screen
        # cinematic Alarm Experience (alarm.html) until it's dismissed.
        with _ringing_lock:
            current_ringing_alarm = {
                "id": live.get("id"),
                "time": live["time"],
                "label": live.get("label", "Alarm"),
                "tone": live.get("tone", ""),
            }

        # Start tone
        alarm_stop_event.clear()
        tone = live.get("tone", "")
        if tone and os.path.exists(tone):
            pass # threading.Thread(target=play_tone_loop, args=(tone,), daemon=True).start()

        # Wait for stop command
        speak("Type 'stop' to turn off the alarm.")
        while not alarm_stop_event.is_set():
            time.sleep(0.2)

        with _ringing_lock:
            current_ringing_alarm = None

        # Persist the deactivation immediately (previously only mutated
        # the in-memory dict, so the UI could show "Active" again until
        # a server restart even though the alarm had already fired).
        after = load_alarms()
        for a in after:
            if a["id"] == alarm_id:
                a["active"] = False
        save_alarms(after)

        speak("Alarm stopped.")
        print("  Alarm stopped successfully.")
        return

def start_all_alarms():
    alarms = load_alarms()
    for alarm in alarms:
        if alarm.get("active"):
            threading.Thread(target=monitor_alarm, args=(alarm,), daemon=True).start()
    if alarms:
        print(f"  [Alarm] {len(alarms)} alarm(s) active.")


# ════════════════════════════════════════════════════════════════
#  WEB API WRAPPERS (used by app.py's /api/alarms + /api/tones routes)
#  These are thin, non-interactive wrappers around the existing
#  load_alarms/save_alarms/get_tones logic above — no CLI flow is
#  changed, this just exposes the same data to the Flask API.
# ════════════════════════════════════════════════════════════════

def api_get_alarms() -> list:
    """Return all alarms, each with a 'label' field (defaults to 'Alarm'
    for older entries saved before labels existed)."""
    alarms = load_alarms()
    for a in alarms:
        a.setdefault("label", "Alarm")
    return alarms


def api_create_alarm(time_24h: str, tone: str = "default", label: str = "Alarm") -> dict:
    """Create a new alarm from the web UI and start monitoring it."""
    alarms = load_alarms()
    tone_path = ""
    if tone and tone != "default":
        candidate = tone if os.path.isabs(tone) or tone.startswith(TONE_FOLDER) else os.path.join(TONE_FOLDER, tone)
        if os.path.exists(candidate):
            tone_path = candidate

    new_alarm = {
        "id": next_id(alarms),
        "time": time_24h,
        "tone": tone_path,
        "label": label or "Alarm",
        "active": True,
    }
    alarms.append(new_alarm)
    save_alarms(alarms)
    threading.Thread(target=monitor_alarm, args=(new_alarm,), daemon=True).start()
    return new_alarm


def api_update_alarm(alarm_id: int, **fields):
    """Update an existing alarm's time/tone/label. Returns the updated
    alarm dict, or None if no alarm with that ID exists."""
    alarms = load_alarms()
    idx = next((i for i, a in enumerate(alarms) if a["id"] == alarm_id), None)
    if idx is None:
        return None

    if "time" in fields:
        alarms[idx]["time"] = fields["time"]
    if "tone" in fields:
        tone = fields["tone"]
        if not tone or tone == "default":
            alarms[idx]["tone"] = ""
        else:
            candidate = tone if os.path.isabs(tone) or tone.startswith(TONE_FOLDER) else os.path.join(TONE_FOLDER, tone)
            alarms[idx]["tone"] = candidate if os.path.exists(candidate) else alarms[idx].get("tone", "")
    if "label" in fields:
        alarms[idx]["label"] = fields["label"]

    save_alarms(alarms)
    return alarms[idx]


def api_delete_alarm(alarm_id: int) -> bool:
    """Delete an alarm by ID. Returns True if something was deleted."""
    alarms = load_alarms()
    remaining = [a for a in alarms if a["id"] != alarm_id]
    if len(remaining) == len(alarms):
        return False
    save_alarms(remaining)
    return True


def api_get_tone_list() -> list:
    """Return available tone names for the web UI, always including
    'default' as the first option."""
    return ["default"] + get_tones()


# Path to an exported YouTube cookies.txt file (Netscape format), used
# to make server-side downloads look like a logged-in browser instead
# of an anonymous bot — this is what actually gets around YouTube's
# "Sign in to confirm you're not a bot" wall on data-center IPs.
# Set this env var on the server, or drop the file at this default path.
_ALARM_DIR = BASE_DIR if 'BASE_DIR' in dir() else os.path.dirname(os.path.abspath(__file__))


def _resolve_cookies_file() -> str:
    """Find the youtube cookies file even if it was exported with a
    different filename than expected. Browser extensions like
    "Get cookies.txt LOCALLY" save it as 'www.youtube.com_cookies.txt'
    by default, not 'youtube_cookies.txt' — a mismatch here causes
    os.path.exists() to silently fail and cookies get skipped
    entirely, so every download looks like an anonymous bot request.
    Checks (in order): explicit env var -> 'youtube_cookies.txt' ->
    'www.youtube.com_cookies.txt' -> any '*cookies*.txt' in this folder."""
    env_path = os.getenv("YTDLP_COOKIES_FILE")
    if env_path and os.path.exists(env_path):
        return env_path

    for candidate in ("youtube_cookies.txt", "www.youtube.com_cookies.txt"):
        p = os.path.join(_ALARM_DIR, candidate)
        if os.path.exists(p):
            return p

    try:
        for fname in os.listdir(_ALARM_DIR):
            if "cookies" in fname.lower() and fname.lower().endswith(".txt"):
                return os.path.join(_ALARM_DIR, fname)
    except OSError:
        pass

    # Nothing found — return the originally-expected default path so
    # existing behavior (and the error message below) stays predictable.
    return os.path.join(_ALARM_DIR, "youtube_cookies.txt")


YTDLP_COOKIES_FILE = _resolve_cookies_file()


def download_tone_by_name(name: str) -> dict:
    """Non-interactive version of download_tone() for the web API —
    downloads `name` from YouTube audio into TONE_FOLDER as an mp3.
    Returns {"ok": bool, "error": str|None} so the real failure reason
    can be surfaced to the UI instead of a generic message."""
    if not name:
        return {"ok": False, "error": "Tone name is required."}
    try:
        out_path = os.path.join(TONE_FOLDER, name)
        import shutil, platform
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            # Only fall back to a hardcoded Windows path on Windows itself.
            # Falling back to it unconditionally silently breaks
            # ffmpeg_location on Linux servers even when ffmpeg is
            # correctly installed but just not resolved here.
            ffmpeg_path = r"C:\ffmpeg-7.1.1\bin" if platform.system() == "Windows" else None
        ydl_opts = {
            "format": "bestaudio/best", "noplaylist": True, "quiet": True,
            "no_warnings": True,
            "outtmpl": f"{out_path}.%(ext)s",
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}],
            "extractor_args": {"youtube": {"player_client": ["android", "web", "ios", "tv"]}},
        }
        if ffmpeg_path:
            ydl_opts["ffmpeg_location"] = ffmpeg_path
        if os.path.exists(YTDLP_COOKIES_FILE):
            ydl_opts["cookiefile"] = YTDLP_COOKIES_FILE
        else:
            print(f"  [Tone Download] No cookies file found (looked for one in {_ALARM_DIR}) — download will likely be blocked as a bot.")

        # Not every YouTube result for a given search allows this kind
        # of server-side download — some are blocked by extra
        # verification checks regardless of cookies. Rather than only
        # trying the single top result (which fails the whole request
        # if that one video happens to be restricted), pull several
        # candidates and use the first one that actually works.
        last_error = None
        with yt_dlp.YoutubeDL({**ydl_opts, "extract_flat": "in_playlist", "quiet": True}) as search_ydl:
            search_result = search_ydl.extract_info(f"ytsearch5:{name}", download=False)
        candidates = (search_result or {}).get("entries") or []
        if not candidates:
            return {"ok": False, "error": "No results found for that search."}

        for entry in candidates:
            video_url = entry.get("url") or entry.get("webpage_url") or entry.get("id")
            if not video_url:
                continue
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    ydl.extract_info(video_url, download=True)
                if os.path.exists(f"{out_path}.mp3"):
                    return {"ok": True, "error": None}
            except Exception as e:
                last_error = e
                print(f"  [Tone Download] Candidate '{video_url}' failed, trying next: {e}")
                continue

        raise last_error or RuntimeError("File did not save after download.")
    except Exception as e:
        print(f"  [Tone Download Error] {e}")
        error_msg = str(e)
        if "Sign in to confirm" in error_msg or "not a bot" in error_msg:
            error_msg = (
                "YouTube is blocking this server's IP as a bot. Upload a valid "
                "youtube_cookies.txt (exported from a logged-in browser) to the "
                "server, or set the YTDLP_COOKIES_FILE env var to its path."
            )
        return {"ok": False, "error": error_msg}


# ════════════════════════════════════════════════════════════════
#  MAIN DISPATCHER
# ════════════════════════════════════════════════════════════════

def alaram(action: str):
    action = action.lower()
    if any(w in action for w in ["stop", "off", "band", "ruk", "bas"]):
        alarm_stop_event.set()
        return
    if any(w in action for w in ["set","add","new","create"]):
        set_alarm_flow()
    elif any(w in action for w in ["delete","remove","cancel"]):
        delete_alarm_flow()
    elif any(w in action for w in ["update","change","edit"]):
        update_alarm_flow()
    elif any(w in action for w in ["show","view","list","schedule"]):
        view_alarms_flow()
    else:
        print("\n  Commands: set | delete | update | show | stop")
        choice = listen("What to do with alarm?")
        if choice:
            alaram(choice)


if __name__ == "__main__":
    start_all_alarms()
    print("Commands: set | delete | update | show | exit")
    while True:
        try:
            cmd = input("\n> ").strip()
            if cmd.lower() in ("exit","quit"): break
            alaram(cmd)
        except KeyboardInterrupt:
            break