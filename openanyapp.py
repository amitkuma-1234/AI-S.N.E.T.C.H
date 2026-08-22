"""
openanyapp.py - "Launch Apps" feature backend for S.N.E.T.C.H
================================================================

Given text typed or spoken by the user (e.g. "chrome", "open vs code",
"task manager"), this module finds the best matching application that
is installed on the current Windows machine and launches it.

Public API used by app.py:

    decide_match(query) -> dict
        Looks the query up against the local app index and returns one of:
          {"status": "single",   "match": {...}}
          {"status": "multiple", "matches": [{...}, ...]}
          {"status": "not_found", "message": "..."}

    launch_app(path) -> dict
        Launches the given path/command/URI. Returns:
          {"success": True/False, "message": "..."}

Everything else in this file is implementation detail (Start Menu
shortcut scanning, registry lookups, fuzzy matching, etc).
"""

import os
import re
import subprocess

# --- optional fuzzy matching (already a project dependency, see
#     filesystem.py / requirements.txt) -----------------------------------
try:
    from rapidfuzz import fuzz
    FUZZY_OK = True
except ImportError:
    FUZZY_OK = False
    print("[INFO] rapidfuzz not installed. Run: pip install rapidfuzz")

# --- Windows-only helpers (registry + shortcut resolving) ----------------
try:
    import winreg
    IS_WINDOWS = True
except ImportError:
    winreg = None
    IS_WINDOWS = False

try:
    import win32com.client  # pywin32 - optional, only used to resolve .lnk targets
    HAS_WIN32COM = True
except ImportError:
    HAS_WIN32COM = False


# ══════════════════════════════════════════════════════════════════════
#  BUILT-IN WINDOWS APPS
#  These don't have Start Menu shortcuts on most systems, so they are
#  listed explicitly with their real launch command.
# ══════════════════════════════════════════════════════════════════════
BUILTIN_APPS = [
    {"name": "Notepad",              "path": "notepad.exe",        "publisher": "Microsoft (Windows)", "aliases": ["notepad"]},
    {"name": "Calculator",           "path": "calc.exe",           "publisher": "Microsoft (Windows)", "aliases": ["calculator", "calc"]},
    {"name": "Microsoft Paint",      "path": "mspaint.exe",        "publisher": "Microsoft (Windows)", "aliases": ["paint", "mspaint"]},
    {"name": "Command Prompt",       "path": "cmd.exe",            "publisher": "Microsoft (Windows)", "aliases": ["cmd", "command prompt"]},
    {"name": "Windows PowerShell",   "path": "powershell.exe",     "publisher": "Microsoft (Windows)", "aliases": ["powershell", "ps", "windows powershell"]},
    {"name": "Task Manager",         "path": "taskmgr.exe",        "publisher": "Microsoft (Windows)", "aliases": ["task manager", "taskmgr"]},
    {"name": "Control Panel",        "path": "control.exe",        "publisher": "Microsoft (Windows)", "aliases": ["control panel"]},
    {"name": "System Information",   "path": "msinfo32.exe",       "publisher": "Microsoft (Windows)", "aliases": ["system information", "system info", "msinfo32"]},
    {"name": "Registry Editor",      "path": "regedit.exe",        "publisher": "Microsoft (Windows)", "aliases": ["registry editor", "regedit"]},
    {"name": "File Explorer",        "path": "explorer.exe",       "publisher": "Microsoft (Windows)", "aliases": ["file explorer", "explorer", "my computer", "this pc"]},
    {"name": "Snipping Tool",        "path": "SnippingTool.exe",   "publisher": "Microsoft (Windows)", "aliases": ["snipping tool", "snip", "screenshot tool"]},
    {"name": "Camera",               "path": "microsoft.windows.camera:", "publisher": "Microsoft (Windows)", "aliases": ["camera"]},
    {"name": "Photos",               "path": "ms-photos:",         "publisher": "Microsoft (Windows)", "aliases": ["photos", "photo viewer"]},
    {"name": "Settings",             "path": "ms-settings:",       "publisher": "Microsoft (Windows)", "aliases": ["settings", "windows settings"]},
    {"name": "Windows Media Player", "path": "wmplayer.exe",       "publisher": "Microsoft (Windows)", "aliases": ["media player", "windows media player"]},
]

# Common shorthand -> canonical app name, used to boost fuzzy matching so
# short/typo-ish input still lands on the right installed application.
ALIAS_HINTS = {
    "chrome": "Google Chrome",
    "edge": "Microsoft Edge",
    "word": "Microsoft Word",
    "excel": "Microsoft Excel",
    "powerpoint": "Microsoft PowerPoint",
    "ppt": "Microsoft PowerPoint",
    "vscode": "Visual Studio Code",
    "vs code": "Visual Studio Code",
    "code": "Visual Studio Code",
    "cmd": "Command Prompt",
    "ps": "Windows PowerShell",
    "intellij": "IntelliJ IDEA",
    "android studio": "Android Studio",
    "pycharm": "PyCharm",
    "obs": "OBS Studio",
    "docker": "Docker Desktop",
    "github": "GitHub Desktop",
}

# Words that don't carry meaning about *which* app to open.
_STOPWORDS = {"open", "launch", "start", "please", "the", "app", "application", "software", "for", "me"}


# ══════════════════════════════════════════════════════════════════════
#  QUERY CLEANING / ALIAS EXPANSION
# ══════════════════════════════════════════════════════════════════════
def clean_query(text):
    """Strip filler words like 'open', 'launch', 'please' from user input."""
    text = (text or "").lower().strip()
    text = re.sub(r"[^\w\s]", " ", text)
    words = [w for w in text.split() if w not in _STOPWORDS]
    cleaned = " ".join(words).strip()
    return cleaned or text.strip()


def expand_alias(query):
    """If the cleaned query matches a known shorthand, return the canonical
    app name it should be matched against (falls back to the query itself)."""
    q = query.lower().strip()
    if q in ALIAS_HINTS:
        return ALIAS_HINTS[q]
    for alias, canonical in ALIAS_HINTS.items():
        if alias == q:
            return canonical
    return query


# ══════════════════════════════════════════════════════════════════════
#  APP DISCOVERY (Windows Start Menu shortcuts)
# ══════════════════════════════════════════════════════════════════════
def _start_menu_dirs():
    dirs = []
    program_data = os.environ.get("PROGRAMDATA")
    app_data = os.environ.get("APPDATA")
    if program_data:
        dirs.append(os.path.join(program_data, "Microsoft", "Windows", "Start Menu", "Programs"))
    if app_data:
        dirs.append(os.path.join(app_data, "Microsoft", "Windows", "Start Menu", "Programs"))
    return [d for d in dirs if os.path.isdir(d)]


def _resolve_lnk_target(lnk_path):
    """Best-effort resolve of a .lnk shortcut's real target exe path."""
    if not HAS_WIN32COM:
        return None
    try:
        shell = win32com.client.Dispatch("WScript.Shell")
        shortcut = shell.CreateShortCut(lnk_path)
        target = shortcut.Targetpath
        return target or None
    except Exception:
        return None


def _scan_shortcuts():
    """Walk Start Menu folders and return a list of launchable shortcuts."""
    results = []
    seen_names = set()
    for base in _start_menu_dirs():
        for root, _dirs, files in os.walk(base):
            for fname in files:
                if not fname.lower().endswith((".lnk", ".url")):
                    continue
                name = os.path.splitext(fname)[0]
                key = name.lower()
                if key in seen_names:
                    continue
                seen_names.add(key)
                full_path = os.path.join(root, fname)
                target = _resolve_lnk_target(full_path) if fname.lower().endswith(".lnk") else None
                results.append({
                    "name": name,
                    "path": target or full_path,
                    "publisher": None,
                    "aliases": [],
                })
    return results


# ══════════════════════════════════════════════════════════════════════
#  APP DISCOVERY (Registry - installed programs, for publisher info)
# ══════════════════════════════════════════════════════════════════════
def _registry_publishers():
    """Best-effort map of {lowercased display name -> publisher} pulled from
    the Windows Uninstall registry keys. Used only to enrich results with
    a Publisher label; never required for launching."""
    if not IS_WINDOWS or winreg is None:
        return {}

    publishers = {}
    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    for hive, subkey in roots:
        try:
            with winreg.OpenKey(hive, subkey) as key:
                for i in range(winreg.QueryInfoKey(key)[0]):
                    try:
                        sub_name = winreg.EnumKey(key, i)
                        with winreg.OpenKey(key, sub_name) as entry:
                            try:
                                display_name = winreg.QueryValueEx(entry, "DisplayName")[0]
                            except OSError:
                                continue
                            try:
                                publisher = winreg.QueryValueEx(entry, "Publisher")[0]
                            except OSError:
                                publisher = None
                            if display_name:
                                publishers[display_name.lower()] = publisher
                    except OSError:
                        continue
        except OSError:
            continue
    return publishers


# ══════════════════════════════════════════════════════════════════════
#  APP INDEX (cached)
# ══════════════════════════════════════════════════════════════════════
_app_index_cache = None


def build_app_index(force_refresh=False):
    """Merge built-in apps + discovered Start Menu shortcuts into one list,
    enriched with publisher info from the registry where available."""
    global _app_index_cache
    if _app_index_cache is not None and not force_refresh:
        return _app_index_cache

    index = list(BUILTIN_APPS)
    if IS_WINDOWS:
        try:
            index.extend(_scan_shortcuts())
        except Exception as e:
            print(f"[openanyapp] Start Menu scan failed: {e}")

        try:
            publishers = _registry_publishers()
            for app in index:
                if not app.get("publisher"):
                    app["publisher"] = publishers.get(app["name"].lower())
        except Exception as e:
            print(f"[openanyapp] Registry publisher lookup failed: {e}")

    _app_index_cache = index
    return index


# ══════════════════════════════════════════════════════════════════════
#  SMART MATCHING
# ══════════════════════════════════════════════════════════════════════
def _score(query, app):
    """Highest fuzzy score between the query and the app's name/aliases."""
    candidates = [app["name"]] + app.get("aliases", [])
    if not FUZZY_OK:
        query_l = query.lower()
        for c in candidates:
            if query_l == c.lower():
                return 100
            if query_l in c.lower() or c.lower() in query_l:
                return 70
        return 0

    best = 0
    for c in candidates:
        c_l = c.lower()
        best = max(
            best,
            fuzz.WRatio(query, c),
            fuzz.token_sort_ratio(query, c_l),
            fuzz.partial_ratio(query, c_l) * 0.9,
        )
    return best


def search_apps(raw_query, limit=6, threshold=45):
    """Return the best-matching installed applications for raw_query,
    ranked highest score first."""
    cleaned = clean_query(raw_query)
    if not cleaned:
        return []

    expanded = expand_alias(cleaned)
    index = build_app_index()

    scored = []
    for app in index:
        score = max(_score(cleaned, app), _score(expanded, app))
        if score >= threshold:
            scored.append({
                "name": app["name"],
                "publisher": app.get("publisher") or "Unknown",
                "path": app["path"],
                "install_path": app["path"] if os.path.sep in str(app["path"]) else None,
                "score": round(score, 1),
            })

    # Keep the single best-scoring entry per app name (dedupe).
    best_by_name = {}
    for item in scored:
        key = item["name"].lower()
        if key not in best_by_name or item["score"] > best_by_name[key]["score"]:
            best_by_name[key] = item

    results = sorted(best_by_name.values(), key=lambda r: r["score"], reverse=True)
    return results[:limit]


def decide_match(raw_query):
    """High-level entry point used by the /api/openanyapp/search route."""
    results = search_apps(raw_query)
    if not results:
        return {
            "status": "not_found",
            "message": "Application not found. No installed application matches your search. "
                       "Please try another application name.",
        }

    if len(results) == 1:
        return {"status": "single", "match": results[0]}

    top, second = results[0], results[1]
    if top["score"] >= 82 and (top["score"] - second["score"]) >= 15:
        return {"status": "single", "match": top}

    return {"status": "multiple", "matches": results}


# ══════════════════════════════════════════════════════════════════════
#  LAUNCH
# ══════════════════════════════════════════════════════════════════════
def launch_app(path):
    """Launch an application given its path / command / URI. Works with:
       - plain executables on PATH ("notepad.exe")
       - absolute .exe paths
       - Start Menu .lnk / .url shortcuts
       - ms-settings: / other URI-scheme launchers
    """
    if not path:
        return {"success": False, "message": "No application path was provided."}

    if not IS_WINDOWS:
        return {
            "success": False,
            "message": "Launching desktop applications is currently supported on Windows only.",
        }

    try:
        os.startfile(path)  # noqa: this attribute only exists on Windows
        return {"success": True, "message": f"{path} launched successfully."}
    except FileNotFoundError:
        pass
    except Exception as e:
        # os.startfile can raise OSError for URI schemes it doesn't like;
        # fall through and try a subprocess-based launch instead.
        print(f"[openanyapp] os.startfile failed for '{path}': {e}")

    try:
        subprocess.Popen(["cmd", "/c", "start", "", path], shell=False)
        return {"success": True, "message": f"{path} launched successfully."}
    except Exception as e:
        return {"success": False, "message": f"Could not launch '{path}': {e}"}


def open_app(app_name):
    """Convenience wrapper: clean input, find the best match, launch it.
    Kept for CLI / standalone use."""
    result = decide_match(app_name)
    if result["status"] == "single":
        launch_result = launch_app(result["match"]["path"])
        print(f"[SNETCH] {launch_result['message']}")
        return launch_result
    elif result["status"] == "multiple":
        print("[SNETCH] Multiple matches found:")
        for m in result["matches"]:
            print(f"  - {m['name']} ({m['publisher']})")
        return result
    else:
        print(f"[SNETCH] {result['message']}")
        return result


if __name__ == "__main__":
    open_app("open chrome")
