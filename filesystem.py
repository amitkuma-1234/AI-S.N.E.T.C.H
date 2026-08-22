"""
filesystem.py — S.N.E.T.C.H File & Folder Management System (backend)

Exposes a Flask Blueprint (`fs_bp`) with a full JSON API used by
templates/filesystem.html + js/filesystem.js:

    GET  /api/filesystem/locations
    GET  /api/filesystem/search
    POST /api/filesystem/create
    POST /api/filesystem/update/file
    POST /api/filesystem/update/folder/add
    POST /api/filesystem/update/folder/replace
    POST /api/filesystem/delete
    POST /api/filesystem/rename
    POST /api/filesystem/open

The original interactive CLI (`python filesystem.py`) is preserved at the
bottom of the file for standalone/manual use.
"""

from pathlib import Path
import shutil
import os
import platform
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from flask import Blueprint, request, jsonify
from send2trash import send2trash

# ─────────────────────────────────────────────
# EXACT NORMALIZED MATCH SETUP
# ─────────────────────────────────────────────
def normalize_name(name: str) -> str:
    """Removes spaces, underscores, and hyphens, and converts to lowercase."""
    return re.sub(r'[\s_\-]', '', name).lower()

def is_normalized_match(entry_name: str, normalized_query: str) -> bool:
    """True if entry_name matches normalized_query exactly after normalization."""
    if normalize_name(entry_name) == normalized_query:
        return True
    if normalize_name(Path(entry_name).stem) == normalized_query:
        return True
    return False

# ─────────────────────────────────────────────
# COMMON FOLDER SHORTCUTS
# ─────────────────────────────────────────────
COMMON_FOLDERS = {
    "desktop":   Path.home() / "Desktop",
    "documents": Path.home() / "Documents",
    "downloads": Path.home() / "Downloads",
    "pictures":  Path.home() / "Pictures",
    "videos":    Path.home() / "Videos",
    "music":     Path.home() / "Music",
}

# Heavy / system folders to skip during search (speed + safety)
SKIP_DIRS = {
    "appdata", ".vscode", "node_modules", "__pycache__",
    ".git", "site-packages", "venv", ".env", "dist",
    "build", "cache", ".cache", "temp", "tmp",
    "windows", "system32", "syswow64", "program files",
    "program files (x86)", "programdata",
}

MAX_RESULTS = 300  # cap returned search results for a snappy UI

# ─────────────────────────────────────────────
# SERIALIZATION HELPERS
# ─────────────────────────────────────────────
def _icon_for(path: Path) -> str:
    if path.is_dir():
        return "fa-folder"
    ext = path.suffix.lower().lstrip(".")
    mapping = {
        "pdf": "fa-file-pdf", "doc": "fa-file-word", "docx": "fa-file-word",
        "xls": "fa-file-excel", "xlsx": "fa-file-excel",
        "ppt": "fa-file-powerpoint", "pptx": "fa-file-powerpoint",
        "png": "fa-file-image", "jpg": "fa-file-image", "jpeg": "fa-file-image",
        "gif": "fa-file-image", "webp": "fa-file-image", "svg": "fa-file-image",
        "mp4": "fa-file-video", "mov": "fa-file-video", "avi": "fa-file-video", "mkv": "fa-file-video",
        "mp3": "fa-file-audio", "wav": "fa-file-audio", "flac": "fa-file-audio",
        "zip": "fa-file-zipper", "rar": "fa-file-zipper", "7z": "fa-file-zipper",
        "txt": "fa-file-lines", "md": "fa-file-lines",
        "py": "fa-file-code", "js": "fa-file-code", "html": "fa-file-code",
        "css": "fa-file-code", "json": "fa-file-code", "java": "fa-file-code", "cpp": "fa-file-code",
    }
    return mapping.get(ext, "fa-file")


def _safe_stat(path: Path):
    try:
        return path.stat()
    except Exception:
        return None


def serialize_path(path: Path) -> dict:
    st = _safe_stat(path)
    is_dir = path.is_dir()
    size = 0
    if st and not is_dir:
        size = st.st_size
    modified = ""
    if st:
        try:
            modified = datetime.fromtimestamp(st.st_mtime).strftime("%d %b %Y, %I:%M %p")
        except Exception:
            modified = ""
    return {
        "name": path.name,
        "extension": path.suffix.lstrip(".").upper() if not is_dir else "",
        "path": str(path),
        "is_dir": is_dir,
        "size": _human_size(size) if not is_dir else "",
        "size_bytes": size,
        "modified": modified,
        "icon": _icon_for(path),
    }


def _human_size(num: float) -> str:
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if num < 1024:
            return f"{num:.0f} {unit}" if unit == "B" else f"{num:.1f} {unit}"
        num /= 1024
    return f"{num:.1f} PB"


# ─────────────────────────────────────────────
# SAFETY GUARD
# ─────────────────────────────────────────────
def _is_safe_path(path: Path) -> bool:
    """Only allow operations inside the user's home directory tree."""
    try:
        resolved = path.resolve()
        home = Path.home().resolve()
        return resolved == home or home in resolved.parents
    except Exception:
        return False


def _to_path(raw):
    if not raw:
        return None
    p = Path(raw)
    if not _is_safe_path(p):
        return None
    return p


# ─────────────────────────────────────────────
# EXACT / NORMALIZED SEARCH
# ─────────────────────────────────────────────
def _scan_dir(directory: Path, normalized_query: str, results: list, kind: str):
    """Recursively scan with normalized exact name matching, filtered by kind."""
    try:
        with os.scandir(directory) as it:
            for entry in it:
                try:
                    entry_name = entry.name.lower()
                    is_dir = entry.is_dir(follow_symlinks=False)

                    if is_dir and entry_name in SKIP_DIRS:
                        continue

                    matches_kind = (
                        kind == "any"
                        or (kind == "folder" and is_dir)
                        or (kind == "file" and not is_dir)
                    )

                    if matches_kind and is_normalized_match(entry_name, normalized_query):
                        results.append(Path(entry.path))

                    if is_dir:
                        if len(results) >= MAX_RESULTS:
                            return
                        _scan_dir(Path(entry.path), normalized_query, results, kind)

                except PermissionError:
                    continue
                except Exception:
                    continue
    except PermissionError:
        pass
    except Exception:
        pass


def search_by_name(name: str, kind: str = "any") -> list:
    """
    Search the user's home directory tree for files/folders whose name
    matches `name` exactly (ignoring spaces, cases, hyphens, and underscores).
    kind: 'any' | 'file' | 'folder'
    """
    normalized_query = normalize_name(name)
    if not normalized_query:
        return []

    results = []

    # Common folder shortcut — instant match
    if kind in ("any", "folder"):
        for key, path in COMMON_FOLDERS.items():
            if normalize_name(key) == normalized_query:
                if path.exists():
                    results.append(path)

    home = Path.home()
    try:
        top_dirs = [
            Path(e.path) for e in os.scandir(home)
            if e.is_dir() and e.name.lower() not in SKIP_DIRS
        ]
    except Exception:
        top_dirs = []

    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = []
        for d in top_dirs:
            bucket = []
            futures.append((executor.submit(_scan_dir, d, normalized_query, bucket, kind), bucket))

        for future, bucket in futures:
            try:
                future.result()
                results.extend(bucket)
            except Exception:
                pass

    # de-duplicate while preserving order
    seen = set()
    deduped = []
    for p in results:
        key = str(p)
        if key not in seen:
            seen.add(key)
            deduped.append(p)
    results = deduped

    return results[:MAX_RESULTS]


# ─────────────────────────────────────────────
# FILE / FOLDER OPERATIONS
# ─────────────────────────────────────────────
def open_path(path: Path):
    if not path.exists():
        return False, f"Path does not exist: {path}"
    system = platform.system()
    try:
        if system == "Windows":
            os.startfile(path)  # noqa
        elif system == "Darwin":
            os.system(f"open '{path}'")
        else:
            os.system(f'xdg-open "{path}"')
        return True, f"Opened: {path.name}"
    except Exception as e:
        return False, f"Failed to open {path.name}: {e}"


def delete_item(path: Path):
    if not path.exists():
        return False, f"Path does not exist: {path}"
    try:
        send2trash(str(path))
        return True, f"Moved to Trash: {path.name}"
    except Exception as e:
        return False, f"Failed to delete {path.name}: {e}"


def get_unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    base = path.stem if path.is_file() else path.name
    suffix = path.suffix if path.is_file() else ""
    parent = path.parent
    counter = 1
    while True:
        new_path = parent / f"{base}({counter}){suffix}"
        if not new_path.exists():
            return new_path
        counter += 1


def create_item(name: str, target_dir: Path, kind: str):
    full_path = target_dir / name
    is_folder = kind == "folder"

    if full_path.exists():
        full_path = get_unique_path(full_path)

    try:
        if is_folder:
            full_path.mkdir(parents=True, exist_ok=True)
        else:
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.touch()
        return True, str(full_path)
    except Exception as e:
        return False, str(e)


def rename_item(path: Path, new_name: str):
    if not path.exists():
        return False, f"Path does not exist: {path}"
    new_path = path.parent / new_name
    if new_path.exists():
        return False, f"'{new_name}' already exists."
    try:
        path.rename(new_path)
        return True, str(new_path)
    except Exception as e:
        return False, str(e)


def move_into(source: Path, target_dir: Path):
    """Move source into target_dir, removing it from its original location."""
    if not source.exists():
        return False, f"Source not found: {source}"
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        final_path = get_unique_path(target_dir / source.name)
        shutil.move(str(source), str(final_path))
        return True, str(final_path)
    except Exception as e:
        return False, str(e)


def replace_file(target: Path, replacement: Path):
    """Copy replacement's content over target, then remove replacement's original file."""
    if not replacement.exists():
        return False, f"Replacement not found: {replacement}"
    try:
        if target.exists() and target.is_dir():
            return False, f"'{target.name}' is a folder, not a file."
        shutil.copy2(str(replacement), str(target))
        replacement.unlink(missing_ok=True)
        return True, str(target)
    except Exception as e:
        return False, str(e)


def replace_folder(target: Path, replacement: Path):
    """Replace target folder with replacement folder, then remove replacement's original location."""
    if not replacement.exists() or not replacement.is_dir():
        return False, f"Replacement folder not found: {replacement}"
    try:
        if target.exists():
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        shutil.copytree(str(replacement), str(target))
        shutil.rmtree(str(replacement))
        return True, str(target)
    except Exception as e:
        return False, str(e)


# ══════════════════════════════════════════════════════════════════
#  FLASK BLUEPRINT — JSON API
# ══════════════════════════════════════════════════════════════════
fs_bp = Blueprint("filesystem_api", __name__, url_prefix="/api/filesystem")


@fs_bp.route("/locations", methods=["GET"])
def api_locations():
    locations = []
    for key, path in COMMON_FOLDERS.items():
        locations.append({
            "key": key,
            "label": key.capitalize(),
            "path": str(path),
            "exists": path.exists(),
        })
    return jsonify({"success": True, "locations": locations})


@fs_bp.route("/search", methods=["GET"])
def api_search():
    query = (request.args.get("q") or "").strip()
    kind = (request.args.get("kind") or "any").strip().lower()
    if kind not in ("any", "file", "folder"):
        kind = "any"

    if not query:
        return jsonify({"success": True, "results": []})

    results = search_by_name(query, kind=kind)
    serialized = [serialize_path(p) for p in results]
    return jsonify({"success": True, "results": serialized, "count": len(serialized)})


@fs_bp.route("/create", methods=["POST"])
def api_create():
    data = request.get_json(silent=True) or {}
    kind = (data.get("kind") or "").strip().lower()          # 'file' | 'folder'
    name = (data.get("name") or "").strip()
    destinations = data.get("destinations") or []

    if kind not in ("file", "folder"):
        return jsonify({"success": False, "message": "Invalid type."}), 400
    if not name:
        return jsonify({"success": False, "message": "Name is required."}), 400
    if kind == "file" and "." not in name:
        return jsonify({"success": False, "message": "File name must include an extension (e.g. notes.txt)."}), 400
    if not destinations:
        return jsonify({"success": False, "message": "Select at least one destination."}), 400

    created, failed = [], []
    for raw in destinations:
        dest = _to_path(raw)
        if dest is None or not dest.exists() or not dest.is_dir():
            failed.append({"destination": raw, "message": "Destination not found."})
            continue
        ok, result = create_item(name, dest, kind)
        (created if ok else failed).append({"destination": str(dest), "path": result if ok else None,
                                             "message": None if ok else result})

    return jsonify({
        "success": len(created) > 0,
        "message": f"Created in {len(created)} location(s)." + (f" {len(failed)} failed." if failed else ""),
        "created": created,
        "failed": failed,
    })


@fs_bp.route("/update/file", methods=["POST"])
def api_update_file():
    data = request.get_json(silent=True) or {}
    target = _to_path(data.get("target"))
    replacement = _to_path(data.get("replacement"))

    if target is None or not target.exists():
        return jsonify({"success": False, "message": "Target file not found."}), 400
    if replacement is None or not replacement.exists():
        return jsonify({"success": False, "message": "Replacement file not found."}), 400
    if str(target) == str(replacement):
        return jsonify({"success": False, "message": "Target and replacement cannot be the same file."}), 400

    ok, message = replace_file(target, replacement)
    return jsonify({"success": ok, "message": message if not ok else f"'{target.name}' updated successfully."})


@fs_bp.route("/update/folder/add", methods=["POST"])
def api_update_folder_add():
    data = request.get_json(silent=True) or {}
    target = _to_path(data.get("target"))
    sources = data.get("sources") or []

    if target is None or not target.exists() or not target.is_dir():
        return jsonify({"success": False, "message": "Target folder not found."}), 400
    if not sources:
        return jsonify({"success": False, "message": "Select at least one file or folder to add."}), 400

    moved, failed = [], []
    for raw in sources:
        src = _to_path(raw)
        if src is None or not src.exists():
            failed.append({"source": raw, "message": "Not found."})
            continue
        if str(src) == str(target) or str(target).startswith(str(src) + os.sep):
            failed.append({"source": str(src), "message": "Cannot move a folder into itself."})
            continue
        ok, result = move_into(src, target)
        (moved if ok else failed).append({"source": str(src), "path": result if ok else None,
                                           "message": None if ok else result})

    return jsonify({
        "success": len(moved) > 0,
        "message": f"Added {len(moved)} item(s) to '{target.name}'." + (f" {len(failed)} failed." if failed else ""),
        "moved": moved,
        "failed": failed,
    })


@fs_bp.route("/update/folder/replace", methods=["POST"])
def api_update_folder_replace():
    data = request.get_json(silent=True) or {}
    target = _to_path(data.get("target"))
    replacement = _to_path(data.get("replacement"))

    if target is None or not target.exists() or not target.is_dir():
        return jsonify({"success": False, "message": "Target folder not found."}), 400
    if replacement is None or not replacement.exists() or not replacement.is_dir():
        return jsonify({"success": False, "message": "Replacement folder not found."}), 400
    if str(target) == str(replacement):
        return jsonify({"success": False, "message": "Target and replacement cannot be the same folder."}), 400
    if str(target).startswith(str(replacement) + os.sep):
        return jsonify({"success": False, "message": "Cannot replace a folder with its own parent."}), 400

    ok, message = replace_folder(target, replacement)
    return jsonify({"success": ok, "message": message if not ok else f"'{target.name}' replaced successfully."})


@fs_bp.route("/delete", methods=["POST"])
def api_delete():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or []
    if not paths:
        return jsonify({"success": False, "message": "No items selected."}), 400

    deleted, failed = [], []
    for raw in paths:
        p = _to_path(raw)
        if p is None:
            failed.append({"path": raw, "message": "Invalid or unsafe path."})
            continue
        ok, message = delete_item(p)
        (deleted if ok else failed).append({"path": raw, "message": message})

    return jsonify({
        "success": len(deleted) > 0,
        "message": f"Deleted {len(deleted)} item(s)." + (f" {len(failed)} failed." if failed else ""),
        "deleted": deleted,
        "failed": failed,
    })


@fs_bp.route("/rename", methods=["POST"])
def api_rename():
    data = request.get_json(silent=True) or {}
    path = _to_path(data.get("path"))
    new_name = (data.get("new_name") or "").strip()

    if path is None or not path.exists():
        return jsonify({"success": False, "message": "Item not found."}), 400
    if not new_name:
        return jsonify({"success": False, "message": "New name is required."}), 400
    if path.is_file() and "." not in new_name:
        return jsonify({"success": False, "message": "File name must include an extension."}), 400

    ok, result = rename_item(path, new_name)
    return jsonify({"success": ok, "message": result if not ok else f"Renamed to '{new_name}' successfully.",
                     "path": result if ok else None})


@fs_bp.route("/open", methods=["POST"])
def api_open():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or []
    if not paths:
        return jsonify({"success": False, "message": "No items selected."}), 400

    opened, failed = [], []
    for raw in paths:
        p = _to_path(raw)
        if p is None:
            failed.append({"path": raw, "message": "Invalid or unsafe path."})
            continue
        ok, message = open_path(p)
        (opened if ok else failed).append({"path": raw, "message": message})

    return jsonify({
        "success": len(opened) > 0,
        "message": f"Opened {len(opened)} item(s)." + (f" {len(failed)} failed." if failed else ""),
        "opened": opened,
        "failed": failed,
    })


# ══════════════════════════════════════════════════════════════════
#  STANDALONE INTERACTIVE CLI  (manual/testing mode)
# ══════════════════════════════════════════════════════════════════
def get_input(prompt: str = "") -> str:
    if prompt:
        print(prompt)
    try:
        return input(">>> ").strip()
    except EOFError:
        return ""
    except Exception:
        return ""


def _cli_show_menu(results, single_only=False):
    print(f"\n  Found {len(results)} result(s):")
    for i, result in enumerate(results, start=1):
        kind = "📁" if result.is_dir() else "📄"
        print(f"  {i}. {kind} {result}")
    raw = get_input("  Enter number(s), 'all', or 'none':")
    if raw.lower() in ("none", ""):
        return None
    if raw.lower() == "all":
        return results
    try:
        idxs = [int(x) - 1 for x in re.split(r"[\s,]+", raw) if x]
        chosen = [results[i] for i in idxs if 0 <= i < len(results)]
        if single_only:
            chosen = chosen[:1]
        return chosen or None
    except Exception:
        return None


def _cli_pick_destination():
    print("\n  Common shortcuts: desktop, downloads, documents, pictures, videos, music")
    name = get_input("  Enter destination folder name:")
    if not name:
        return None
    if name.lower() in COMMON_FOLDERS:
        return COMMON_FOLDERS[name.lower()]
    results = search_by_name(name, kind="folder")
    if not results:
        print("  ❌ No folders found.")
        return None
    chosen = _cli_show_menu(results, single_only=True)
    return chosen[0] if chosen else None


def files(choice: str):
    """Simple interactive CLI dispatcher for manual testing."""
    choice_lower = choice.lower().strip()

    if any(w in choice_lower for w in ["open", "show"]):
        name = get_input("  Enter file/folder name to open:")
        results = search_by_name(name)
        chosen = _cli_show_menu(results)
        if chosen:
            for p in chosen:
                ok, msg = open_path(p)
                print(f"  {'✅' if ok else '❌'} {msg}")

    elif any(w in choice_lower for w in ["delete", "remove"]):
        name = get_input("  Enter file/folder name to delete:")
        results = search_by_name(name)
        chosen = _cli_show_menu(results)
        if chosen:
            for p in chosen:
                ok, msg = delete_item(p)
                print(f"  {'✅' if ok else '❌'} {msg}")

    elif any(w in choice_lower for w in ["create", "add"]):
        name = get_input("  Enter name for new file/folder:")
        dest = _cli_pick_destination()
        if dest:
            kind = "folder" if "." not in name else "file"
            ok, msg = create_item(name, dest, kind)
            print(f"  {'✅' if ok else '❌'} {msg}")

    elif "rename" in choice_lower:
        name = get_input("  Enter file/folder name to rename:")
        results = search_by_name(name)
        chosen = _cli_show_menu(results, single_only=True)
        if chosen:
            new_name = get_input(f"  Enter new name for '{chosen[0].name}':")
            ok, msg = rename_item(chosen[0], new_name)
            print(f"  {'✅' if ok else '❌'} {msg}")

    elif any(w in choice_lower for w in ["update", "replace"]):
        name = get_input("  Enter file/folder name to update:")
        targets = _cli_show_menu(search_by_name(name))
        if not targets:
            return
        repl_name = get_input("  Enter replacement name:")
        repl_results = search_by_name(repl_name)
        repl_chosen = _cli_show_menu(repl_results, single_only=True)
        if not repl_chosen:
            return
        replacement = repl_chosen[0]
        for target in targets:
            if target.is_dir():
                ok, msg = replace_folder(target, replacement)
            else:
                ok, msg = replace_file(target, replacement)
            print(f"  {'✅' if ok else '❌'} {msg}")

    else:
        print("  ❌ Unknown command.")
        print("  Commands: open | delete | create | rename | update")


if __name__ == "__main__":
    print("=" * 55)
    print("  📁 File Manager (standalone CLI mode)")
    print("=" * 55)
    while True:
        command = get_input("\n  Enter command (or 'exit'):")
        if command.lower() in ("exit", "quit"):
            print("  👋 Goodbye!")
            break
        files(command)
