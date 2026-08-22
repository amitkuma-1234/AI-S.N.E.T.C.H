"""
countingset.py — S.N.E.T.C.H · Countdown & Stopwatch Dashboard (backend)
══════════════════════════════════════════════════════════════════════════

This module contains the server-side logic for the Counter & Timer
feature: time parsing/formatting helpers, a JSON-file persistence layer
for saved Countdown/Stopwatch records, and a ready-to-use Flask
Blueprint that exposes that persistence layer over a small REST API.

Per the update scope for this feature, app.py itself is NOT modified by
this change. The dashboard therefore runs fully client-side out of the
box (js/countingset.js persists records to the browser via
localStorage, so the feature is complete and usable with zero backend
wiring). The Blueprint below is provided so the exact same data model
can be promoted to real server-side persistence later with a single
line, without touching anything in this file:

    # in app.py
    from countingset import countingset_bp
    app.register_blueprint(countingset_bp)

Once registered, js/countingset.js will automatically start syncing
records to these endpoints (it already calls them opportunistically and
silently falls back to localStorage if they are not present).
"""

import os
import re
import json
import time
import threading
import datetime

try:
    from flask import Blueprint, request, jsonify
    _FLASK_AVAILABLE = True
except ImportError:  # pragma: no cover - flask always present in this project
    _FLASK_AVAILABLE = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "countingset_data.json")

_lock = threading.Lock()


# ══════════════════════════════════════════════════════════════════
#  TIME PARSING / FORMATTING HELPERS
# ══════════════════════════════════════════════════════════════════
def parse_time(input_text):
    """Parse a total-seconds integer out of natural language like
    '1 minute 30 second', '74 second', '1 hr 23 minute 40 second'."""
    input_text = (input_text or "").lower()
    minutes = seconds = hours = 0

    hour_match = re.search(r"(\d+)\s*(hour|hr|hours|hrs)", input_text)
    minute_match = re.search(r"(\d+)\s*(minute|min|minutes|mins|minuter)", input_text)
    second_match = re.search(r"(\d+)\s*(second|sec|seconds|secs|seond)", input_text)

    if hour_match:
        hours = int(hour_match.group(1))
    if minute_match:
        minutes = int(minute_match.group(1))
    if second_match:
        seconds = int(second_match.group(1))

    return hours * 3600 + minutes * 60 + seconds


def format_time(total_seconds):
    """Format a seconds count into an HH:MM:SS display string."""
    total_seconds = max(0, int(total_seconds))
    h = total_seconds // 3600
    m = (total_seconds % 3600) // 60
    s = total_seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def hms_to_seconds(hours=0, minutes=0, seconds=0):
    """Combine hours/minutes/seconds inputs (from the Set Countdown
    screen) into a total-seconds integer, clamped to non-negative."""
    try:
        hours = max(0, int(hours))
        minutes = max(0, int(minutes))
        seconds = max(0, int(seconds))
    except (TypeError, ValueError):
        return 0
    return hours * 3600 + minutes * 60 + seconds


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def now_display():
    return datetime.datetime.now().strftime("%d %b %Y, %I:%M %p")


# ══════════════════════════════════════════════════════════════════
#  JSON PERSISTENCE LAYER
#  Mirrors the shape saved by js/countingset.js in localStorage, so
#  records look identical whether they come from the browser cache or
#  from this file, once/if the Blueprint below is wired into app.py.
# ══════════════════════════════════════════════════════════════════
def _empty_store():
    return {"countdowns": [], "stopwatches": []}


def _load():
    if not os.path.exists(DATA_FILE):
        return _empty_store()
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        data.setdefault("countdowns", [])
        data.setdefault("stopwatches", [])
        return data
    except (json.JSONDecodeError, OSError):
        return _empty_store()


def _save(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _new_id():
    return f"{int(time.time() * 1000)}{os.urandom(2).hex()}"


# ---------- Countdown records ----------
def list_countdowns():
    with _lock:
        return _load()["countdowns"]


def add_countdown_record(name, number, total_seconds, cycles):
    record = {
        "id": _new_id(),
        "name": (name or "Countdown").strip() or "Countdown",
        "number": number,
        "total_seconds": int(total_seconds),
        "original_time": format_time(total_seconds),
        "cycles": int(cycles or 0),
        "created_at": now_iso(),
        "created_display": now_display(),
    }
    with _lock:
        data = _load()
        data["countdowns"].insert(0, record)
        _save(data)
    return record


def update_countdown_record(record_id, name=None, number=None):
    with _lock:
        data = _load()
        for rec in data["countdowns"]:
            if rec["id"] == record_id:
                if name is not None:
                    rec["name"] = name.strip() or rec["name"]
                if number is not None:
                    rec["number"] = number
                _save(data)
                return rec
    return None


def delete_countdown_record(record_id):
    with _lock:
        data = _load()
        before = len(data["countdowns"])
        data["countdowns"] = [r for r in data["countdowns"] if r["id"] != record_id]
        changed = len(data["countdowns"]) != before
        if changed:
            _save(data)
        return changed


# ---------- Stopwatch records ----------
def list_stopwatches():
    with _lock:
        return _load()["stopwatches"]


def add_stopwatch_record(name, number, elapsed_seconds, cycles):
    record = {
        "id": _new_id(),
        "name": (name or "Stopwatch").strip() or "Stopwatch",
        "number": number,
        "elapsed_seconds": float(elapsed_seconds),
        "recorded_time": format_time(elapsed_seconds),
        "cycles": int(cycles or 0),
        "created_at": now_iso(),
        "created_display": now_display(),
    }
    with _lock:
        data = _load()
        data["stopwatches"].insert(0, record)
        _save(data)
    return record


def update_stopwatch_record(record_id, name=None, number=None):
    with _lock:
        data = _load()
        for rec in data["stopwatches"]:
            if rec["id"] == record_id:
                if name is not None:
                    rec["name"] = name.strip() or rec["name"]
                if number is not None:
                    rec["number"] = number
                _save(data)
                return rec
    return None


def delete_stopwatch_record(record_id):
    with _lock:
        data = _load()
        before = len(data["stopwatches"])
        data["stopwatches"] = [r for r in data["stopwatches"] if r["id"] != record_id]
        changed = len(data["stopwatches"]) != before
        if changed:
            _save(data)
        return changed


# ══════════════════════════════════════════════════════════════════
#  OPTIONAL FLASK BLUEPRINT — REST API
#  Inert until registered in app.py (see module docstring). The
#  frontend already targets these exact routes and will pick them up
#  automatically the moment they exist.
# ══════════════════════════════════════════════════════════════════
if _FLASK_AVAILABLE:
    countingset_bp = Blueprint("countingset_bp", __name__)

    @countingset_bp.route("/api/countingset/countdowns", methods=["GET"])
    def api_list_countdowns():
        return jsonify({"status": "ok", "records": list_countdowns()})

    @countingset_bp.route("/api/countingset/countdowns", methods=["POST"])
    def api_add_countdown():
        data = request.get_json(force=True, silent=True) or {}
        record = add_countdown_record(
            data.get("name"),
            data.get("number"),
            data.get("total_seconds", 0),
            data.get("cycles", 0),
        )
        return jsonify({"status": "ok", "record": record}), 201

    @countingset_bp.route("/api/countingset/countdowns/<record_id>", methods=["PUT"])
    def api_update_countdown(record_id):
        data = request.get_json(force=True, silent=True) or {}
        record = update_countdown_record(record_id, data.get("name"), data.get("number"))
        if record is None:
            return jsonify({"error": "Record not found."}), 404
        return jsonify({"status": "ok", "record": record})

    @countingset_bp.route("/api/countingset/countdowns/<record_id>", methods=["DELETE"])
    def api_delete_countdown(record_id):
        if not delete_countdown_record(record_id):
            return jsonify({"error": "Record not found."}), 404
        return jsonify({"status": "ok"})

    @countingset_bp.route("/api/countingset/stopwatches", methods=["GET"])
    def api_list_stopwatches():
        return jsonify({"status": "ok", "records": list_stopwatches()})

    @countingset_bp.route("/api/countingset/stopwatches", methods=["POST"])
    def api_add_stopwatch():
        data = request.get_json(force=True, silent=True) or {}
        record = add_stopwatch_record(
            data.get("name"),
            data.get("number"),
            data.get("elapsed_seconds", 0),
            data.get("cycles", 0),
        )
        return jsonify({"status": "ok", "record": record}), 201

    @countingset_bp.route("/api/countingset/stopwatches/<record_id>", methods=["PUT"])
    def api_update_stopwatch(record_id):
        data = request.get_json(force=True, silent=True) or {}
        record = update_stopwatch_record(record_id, data.get("name"), data.get("number"))
        if record is None:
            return jsonify({"error": "Record not found."}), 404
        return jsonify({"status": "ok", "record": record})

    @countingset_bp.route("/api/countingset/stopwatches/<record_id>", methods=["DELETE"])
    def api_delete_stopwatch(record_id):
        if not delete_stopwatch_record(record_id):
            return jsonify({"error": "Record not found."}), 404
        return jsonify({"status": "ok"})
