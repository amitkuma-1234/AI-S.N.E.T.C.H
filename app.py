"""
app.py — S.N.E.T.C.H Flask Server (Step 1: Login -> Home dashboard)

Run with:  python app.py
Then open: http://127.0.0.1:5000/login

This step wires up ONLY the login/signup/home flow. Each feature (weather,
alarm, songplay, etc.) will get its own route + wrapper function in the
NEXT steps, one at a time.
"""

import os
import random
import string
import datetime
import secrets
import threading
import webbrowser
import hmac
from urllib.parse import urlencode
import importlib.util as _importlib_util
_worldclock_spec = _importlib_util.spec_from_file_location(
    "worldclock_backend",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "time.py"),
)
worldclock_backend = _importlib_util.module_from_spec(_worldclock_spec)
_worldclock_spec.loader.exec_module(worldclock_backend)

import jwt
import requests
from flask import (
    Flask, request, jsonify, render_template, redirect,
    send_from_directory, abort, session, url_for,
    Response, stream_with_context, g
)
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv

load_dotenv()

import db
import email_utils
import alarm
import wheather
import videoplay
import askanything
import imagecreater
import dailytask
import reminder
import Entertainment
import horoscopeapi
import openanyapp
import openanybrowser
import latestnews
from filesystem import fs_bp
from downloadvideo import downloadvideo_bp
import foodracipie
import image_chatbot
import shopinglist
import location
import spaim_mail
import youtube_chatbot
from countingset import countingset_bp
import songplay
import songdownload
import passwordsave
import snetch_assistant
import snaplock 
import whatsappmessage
import real_world_information
import download_entertainment
import document_chatbot
import smtp
import objecttracking
import face_expression
import deepfake_detector
import barcode_qr_scanner
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, template_folder="templates", static_folder=None)
app.secret_key = os.getenv("SECRET_KEY", "dev-secret-change-this-please")

JWT_SECRET = app.secret_key
JWT_ALGO = "HS256"
ACCESS_TOKEN_TTL = datetime.timedelta(hours=24)
REFRESH_TOKEN_TTL = datetime.timedelta(days=30)

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip().strip('"')
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "").strip().strip('"')

MAX_LOGIN_ATTEMPTS = 5
MAX_OTP_ATTEMPTS = 5

db.init_db()
askanything.init_db()
Entertainment.init_db()
horoscopeapi.init_db()
reminder.init_db()
passwordsave.init_db()
passwordsave.register_vault(app)
snetch_assistant.register_snetch_assistant(app)
snaplock.init_db() 
snaplock.register_snaplock(app)
foodracipie.init_db()
deepfake_detector.init_db()
# File System feature — JSON API (see filesystem.py)
app.register_blueprint(fs_bp)
app.register_blueprint(downloadvideo_bp)

# Image Chatbot feature — JSON/SSE API (see image_chatbot.py)
image_chatbot.register_image_chatbot(app)
whatsappmessage.register_whatsapp_messenger(app)
youtube_chatbot.register_youtube_chatbot(app)
app.register_blueprint(countingset_bp)
shopinglist.register_shopping_planner(app)
download_entertainment.register_entertainment_downloader(app)
document_chatbot.register_document_chatbot(app)
smtp.register_smtp(app)
objecttracking.register_object_tracking(app)
face_expression.register_face_expression(app)
# ══════════════════════════════════════════════════════════════════
#  GLOBAL API ERROR HANDLERS
#  Ensure /api/* routes always return JSON, never HTML error pages.
# ══════════════════════════════════════════════════════════════════

@app.errorhandler(404)
def handle_404(e):
    if request.path.startswith('/api/'):
        return jsonify({"ok": False, "error": "Endpoint not found"}), 404
    return e

@app.errorhandler(405)
def handle_405(e):
    if request.path.startswith('/api/'):
        return jsonify({"ok": False, "error": "Method not allowed"}), 405
    return e

@app.errorhandler(500)
def handle_500(e):
    if request.path.startswith('/api/'):
        return jsonify({"ok": False, "error": "Internal server error"}), 500
    return e


# ══════════════════════════════════════════════════════════════════
#  STATIC ASSET SERVING
#  Your HTML files reference css/js with relative paths like
#  "login.css" / "login.js" (no /static/ prefix), so we serve the
#  static/ and js/ folders directly at the root URL.
# ══════════════════════════════════════════════════════════════════

@app.route("/manifest.json")
def serve_manifest():
    return send_from_directory(os.path.join(BASE_DIR, "static"), "manifest.json")

@app.route("/sw.js")
def serve_sw():
    return send_from_directory(os.path.join(BASE_DIR, "static"), "sw.js")

@app.route("/<path:filename>")
def serve_asset(filename):
    # Never intercept API routes — let blueprints handle them
    if filename.startswith("api/"):
        abort(404)
    if filename.endswith(".css"):
        folder = os.path.join(BASE_DIR, "static")
        if os.path.exists(os.path.join(folder, filename)):
            return send_from_directory(folder, filename)
    if filename.endswith(".js"):
        folder = os.path.join(BASE_DIR, "js")
        filepath = os.path.join(folder, filename)
        if os.path.exists(filepath):
            if filename == "login.js":
                # This file has two small {{ ... }} placeholders that need
                # real values. Plain string-replace (not full Jinja) so the
                # rest of the JS (which is full of { } braces) isn't touched.
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()
                content = content.replace("{{ google_client_id }}", GOOGLE_CLIENT_ID)
                content = content.replace(
                    "{{ google_callback_uri }}",
                    url_for("google_callback", _external=True),
                )
                return app.response_class(content, mimetype="application/javascript")
            return send_from_directory(folder, filename)
    abort(404)


# ══════════════════════════════════════════════════════════════════
#  JWT HELPERS
# ══════════════════════════════════════════════════════════════════

def generate_tokens(user_row):
    now = datetime.datetime.now(datetime.timezone.utc)
    access_payload = {
        "sub": str(user_row["id"]), "email": user_row["email"], "type": "access",
        "iat": now, "exp": now + ACCESS_TOKEN_TTL,
    }
    refresh_payload = {
        "sub": str(user_row["id"]), "type": "refresh",
        "iat": now, "exp": now + REFRESH_TOKEN_TTL,
    }
    access_token = jwt.encode(access_payload, JWT_SECRET, algorithm=JWT_ALGO)
    refresh_token = jwt.encode(refresh_payload, JWT_SECRET, algorithm=JWT_ALGO)
    return access_token, refresh_token


def user_to_public(user_row):
    return {"id": user_row["id"], "email": user_row["email"], "username": user_row["username"]}


def get_current_user():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception as e:
        # NOTE: this used to only catch jwt.PyJWTError. Any other exception
        # (e.g. a different "jwt" package shadowing PyJWT, or a malformed
        # token) escaped unhandled -> Flask returned a 500 for /api/auth/me
        # -> home.js treated ANY non-200 response as "invalid token" and
        # force-logged the user out back to /login, even right after a
        # successful login. Catching broadly + logging avoids that.
        print(f"[AUTH] token decode failed: {type(e).__name__}: {e}")
        return None
    if not isinstance(payload, dict) or payload.get("type") != "access":
        return None
    try:
        return db.get_user_by_id(int(payload["sub"]))
    except Exception as e:
        print(f"[AUTH] get_user_by_id failed: {type(e).__name__}: {e}")
        return None


def gen_otp_code():
    return "".join(random.choices(string.digits, k=6))


def codes_match(a, b):
    return hmac.compare_digest(str(a), str(b))


def get_current_user_id():
    """Return the authenticated user's id (int) or None."""
    user = get_current_user()
    return user["id"] if user else None


@app.before_request
def inject_user_context():
    """Set g.current_user_id from the JWT for every API request.

    NOTE: several blueprints are mounted OUTSIDE the "/api/" prefix
    (e.g. /image_chatbot/api/..., /document_chatbot/api/...,
    /youtube_chatbot/api/..., /smtp/api/...). Gating this on
    request.path.startswith("/api/") silently skipped those, so
    g.current_user_id was always None for them and the per-user
    filtering in scope_blueprint_responses() below could never run.
    We now check for an Authorization header on ANY request instead —
    it's a cheap, side-effect-free JWT decode, so this is safe to do
    unconditionally.
    """
    g.current_user_id = None
    if request.headers.get("Authorization", "").startswith("Bearer "):
        user = get_current_user()
        if user:
            g.current_user_id = user["id"]


# ══════════════════════════════════════════════════════════════════
#  PAGE ROUTES
# ══════════════════════════════════════════════════════════════════

@app.route("/login")
def login_page():
    return render_template(
        "login.html",
        google_client_id=GOOGLE_CLIENT_ID,
        google_callback_uri=url_for("google_callback", _external=True),
    )


@app.route("/")
def home_page():
    # On a normal browser GET there is no Authorization header (tokens live
    # in localStorage). Redirect to /login and let login.js decide: if the
    # user already has a valid token it will bounce them back to / with a
    # query-param marker so we know they're authenticated.
    if request.args.get("authed") == "1":
        # Came back from login.js — render the dashboard.
        return render_template("home.html")
    # Check for Authorization header (API / programmatic access)
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return render_template("home.html")
    # Fresh browser visit — always go to login first.
    return redirect("/login")


# ══════════════════════════════════════════════════════════════════
#  FEATURE PAGE ROUTES
#  One route per Home Dashboard card. Each just renders that
#  feature's existing template — the template pulls in its own
#  existing CSS/JS via the /<path:filename> asset route above.
#  No feature logic is touched here.
# ══════════════════════════════════════════════════════════════════

@app.route("/alarm")
def page_alarm():
    return render_template("alarm.html")

# ══════════════════════════════════════════════════════════════════
#  ALARM API
#  These endpoints work with the alarm module's JSON persistence.
# ══════════════════════════════════════════════════════════════════

@app.route("/api/alarms", methods=["GET"])
def api_get_alarms():
    """Return list of all alarms for the current user."""
    uid = g.current_user_id
    alarms = alarm.api_get_alarms()
    if uid is not None:
        user_ids = set(db.get_user_entities(uid, "alarm"))
        alarms = [a for a in alarms if str(a.get("id")) in user_ids]
    return jsonify({"status": "ok", "alarms": alarms})

@app.route("/api/alarms", methods=["POST"])
def api_create_alarm():
    """Create a new alarm. Expects JSON: { time, ampm, tone, label }."""
    data = request.get_json(force=True, silent=True) or {}
    time_24h = data.get("time")
    ampm = data.get("ampm", "AM")
    tone = data.get("tone", "default")
    label = data.get("label", "Alarm")

    if not time_24h:
        return jsonify({"error": "Time is required."}), 400

    # Convert 12-hour time to 24-hour if needed? The frontend sends "HH:MM" in 12-hour format with separate ampm.
    # The alarm module expects 24-hour "HH:MM". We'll convert here.
    try:
        h, m = map(int, time_24h.split(':'))
        if ampm.upper() == "PM" and h != 12:
            h += 12
        elif ampm.upper() == "AM" and h == 12:
            h = 0
        time_24h_formatted = f"{h:02d}:{m:02d}"
    except Exception:
        return jsonify({"error": "Invalid time format."}), 400

    new_alarm = alarm.api_create_alarm(time_24h_formatted, tone, label)
    # Map the alarm to the current user
    uid = g.current_user_id
    if uid is not None and new_alarm and "id" in new_alarm:
        db.map_feature_entity(uid, "alarm", str(new_alarm["id"]))
    # The API returns the full alarm dict including id
    return jsonify({"status": "ok", "alarm": new_alarm}), 201

@app.route("/api/alarms/<int:alarm_id>", methods=["PUT"])
def api_update_alarm(alarm_id):
    """Update an existing alarm. Expects JSON with any of: time, ampm, tone, label."""
    uid = g.current_user_id
    if uid is not None:
        user_ids = set(db.get_user_entities(uid, "alarm"))
        if str(alarm_id) not in user_ids:
            return jsonify({"error": "Alarm not found."}), 404

    data = request.get_json(force=True, silent=True) or {}
    update_fields = {}

    if "time" in data and "ampm" in data:
        try:
            h, m = map(int, data["time"].split(':'))
            if data["ampm"].upper() == "PM" and h != 12:
                h += 12
            elif data["ampm"].upper() == "AM" and h == 12:
                h = 0
            update_fields["time"] = f"{h:02d}:{m:02d}"
        except Exception:
            return jsonify({"error": "Invalid time format."}), 400

    if "tone" in data:
        update_fields["tone"] = data["tone"]
    if "label" in data:
        update_fields["label"] = data["label"]

    if not update_fields:
        return jsonify({"error": "No fields to update."}), 400

    updated = alarm.api_update_alarm(alarm_id, **update_fields)
    if updated is None:
        return jsonify({"error": "Alarm not found."}), 404

    return jsonify({"status": "ok", "alarm": updated})

@app.route("/api/alarms/<int:alarm_id>", methods=["DELETE"])
def api_delete_alarm(alarm_id):
    """Delete an alarm by ID."""
    uid = g.current_user_id
    if uid is not None:
        user_ids = set(db.get_user_entities(uid, "alarm"))
        if str(alarm_id) not in user_ids:
            return jsonify({"error": "Alarm not found."}), 404

    deleted = alarm.api_delete_alarm(alarm_id)
    if not deleted:
        return jsonify({"error": "Alarm not found."}), 404
    if uid is not None:
        db.unmap_feature_entity(uid, "alarm", str(alarm_id))
    return jsonify({"status": "ok", "message": "Alarm deleted."})

@app.route("/api/alarms/ringing", methods=["GET"])
def api_alarms_ringing():
    """Polled by alarm.js to know when to show the full-screen ringing UI."""
    ringing_alarm = alarm.get_ringing_alarm()
    # Only show ringing alarm if it belongs to the current user
    uid = g.current_user_id
    if ringing_alarm and uid is not None:
        user_ids = set(db.get_user_entities(uid, "alarm"))
        if str(ringing_alarm.get("id")) not in user_ids:
            ringing_alarm = None
    return jsonify({"status": "ok", "ringing": ringing_alarm is not None, "alarm": ringing_alarm})

@app.route("/api/alarms/stop", methods=["POST"])
def api_alarms_stop():
    """Called when the user clicks 'Stop Alarm' on the ringing UI."""
    alarm.api_stop_ringing()
    return jsonify({"status": "ok"})

@app.route("/api/tones", methods=["GET"])
def api_get_tones():
    """Return list of available alarm tones (including 'default')."""
    tones = alarm.api_get_tone_list()
    return jsonify({"status": "ok", "tones": tones})

@app.route("/api/tones/download", methods=["POST"])
def api_download_tone():
    """Download a new tone. Expects JSON: { name }."""
    data = request.get_json(force=True, silent=True) or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Tone name is required."}), 400

    success = alarm.download_tone_by_name(name)
    if success:
        # Refresh the tone list
        tones = alarm.api_get_tone_list()
        return jsonify({"status": "ok", "message": f"Tone '{name}' downloaded.", "tones": tones})
    else:
        return jsonify({"error": f"Failed to download '{name}'. Check the name or your internet connection."}), 500

@app.route("/askanything")
def page_askanything():
    return render_template("askanything.html")


# ══════════════════════════════════════════════════════════════════
#  ASK ANYTHING API
#  ChatGPT-style multi-chat backend: chat CRUD, search, pin/archive,
#  streaming replies, regenerate, and plain-text export. Backed by
#  askanything.py's own SQLite storage (askanything_data.db).
# ══════════════════════════════════════════════════════════════════

@app.route("/api/askanything/chats", methods=["GET"])
def api_askanything_list_chats():
    """List chats. ?q=<search term> filters by title or message content.
    ?archived=true returns the archived list instead of the active one."""
    uid = g.current_user_id
    query = (request.args.get("q") or "").strip()
    archived = (request.args.get("archived") or "").lower() == "true"
    chats = askanything.list_chats(query=query or None, archived_only=archived)
    if uid is not None:
        user_ids = set(db.get_user_entities(uid, "askanything"))
        chats = [c for c in chats if c["id"] in user_ids]
    return jsonify({"status": "ok", "chats": chats})


@app.route("/api/askanything/chats", methods=["POST"])
def api_askanything_create_chat():
    """Create a new, empty chat (New Chat button)."""
    uid = g.current_user_id
    chat = askanything.create_chat()
    if uid is not None:
        db.map_feature_entity(uid, "askanything", chat["id"])
    return jsonify({"status": "ok", "chat": chat}), 201


@app.route("/api/askanything/chats/<chat_id>", methods=["GET"])
def api_askanything_get_chat(chat_id):
    """Fetch one chat with its full message history."""
    chat = askanything.get_chat(chat_id)
    if not chat:
        return jsonify({"error": "Chat not found."}), 404
    return jsonify({"status": "ok", "chat": chat})


@app.route("/api/askanything/chats/<chat_id>", methods=["PUT"])
def api_askanything_rename_chat(chat_id):
    """Rename a chat. Expects JSON: { title }."""
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "Title is required."}), 400
    ok = askanything.rename_chat(chat_id, title)
    if not ok:
        return jsonify({"error": "Chat not found."}), 404
    return jsonify({"status": "ok", "chat": askanything.get_chat(chat_id)})


@app.route("/api/askanything/chats/<chat_id>", methods=["DELETE"])
def api_askanything_delete_chat(chat_id):
    """Permanently delete a chat and its messages."""
    ok = askanything.delete_chat(chat_id)
    if not ok:
        return jsonify({"error": "Chat not found."}), 404
    uid = g.current_user_id
    if uid is not None:
        db.unmap_feature_entity(uid, "askanything", chat_id)
    return jsonify({"status": "ok", "message": "Chat deleted."})


@app.route("/api/askanything/chats/<chat_id>/pin", methods=["POST"])
def api_askanything_pin_chat(chat_id):
    """Pin/unpin a chat. Expects JSON: { pinned: true|false }."""
    if not askanything.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    pinned = bool(data.get("pinned", True))
    askanything.set_pinned(chat_id, pinned)
    return jsonify({"status": "ok", "chat": askanything.get_chat(chat_id)})


@app.route("/api/askanything/chats/<chat_id>/archive", methods=["POST"])
def api_askanything_archive_chat(chat_id):
    """Archive/restore a chat. Expects JSON: { archived: true|false }."""
    if not askanything.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    archived = bool(data.get("archived", True))
    askanything.set_archived(chat_id, archived)
    return jsonify({"status": "ok", "chat": askanything.get_chat(chat_id)})


@app.route("/api/askanything/chats/<chat_id>/download", methods=["GET"])
def api_askanything_download_chat(chat_id):
    """Download a chat transcript as a .txt file."""
    text = askanything.export_chat_text(chat_id)
    if text is None:
        return jsonify({"error": "Chat not found."}), 404
    chat = askanything.get_chat(chat_id)
    safe_name = "".join(c if c.isalnum() or c in " -_" else "_" for c in chat["title"]).strip() or "chat"
    return Response(
        text,
        mimetype="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.txt"'},
    )


@app.route("/api/askanything/chats/<chat_id>/messages", methods=["POST"])
def api_askanything_send_message(chat_id):
    """Send a user message and stream the AI reply back as plain text
    chunks (read via the fetch ReadableStream API on the frontend)."""
    if not askanything.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "Message is required."}), 400
    return Response(
        stream_with_context(askanything.stream_reply(chat_id, message)),
        mimetype="text/plain",
    )


@app.route("/api/askanything/chats/<chat_id>/regenerate", methods=["POST"])
def api_askanything_regenerate(chat_id):
    """Regenerate the last AI reply in a chat, streamed the same way as a
    normal message send."""
    if not askanything.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    return Response(
        stream_with_context(askanything.regenerate_reply(chat_id)),
        mimetype="text/plain",
    )





@app.route("/snetch")
def page_snetch_assistant():
    return render_template("snetch_assistant.html")

    

@app.route("/askbygoogle")
def page_askbygoogle():
    return render_template("askbygoogle.html")


# ── ASK BY GOOGLE API ────────────────────────────────────────────────────────

@app.route("/api/askbygoogle/search", methods=["POST"])
def api_askbygoogle_search():
    """Optimise the user's raw query and return a Google Search URL.
    The frontend opens that URL automatically so the user lands directly
    on the Google results page.

    Request JSON: { "query": "<raw user input>" }
    Response JSON:
        { "status": "ok", "original": "...", "optimized": "...", "url": "https://www.google.com/search?q=..." }
    """
    import askbygoogle as abg
    data = request.get_json(force=True, silent=True) or {}
    raw = (data.get("query") or "").strip()
    if not raw:
        return jsonify({"error": "Query is required."}), 400

    optimized = abg.optimize_query(raw)
    url = abg.get_google_url(optimized)
    return jsonify({
        "status": "ok",
        "original": raw,
        "optimized": optimized,
        "url": url,
    })


@app.route("/countingset")
def page_countingset():
    return render_template("countingset.html")


@app.route("/dailytask")
def page_dailytask():
    return render_template("dailytask.html")


@app.route("/api/dailytask/tasks", methods=["GET"])
def api_dailytask_get_tasks():
    """List every saved task for the current user."""
    uid = g.current_user_id
    tasks = dailytask.api_get_tasks()
    if uid is not None:
        user_ids = set(db.get_user_entities(uid, "dailytask"))
        tasks = [t for t in tasks if str(t.get("id")) in user_ids]
    return jsonify({"status": "ok", "tasks": tasks})


@app.route("/api/dailytask/tasks", methods=["POST"])
def api_dailytask_create_task():
    """Create a new task (Set Task). Expects JSON:
    { task_name, start, end, tones: [filename, ...], skip: bool }
    `tones` is the ordered, multi-select task-tone playlist; `skip`
    means no background task music at all."""
    data = request.get_json(force=True, silent=True) or {}
    task_name = (data.get("task_name") or "").strip()
    start = (data.get("start") or "").strip()
    end = (data.get("end") or "").strip()
    tones = data.get("tones")
    if tones is None:
        # backward compatible single-tone field
        legacy_tone = data.get("tone", "")
        tones = [legacy_tone] if legacy_tone else []
    skip = bool(data.get("skip", False))

    if not task_name:
        return jsonify({"error": "Task name is required."}), 400
    if not start:
        return jsonify({"error": "Start time is required."}), 400

    try:
        task = dailytask.api_create_task(task_name, start, end, tones=tones, skip=skip)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    uid = g.current_user_id
    if uid is not None and task and "id" in task:
        db.map_feature_entity(uid, "dailytask", str(task["id"]))
    return jsonify({"status": "ok", "task": task}), 201


@app.route("/api/dailytask/tasks/<int:task_id>", methods=["PUT"])
def api_dailytask_update_task(task_id):
    """Update an existing task (Update Task). Expects JSON with any of:
    { task_name, start, end, tones: [filename, ...], skip, keep_tone }.
    keep_tone=true leaves the existing playlist completely untouched
    (historical "Skip during Update" behavior)."""
    data = request.get_json(force=True, silent=True) or {}
    keep_tone = bool(data.get("keep_tone", False))
    skip = bool(data.get("skip", False))
    tones = data.get("tones")
    if tones is None and "tone" in data:
        # backward compatible single-tone field
        legacy_tone = data.get("tone", "")
        tones = [legacy_tone] if legacy_tone else []

    updated = dailytask.api_update_task(
        task_id,
        task_name=data.get("task_name"),
        start=data.get("start"),
        end=data.get("end"),
        tones=tones,
        keep_tone=keep_tone,
        skip=skip,
    )
    if updated is None:
        return jsonify({"error": "Task not found."}), 404

    return jsonify({"status": "ok", "task": updated})


@app.route("/api/dailytask/tasks/delete", methods=["POST"])
def api_dailytask_delete_tasks():
    """Delete any number of tasks by id (Delete Task). Expects JSON:
    { ids: [id, id, ...] }."""
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids", [])
    uid = g.current_user_id
    if uid is not None:
        user_ids = set(db.get_user_entities(uid, "dailytask"))
        ids = [i for i in ids if str(i) in user_ids]
    removed = dailytask.api_delete_tasks(ids)
    if uid is not None:
        db.unmap_feature_entities(uid, "dailytask", [str(i) for i in ids])
    return jsonify({"status": "ok", "deleted": removed})


@app.route("/api/dailytask/tones", methods=["GET"])
def api_dailytask_get_tones():
    """List every selectable stored task tone (Task Tone List picker).
    The reserved task_tone/fire_alarm.mp3 warning tone is never included
    here — it is served only via /api/dailytask/fire-alarm."""
    return jsonify({"status": "ok", "tones": dailytask.api_get_tone_list()})


@app.route("/api/dailytask/tones/download", methods=["POST"])
def api_dailytask_download_tone():
    """Download a new task tone (Download Task Tone). Expects JSON:
    { name: str }. Blocks until the download fully completes; the
    frontend keeps its Save button disabled until this responds ok."""
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    result = dailytask.download_tone_by_name(name)
    if not result.get("ok"):
        return jsonify({"error": result.get("error") or "Download failed."}), 400
    return jsonify({"status": "ok", "filename": result.get("filename", "")})


@app.route("/api/dailytask/fire-alarm", methods=["GET"])
def api_dailytask_fire_alarm():
    """
    Return the reserved Task Start/End Warning tone
    (alarm_tone/fire_alarm.mp3) as a base64 data URI. This tone is NEVER
    part of api_get_tone_list()'s Task Tone List — it is fetched
    separately and played only by the Task Dashboard engine, exactly 2
    seconds before a task starts and exactly 2 seconds before it ends.
    """
    return jsonify({"status": "ok", **dailytask.api_get_fire_alarm()})


@app.route("/document_chatbot")
def page_document_chatbot():
    return render_template("document_chatbot.html")


@app.route("/downloadvideo")
def page_downloadvideo():
    return render_template("downloadvideo.html")


@app.route("/download_entertainment")
def page_download_entertainment():
    return render_template("download_entertainment.html")


@app.route("/Entertainment")
def page_entertainment():
    return render_template("Entertainment.html")


# ══════════════════════════════════════════════════════════════════
#  ENTERTAINMENT AI API
#  ChatGPT-style multi-chat backend for the Entertainment feature:
#  chat CRUD, search, pin/archive, streaming replies (text + premium
#  image cards), regenerate, and plain-text export. Backed by
#  Entertainment.py's TMDB engine + its own SQLite storage
#  (entertainment_data.db). Mirrors the /api/askanything/* routes above.
# ══════════════════════════════════════════════════════════════════

@app.route("/api/entertainment/chats", methods=["GET"])
def api_entertainment_list_chats():
    uid = g.current_user_id
    query = (request.args.get("q") or "").strip()
    archived = (request.args.get("archived") or "").lower() == "true"
    chats = Entertainment.list_chats(query=query or None, archived_only=archived)
    if uid is not None:
        user_ids = set(db.get_user_entities(uid, "entertainment"))
        chats = [c for c in chats if c["id"] in user_ids]
    return jsonify({"status": "ok", "chats": chats})


@app.route("/api/entertainment/chats", methods=["POST"])
def api_entertainment_create_chat():
    uid = g.current_user_id
    chat = Entertainment.create_chat()
    if uid is not None:
        db.map_feature_entity(uid, "entertainment", chat["id"])
    return jsonify({"status": "ok", "chat": chat}), 201


@app.route("/api/entertainment/chats/<chat_id>", methods=["GET"])
def api_entertainment_get_chat(chat_id):
    chat = Entertainment.get_chat(chat_id)
    if not chat:
        return jsonify({"error": "Chat not found."}), 404
    return jsonify({"status": "ok", "chat": chat})


@app.route("/api/entertainment/chats/<chat_id>", methods=["PUT"])
def api_entertainment_rename_chat(chat_id):
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "Title is required."}), 400
    ok = Entertainment.rename_chat(chat_id, title)
    if not ok:
        return jsonify({"error": "Chat not found."}), 404
    return jsonify({"status": "ok", "chat": Entertainment.get_chat(chat_id)})


@app.route("/api/entertainment/chats/<chat_id>", methods=["DELETE"])
def api_entertainment_delete_chat(chat_id):
    ok = Entertainment.delete_chat(chat_id)
    if not ok:
        return jsonify({"error": "Chat not found."}), 404
    uid = g.current_user_id
    if uid is not None:
        db.unmap_feature_entity(uid, "entertainment", chat_id)
    return jsonify({"status": "ok", "message": "Chat deleted."})


@app.route("/api/entertainment/chats/<chat_id>/pin", methods=["POST"])
def api_entertainment_pin_chat(chat_id):
    if not Entertainment.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    pinned = bool(data.get("pinned", True))
    Entertainment.set_pinned(chat_id, pinned)
    return jsonify({"status": "ok", "chat": Entertainment.get_chat(chat_id)})


@app.route("/api/entertainment/chats/<chat_id>/archive", methods=["POST"])
def api_entertainment_archive_chat(chat_id):
    if not Entertainment.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    archived = bool(data.get("archived", True))
    Entertainment.set_archived(chat_id, archived)
    return jsonify({"status": "ok", "chat": Entertainment.get_chat(chat_id)})


@app.route("/api/entertainment/chats/<chat_id>/download", methods=["GET"])
def api_entertainment_download_chat(chat_id):
    text = Entertainment.export_chat_text(chat_id)
    if text is None:
        return jsonify({"error": "Chat not found."}), 404
    chat = Entertainment.get_chat(chat_id)
    safe_name = "".join(c if c.isalnum() or c in " -_" else "_" for c in chat["title"]).strip() or "chat"
    return Response(
        text,
        mimetype="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.txt"'},
    )


@app.route("/api/entertainment/chats/<chat_id>/messages", methods=["POST"])
def api_entertainment_send_message(chat_id):
    if not Entertainment.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "Message is required."}), 400
    return Response(
        stream_with_context(Entertainment.stream_reply(chat_id, message)),
        mimetype="text/plain",
    )


@app.route("/api/entertainment/chats/<chat_id>/regenerate", methods=["POST"])
def api_entertainment_regenerate(chat_id):
    if not Entertainment.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    return Response(
        stream_with_context(Entertainment.regenerate_reply(chat_id)),
        mimetype="text/plain",
    )


@app.route("/filesystem")
def page_filesystem():
    return render_template("filesystem.html")


@app.route("/foodrecipe")
def page_foodrecipe():
    return render_template("foodrecipe.html")


@app.route("/api/foodrecipe/chats", methods=["GET"])
def api_foodrecipe_list_chats():
    uid = g.current_user_id
    query = (request.args.get("q") or "").strip()
    archived = (request.args.get("archived") or "").lower() == "true"
    chats = foodracipie.list_chats(query=query or None, archived_only=archived)
    if uid is not None:
        user_ids = set(db.get_user_entities(uid, "foodrecipe"))
        chats = [c for c in chats if c["id"] in user_ids]
    return jsonify({"status": "ok", "chats": chats})

@app.route("/api/foodrecipe/chats", methods=["POST"])
def api_foodrecipe_create_chat():
    uid = g.current_user_id
    chat = foodracipie.create_chat()
    if uid is not None:
        db.map_feature_entity(uid, "foodrecipe", chat["id"])
    return jsonify({"status": "ok", "chat": chat}), 201

@app.route("/api/foodrecipe/chats/<chat_id>", methods=["GET"])
def api_foodrecipe_get_chat(chat_id):
    chat = foodracipie.get_chat(chat_id)
    if not chat:
        return jsonify({"error": "Chat not found."}), 404
    return jsonify({"status": "ok", "chat": chat})

@app.route("/api/foodrecipe/chats/<chat_id>", methods=["PUT"])
def api_foodrecipe_rename_chat(chat_id):
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "Title is required."}), 400
    ok = foodracipie.rename_chat(chat_id, title)
    if not ok:
        return jsonify({"error": "Chat not found."}), 404
    return jsonify({"status": "ok", "chat": foodracipie.get_chat(chat_id)})

@app.route("/api/foodrecipe/chats/<chat_id>", methods=["DELETE"])
def api_foodrecipe_delete_chat(chat_id):
    ok = foodracipie.delete_chat(chat_id)
    if not ok:
        return jsonify({"error": "Chat not found."}), 404
    uid = g.current_user_id
    if uid is not None:
        db.unmap_feature_entity(uid, "foodrecipe", chat_id)
    return jsonify({"status": "ok", "message": "Chat deleted."})

@app.route("/api/foodrecipe/chats/<chat_id>/pin", methods=["POST"])
def api_foodrecipe_pin_chat(chat_id):
    if not foodracipie.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    foodracipie.set_pinned(chat_id, bool(data.get("pinned", True)))
    return jsonify({"status": "ok", "chat": foodracipie.get_chat(chat_id)})

@app.route("/api/foodrecipe/chats/<chat_id>/archive", methods=["POST"])
def api_foodrecipe_archive_chat(chat_id):
    if not foodracipie.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    foodracipie.set_archived(chat_id, bool(data.get("archived", True)))
    return jsonify({"status": "ok", "chat": foodracipie.get_chat(chat_id)})

@app.route("/api/foodrecipe/chats/<chat_id>/download", methods=["GET"])
def api_foodrecipe_download_chat(chat_id):
    text = foodracipie.export_chat_markdown(chat_id)
    if text is None:
        return jsonify({"error": "Chat not found."}), 404
    chat = foodracipie.get_chat(chat_id)
    safe_name = "".join(c if c.isalnum() or c in " -_" else "_" for c in chat["title"]).strip() or "recipe"
    return Response(text, mimetype="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.md"'})

@app.route("/api/foodrecipe/chats/<chat_id>/messages", methods=["POST"])
def api_foodrecipe_send_message(chat_id):
    if not foodracipie.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "Message is required."}), 400
    return Response(stream_with_context(foodracipie.stream_reply(chat_id, message)), mimetype="text/plain")

@app.route("/api/foodrecipe/chats/<chat_id>/regenerate", methods=["POST"])
def api_foodrecipe_regenerate(chat_id):
    if not foodracipie.chat_exists(chat_id):
        return jsonify({"error": "Chat not found."}), 404
    return Response(stream_with_context(foodracipie.regenerate_reply(chat_id)), mimetype="text/plain")

@app.route("/horoscopeapi")
def page_horoscopeapi():
    return render_template("horoscopeapi.html")


# ══════════════════════════════════════════════════════════════════
#  AI ASTROLOGY ASSISTANT API
#  Session-based consultation: personal details -> verify/confirm ->
#  main question -> 5 AI-generated follow-up questions (asked one by
#  one) -> streamed final reading -> free-form follow-up chat.
#  Backed by horoscopeapi.py's own SQLite storage (horoscope_data.db).
# ══════════════════════════════════════════════════════════════════

@app.route("/api/horoscope/sessions", methods=["POST"])
def api_horoscope_create_session():
    """Start a new astrology consultation session (Start Astrology Reading)."""
    uid = g.current_user_id
    state = horoscopeapi.create_session()
    if uid is not None:
        db.map_feature_entity(uid, "horoscope", state["id"])
    return jsonify({"status": "ok", "session": state}), 201


@app.route("/api/horoscope/sessions/<session_id>", methods=["GET"])
def api_horoscope_get_session(session_id):
    """Fetch the current session state + full message history (used to
    restore the correct screen/step after a page refresh)."""
    state = horoscopeapi.get_session(session_id)
    if not state:
        return jsonify({"error": "Session not found."}), 404
    return jsonify({"status": "ok", "session": state})


@app.route("/api/horoscope/sessions/<session_id>/details", methods=["POST"])
def api_horoscope_save_details(session_id):
    """STEP 1-5: save Full Name, Date of Birth, Zodiac Sign, Birth Place,
    Birth Time. Expects JSON: { name, dob, zodiac, birth_place, birth_time }."""
    if not horoscopeapi.session_exists(session_id):
        return jsonify({"error": "Session not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    dob = (data.get("dob") or "").strip()
    zodiac = (data.get("zodiac") or "").strip()
    birth_place = (data.get("birth_place") or "").strip()
    birth_time = (data.get("birth_time") or "").strip()

    if not name or not dob or not zodiac or not birth_place:
        return jsonify({"error": "Full Name, Date of Birth, Zodiac Sign and Birth Place are required."}), 400
    if zodiac.capitalize() not in horoscopeapi.ZODIAC_SIGNS:
        return jsonify({"error": "Please choose a valid zodiac sign."}), 400

    state = horoscopeapi.save_details(session_id, name, dob, birth_time, birth_place, zodiac)
    return jsonify({"status": "ok", "session": state})


@app.route("/api/horoscope/sessions/<session_id>/confirm", methods=["POST"])
def api_horoscope_confirm(session_id):
    """VERIFY DETAILS -> Confirm: locks the profile and opens the chat with
    the "What would you like to know?" prompt."""
    state = horoscopeapi.get_session(session_id)
    if not state:
        return jsonify({"error": "Session not found."}), 404
    if state["status"] not in ("awaiting_confirm", "awaiting_query"):
        return jsonify({"error": "Please complete all details before confirming."}), 400
    state = horoscopeapi.confirm_details(session_id)
    return jsonify({"status": "ok", "session": state})


@app.route("/api/horoscope/sessions/<session_id>/edit", methods=["POST"])
def api_horoscope_edit(session_id):
    """VERIFY DETAILS -> Edit: send the user back to Step 1."""
    if not horoscopeapi.session_exists(session_id):
        return jsonify({"error": "Session not found."}), 404
    state = horoscopeapi.reset_to_details(session_id)
    return jsonify({"status": "ok", "session": state})


@app.route("/api/horoscope/sessions/<session_id>/messages", methods=["POST"])
def api_horoscope_send_message(session_id):
    """The single chat-driver endpoint: submits the user's main question,
    each follow-up answer, or free-form chat after the reading — and
    streams the AI's next message back as plain text chunks."""
    if not horoscopeapi.session_exists(session_id):
        return jsonify({"error": "Session not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "Message is required."}), 400
    return Response(
        stream_with_context(horoscopeapi.stream_message(session_id, message)),
        mimetype="text/plain",
    )


@app.route("/api/horoscope/sessions/<session_id>/regenerate", methods=["POST"])
def api_horoscope_regenerate(session_id):
    """Regenerate the last AI message (a follow-up question or the final
    reading), streamed the same way as a normal message send."""
    if not horoscopeapi.session_exists(session_id):
        return jsonify({"error": "Session not found."}), 404
    return Response(
        stream_with_context(horoscopeapi.regenerate_last(session_id)),
        mimetype="text/plain",
    )


@app.route("/api/horoscope/sessions/<session_id>/messages/<int:message_id>/feedback", methods=["POST"])
def api_horoscope_feedback(session_id, message_id):
    """Like / dislike a message. Expects JSON: { rating: 'like'|'dislike'|'' }."""
    if not horoscopeapi.session_exists(session_id):
        return jsonify({"error": "Session not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    rating = (data.get("rating") or "").strip().lower()
    if rating not in ("like", "dislike", ""):
        return jsonify({"error": "Invalid rating."}), 400
    ok = horoscopeapi.set_feedback(session_id, message_id, rating)
    if not ok:
        return jsonify({"error": "Message not found."}), 404
    return jsonify({"status": "ok"})

@app.route("/imagecreater")
def page_imagecreater():
    return render_template("imagecreater.html")


# ══════════════════════════════════════════════════════════════════
#  IMAGE CREATOR — API (imagecreater.py)
#  One batch = one "New Image Generator" session. Real images are
#  searched and downloaded one at a time so the frontend can display
#  them live as each finishes, and stay entirely in-app until the
#  user explicitly downloads them.
# ══════════════════════════════════════════════════════════════════

@app.route("/api/imagecreater/new", methods=["POST"])
def api_imagecreater_new():
    old_batch = session.get("imagecreater_batch_id")
    if old_batch:
        imagecreater.clear_batch(old_batch)
    batch_id = imagecreater.start_new_batch()
    session["imagecreater_batch_id"] = batch_id
    return jsonify({"batch_id": batch_id})


@app.route("/api/imagecreater/generate", methods=["POST"])
def api_imagecreater_generate():
    data = request.get_json(force=True, silent=True) or {}
    batch_id = data.get("batch_id", "")
    prompt = data.get("prompt", "")
    index = data.get("index", 1)
    count = data.get("count", 1)

    if not imagecreater.is_valid_batch_id(batch_id) or batch_id != session.get("imagecreater_batch_id"):
        return jsonify({"error": "Session expired. Please start a New Image Generator session."}), 400

    try:
        index = int(index)
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid image index."}), 400
    if index < 1 or index > imagecreater.MAX_IMAGES_PER_BATCH:
        return jsonify({
            "error": f"Number of images must be between 1 and {imagecreater.MAX_IMAGES_PER_BATCH}."
        }), 400

    try:
        count = int(count)
    except (TypeError, ValueError):
        count = index
    count = max(1, min(count, imagecreater.MAX_IMAGES_PER_BATCH))

    try:
        image_bytes, ext = imagecreater.download_next_image(batch_id, prompt, index, count)
        filename = imagecreater.save_image(batch_id, index, image_bytes, ext)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except imagecreater.NoMoreImagesError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        print(f"[imagecreater] download error: {e}")
        return jsonify({"error": "Could not download this image. Please try again."}), 500

    return jsonify({
        "filename": filename,
        "index": index,
        "url": url_for("api_imagecreater_view", batch_id=batch_id, filename=filename),
    })


@app.route("/api/imagecreater/view/<batch_id>/<filename>")
def api_imagecreater_view(batch_id, filename):
    # NOTE: this used to skip the session-ownership check that /generate,
    # /delete, and /download-all already enforce below — meaning anyone who
    # learned a batch_id + filename (e.g. from a shared screenshot, referrer
    # header, or guessed UUID) could view another account's generated
    # images. Now consistent with the other batch routes.
    if (not imagecreater.is_valid_batch_id(batch_id) or not imagecreater.is_valid_filename(filename)
            or batch_id != session.get("imagecreater_batch_id")):
        abort(404)
    folder = imagecreater.batch_dir(batch_id)
    if not os.path.isfile(os.path.join(folder, filename)):
        abort(404)
    return send_from_directory(folder, filename, as_attachment=False)


@app.route("/api/imagecreater/download/<batch_id>/<filename>")
def api_imagecreater_download(batch_id, filename):
    if (not imagecreater.is_valid_batch_id(batch_id) or not imagecreater.is_valid_filename(filename)
            or batch_id != session.get("imagecreater_batch_id")):
        abort(404)
    folder = imagecreater.batch_dir(batch_id)
    filepath = os.path.join(folder, filename)
    if not os.path.isfile(filepath):
        abort(404)
    response = send_from_directory(
        folder, filename, as_attachment=True,
        download_name=imagecreater.download_filename(batch_id, filename),
    )
    # Delete right after this response is fully sent to the browser
    @response.call_on_close
    def _delete_after_download():
        try:
            os.remove(filepath)
        except OSError:
            pass
    return response


@app.route("/api/imagecreater/delete", methods=["POST"])
def api_imagecreater_delete():
    data = request.get_json(force=True, silent=True) or {}
    batch_id = data.get("batch_id", "")
    filename = data.get("filename", "")

    if not imagecreater.is_valid_batch_id(batch_id) or batch_id != session.get("imagecreater_batch_id"):
        return jsonify({"error": "Invalid session."}), 400
    try:
        deleted = imagecreater.delete_image(batch_id, filename)
    except ValueError:
        return jsonify({"error": "Invalid filename."}), 400
    return jsonify({"deleted": deleted})


@app.route("/api/imagecreater/download-all/<batch_id>")
def api_imagecreater_download_all(batch_id):
    if not imagecreater.is_valid_batch_id(batch_id) or batch_id != session.get("imagecreater_batch_id"):
        abort(404)
    buffer = imagecreater.zip_batch(batch_id)
    label = imagecreater.sanitize_filename_part(imagecreater.get_batch_query(batch_id))
    return Response(
        buffer.getvalue(),
        mimetype="application/zip",
        headers={"Content-Disposition": f"attachment; filename={label}_Images.zip"},
    )


@app.route("/image_chatbot")
def page_image_chatbot():
    return render_template("image_chatbot.html")



# ---- routes (kisi bhi convenient jagah, deepfake routes ke paas) ----
@app.route("/barcode_qr_scanner")
def page_barcode_qr_scanner():
    return render_template("barcode_qr_scanner.html")

@app.route("/api/barcode_qr/scan", methods=["POST"])
def api_barcode_qr_scan():
    return barcode_qr_scanner.handle_upload()

@app.route("/api/barcode_qr/scan_webcam", methods=["POST"])
def api_barcode_qr_scan_webcam():
    return barcode_qr_scanner.handle_webcam_frame()





@app.route("/latestnews")
def page_latestnews():
    return render_template("latestnews.html")


@app.route("/api/latestnews", methods=["GET"])
def api_latestnews():
    query = request.args.get("q", None)
    if query is None or not query.strip():
        return jsonify({
            "status": "error",
            "error_type": "empty_query",
            "message": "Please enter or speak a news topic to search."
        }), 400

    try:
        result = latestnews.get_latest_news(query)
        return jsonify({
            "status": "ok",
            "label": result["label"],
            "topic": result["topic"],
            "count": len(result["articles"]),
            "articles": result["articles"],
        })
    except latestnews.InvalidQueryError as e:
        return jsonify({"status": "error", "error_type": "invalid_query", "message": str(e)}), 400
    except latestnews.NewsNetworkError as e:
        return jsonify({"status": "error", "error_type": "network_error", "message": str(e)}), 503
    except latestnews.NoNewsFoundError as e:
        return jsonify({"status": "error", "error_type": "no_news", "message": str(e)}), 404
    except Exception:
        return jsonify({
            "status": "error",
            "error_type": "server_error",
            "message": "Something went wrong while fetching the news. Please try again."
        }), 500


@app.route("/location")
def page_location():
    return render_template("location.html")


@app.route("/api/location/query", methods=["POST"])
def api_location_query():
    """Maps & Navigation AI — parses a natural-language query (optionally
    with the user's real device lat/lon from the browser Geolocation API)
    and returns structured JSON for the frontend to render as a result card."""
    data = request.get_json(force=True, silent=True) or {}
    text = (data.get("text") or "").strip()
    lat = data.get("lat")
    lon = data.get("lon")
    try:
        lat = float(lat) if lat is not None else None
        lon = float(lon) if lon is not None else None
    except (TypeError, ValueError):
        lat, lon = None, None

    if not text:
        return jsonify({"type": "error", "code": "speech_recognition_failed",
                         "message": "I didn't catch that. Could you try asking again?"}), 400

    try:
        result = location.handle_query(text, lat, lon)
    except Exception as e:
        print(f"[location] query error: {e}")
        return jsonify({"type": "error", "code": "no_internet",
                         "message": "Something went wrong reaching the maps service. Please try again."}), 500

    return jsonify(result)


@app.route("/openanyapp")
def page_openanyapp():
    return render_template("openanyapp.html")


# ── "Launch Apps" feature — search + launch installed applications ──
@app.route("/api/openanyapp/search", methods=["POST"])
def api_openanyapp_search():
    data = request.get_json(silent=True) or {}
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({
            "status": "not_found",
            "message": "Please tell me which application to open.",
        })
    result = openanyapp.decide_match(query)
    return jsonify(result)


@app.route("/api/openanyapp/launch", methods=["POST"])
def api_openanyapp_launch():
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    name = (data.get("name") or "").strip()
    if not path:
        return jsonify({"success": False, "message": "No application path was provided."}), 400
    result = openanyapp.launch_app(path)
    result.setdefault("name", name)
    return jsonify(result), (200 if result.get("success") else 500)


@app.route("/openanybrowser")
def page_openanybrowser():
    return render_template("openanybrowser.html")


# ── "Open Browser" feature — smart browser / website launcher ──
@app.route("/api/openanybrowser/search", methods=["POST"])
def api_openanybrowser_search():
    data = request.get_json(silent=True) or {}
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({
            "status": "not_found",
            "message": "Please tell me which browser or website to open.",
        })
    result = openanybrowser.decide_match(query)
    return jsonify(result)


@app.route("/api/openanybrowser/launch", methods=["POST"])
def api_openanybrowser_launch():
    data = request.get_json(silent=True) or {}
    match = {
        "type": (data.get("type") or "").strip(),
        "name": (data.get("name") or "").strip(),
        "target": (data.get("target") or "").strip(),
    }
    if not match["type"] or not match["target"]:
        return jsonify({"success": False, "message": "No browser or website was specified."}), 400
    result = openanybrowser.launch(match)
    return jsonify(result), (200 if result.get("success") else 500)


@app.route("/passwordsave")
def page_passwordsave():
    return render_template("passwordsave.html")

@app.route("/snaplock")
def page_snaplock():
    return render_template("snaplock.html")
    

@app.route("/real_world_information")
def page_real_world_information():
    return render_template("real_world_information.html")


@app.route("/api/real_world_information/ask", methods=["POST"])
def api_real_world_information_ask():
    payload = request.get_json(silent=True) or {}
    question = (payload.get("question") or "").strip()

    if not question:
        return jsonify({"success": False, "error": "Please enter a question before submitting."}), 400

    try:
        result = real_world_information.get_ai_answer(question)
    except Exception as e:
        return jsonify({"success": False, "error": f"Backend error: {e}"}), 500

    status_code = 200 if result.get("success") else 502
    return jsonify(result), status_code



@app.route("/reminder")
def page_reminder():
    return render_template("reminder.html")


# ══════════════════════════════════════════════════════════════════
#  REMINDER API
#  Backed by reminder.py's SQLite storage (db_storage/reminder_data.db)
#  and its reminder_tone/ folder. Mirrors the alarm/dailytask API
#  pattern used elsewhere in this project.
# ══════════════════════════════════════════════════════════════════

@app.route("/api/reminders", methods=["GET"])
def api_get_reminders():
    """Return every saved reminder for the current user, soonest first."""
    uid = g.current_user_id
    reminders = reminder.api_get_reminders()
    if uid is not None:
        user_ids = set(db.get_user_entities(uid, "reminder"))
        reminders = [r for r in reminders if str(r.get("id")) in user_ids]
    return jsonify({"status": "ok", "reminders": reminders})


@app.route("/api/reminders/upcoming", methods=["GET"])
def api_reminders_upcoming():
    """Return the single nearest reminder for the Upcoming Reminder panel."""
    uid = g.current_user_id
    upcoming = reminder.api_get_upcoming()
    # Only show upcoming reminder if it belongs to the current user
    if upcoming and uid is not None:
        user_ids = set(db.get_user_entities(uid, "reminder"))
        if str(upcoming.get("id")) not in user_ids:
            upcoming = None
    return jsonify({"status": "ok", "upcoming": upcoming})


@app.route("/api/reminders", methods=["POST"])
def api_create_reminder():
    """Create a new reminder (Set Reminder). Expects JSON:
    { name, hour, minute, ampm, day, month, year, tone }"""
    data = request.get_json(force=True, silent=True) or {}
    try:
        new_reminder = reminder.api_create_reminder(
            name=data.get("name"),
            hour=data.get("hour"),
            minute=data.get("minute"),
            ampm=data.get("ampm"),
            day=data.get("day"),
            month=data.get("month"),
            year=data.get("year"),
            tone=data.get("tone", ""),
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    uid = g.current_user_id
    if uid is not None and new_reminder and "id" in new_reminder:
        db.map_feature_entity(uid, "reminder", str(new_reminder["id"]))
    return jsonify({"status": "ok", "reminder": new_reminder}), 201


@app.route("/api/reminders/<int:reminder_id>", methods=["PUT"])
def api_update_reminder(reminder_id):
    """Update an existing reminder (Update Reminder). Expects JSON with any
    of: { name, hour, minute, ampm, day, month, year, tone, keep_tone }.
    keep_tone=true (used when the user picks Skip during Update) leaves the
    previously selected tone untouched."""
    data = request.get_json(force=True, silent=True) or {}
    keep_tone = bool(data.get("keep_tone", False))
    try:
        updated = reminder.api_update_reminder(
            reminder_id,
            name=data.get("name"),
            hour=data.get("hour"),
            minute=data.get("minute"),
            ampm=data.get("ampm"),
            day=data.get("day"),
            month=data.get("month"),
            year=data.get("year"),
            tone=data.get("tone"),
            keep_tone=keep_tone,
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if updated is None:
        return jsonify({"error": "Reminder not found."}), 404
    return jsonify({"status": "ok", "reminder": updated})


@app.route("/api/reminders/delete", methods=["POST"])
def api_delete_reminders():
    """Delete one, many, or all reminders at once (Delete Reminder).
    Expects JSON: { ids: [1, 2, 3] }"""
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids", [])
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "No reminders selected."}), 400

    removed = reminder.api_delete_reminders(ids)
    if removed == 0:
        return jsonify({"error": "No matching reminders found."}), 404

    uid = g.current_user_id
    if uid is not None:
        db.unmap_feature_entities(uid, "reminder", [str(i) for i in ids])
    return jsonify({"status": "ok", "deleted": removed})


@app.route("/api/reminders/<int:reminder_id>/fire", methods=["POST"])
def api_fire_reminder(reminder_id):
    """Called by reminder.js right after the full-screen alert has run its
    10-second cycle for this reminder, so it doesn't fire again."""
    fired = reminder.api_fire_reminder(reminder_id)
    if fired is None:
        return jsonify({"error": "Reminder not found."}), 404
    return jsonify({"status": "ok", "reminder": fired})


@app.route("/api/reminder-tones", methods=["GET"])
def api_get_reminder_tones():
    """Return list of reminder tones stored in reminder_tone/ (default first),
    each including its audio as a base64 data URI so the browser can play it
    directly without a dedicated file-serving route."""
    return jsonify({"status": "ok", "tones": reminder.api_get_tone_list()})


@app.route("/api/reminder-tones/download", methods=["POST"])
def api_download_reminder_tone():
    """Download a new reminder tone. Expects JSON: { name }.
    Blocks until the tone has fully downloaded and saved into
    reminder_tone/, so the frontend can safely enable Save only after a
    successful response (per feature spec)."""
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Tone name is required."}), 400

    result = reminder.download_tone_by_name(name)
    if result["ok"]:
        return jsonify({
            "status": "ok",
            "filename": result["filename"],
            "tones": reminder.api_get_tone_list(),
        })
    return jsonify({"error": result["error"] or "Download failed."}), 500


@app.route("/shoppinglist")
def page_shoppinglist():
    return render_template("shoppinglist.html")


@app.route("/smtp")
def page_smtp():
    return render_template("smtp.html")


@app.route("/songdownload")
def page_songdownload():
    return render_template("songdownload.html")


@app.route("/api/songdownload/search", methods=["POST"])
def api_songdownload_search():
    """Search for the best matching song and return metadata."""
    try:
        payload = request.get_json(silent=True) or {}
        query = (payload.get("query") or "").strip()
        if not query:
            return jsonify({"success": False, "error": "Please enter a song name."}), 400

        data = songdownload.search_song(query)
        return jsonify({"success": True, "data": data})

    except songdownload.SongNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404
    except songdownload.SongDownloadError as exc:
        return jsonify({"success": False, "error": str(exc)}), 502
    except Exception:
        return jsonify({"success": False, "error": "Could not search for that song right now."}), 500


@app.route("/api/songdownload/start", methods=["POST"])
def api_songdownload_start():
    """Start an async download. Returns a download_id for progress polling."""
    try:
        payload = request.get_json(silent=True) or {}
        video_id = (payload.get("video_id") or "").strip()
        title = (payload.get("title") or "song").strip()
        if not video_id:
            return jsonify({"success": False, "error": "Missing video ID."}), 400

        download_id = songdownload.start_download(video_id, title)
        return jsonify({"success": True, "download_id": download_id})

    except songdownload.SongDownloadError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception:
        return jsonify({"success": False, "error": "Failed to start download."}), 500


@app.route("/api/songdownload/progress/<download_id>")
def api_songdownload_progress(download_id):
    """Return real-time progress data for a download."""
    data = songdownload.get_progress(download_id)
    return jsonify(data)



@app.route("/songplay")
def page_songplay():
    return render_template("songplay.html")


@app.route("/api/songplay/search", methods=["POST"])
def api_songplay_search():
    """Find the best-matching song for a free-text query and return
    everything the premium Now Playing UI needs, plus a short rail of
    related matches used to auto-populate the recently-played playlist."""
    try:
        payload = request.get_json(silent=True) or {}
        query = (payload.get("query") or "").strip()
        if not query:
            return jsonify({"success": False, "error": "Please enter a song name."}), 400
 
        data = songplay.search_song(query)
        return jsonify({"success": True, "data": data})
 
    except songplay.SongNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404
    except songplay.SongServiceError as exc:
        return jsonify({"success": False, "error": str(exc)}), 502
    except Exception:
        return jsonify({"success": False, "error": "Could not search for that song right now."}), 500
 
 
@app.route("/api/songplay/stream/<video_id>")
def api_songplay_stream(video_id):
    """Same-origin audio proxy for the <audio> element. Resolves a direct
    (short-lived, CORS-restricted) source URL via songplay.get_audio_stream
    and re-streams the bytes to the browser, forwarding Range requests so
    seeking/scrubbing in the player works correctly."""
    try:
        stream_info = songplay.get_audio_stream(video_id)
    except songplay.SongNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404
    except songplay.SongServiceError as exc:
        return jsonify({"success": False, "error": str(exc)}), 502
    except Exception:
        return jsonify({"success": False, "error": "Playback failed for this song."}), 500
 
    upstream_headers = dict(stream_info["headers"])
    range_header = request.headers.get("Range")
    if range_header:
        upstream_headers["Range"] = range_header
 
    try:
        upstream = requests.get(
            stream_info["url"],
            headers=upstream_headers,
            stream=True,
            timeout=(10, 30),
        )
    except requests.RequestException:
        return jsonify({"success": False, "error": "Network error while streaming this song."}), 502
 
    if upstream.status_code not in (200, 206):
        return jsonify({"success": False, "error": "The audio source rejected the request."}), 502
 
    def _generate():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()
 
    resp_headers = {}
    for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
        if h in upstream.headers:
            resp_headers[h] = upstream.headers[h]
    resp_headers.setdefault("Content-Type", stream_info["mime_type"])
    resp_headers.setdefault("Accept-Ranges", "bytes")
 
    return Response(
        stream_with_context(_generate()),
        status=upstream.status_code,
        headers=resp_headers,
    )






@app.route("/time")
def page_time():
    return render_template("time.html")



@app.route("/api/time/now")
def api_time_now():
    """World Clock feature: authoritative server time for frontend sync."""
    return jsonify(worldclock_backend.get_time_payload())




# ---------- Deepfake Detector ----------
@app.route("/deepfake_detector")
def page_deepfake_detector():
    return render_template("deepfake_detector.html")


@app.route("/api/deepfake/analyze", methods=["POST"])
def api_deepfake_analyze():
    return deepfake_detector.handle_upload()


@app.route("/api/deepfake/analyze_webcam", methods=["POST"])
def api_deepfake_analyze_webcam():
    return deepfake_detector.handle_webcam_frame()


@app.route("/api/deepfake/history", methods=["GET"])
def api_deepfake_history():
    return deepfake_detector.handle_history()


@app.route("/api/deepfake/history/<int:scan_id>", methods=["DELETE"])
def api_deepfake_delete(scan_id):
    return deepfake_detector.handle_delete(scan_id)

@app.route("/api/deepfake/analyze_video", methods=["POST"])
def api_deepfake_analyze_video():
    return deepfake_detector.handle_video_upload()


@app.route("/videoplay")
def page_videoplay():
    return render_template("videoplay.html")


@app.route("/api/videoplay/search", methods=["POST"])
def api_videoplay_search():
    """Find the best-matching YouTube video for a free-text query and
    return everything the embedded YouTube-mode player needs."""
    try:
        payload = request.get_json(silent=True) or {}
        query = (payload.get("query") or "").strip()
        if not query:
            return jsonify({"success": False, "error": "Please enter a video name."}), 400

        data = videoplay.search_video(query)
        return jsonify({"success": True, "data": data})

    except videoplay.VideoNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404
    except videoplay.VideoServiceError as exc:
        return jsonify({"success": False, "error": str(exc)}), 502
    except Exception:
        return jsonify({"success": False, "error": "Could not search for that video right now."}), 500


@app.route("/api/videoplay/related", methods=["POST"])
def api_videoplay_related():
    """Fetch additional related videos for infinite scrolling."""
    try:
        payload = request.get_json(silent=True) or {}
        query = (payload.get("query") or "").strip()
        offset = payload.get("offset", 0)
        limit = payload.get("limit", 10)

        if not query:
            return jsonify({"success": False, "error": "Query required."}), 400

        related = videoplay.get_related_videos(query, offset, limit)
        return jsonify({"success": True, "data": related})

    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/whatsappmessage")
def page_whatsappmessage():
    return render_template("whatsappmessage.html")


@app.route("/wheather")
def page_wheather():
    return render_template("wheather.html")



@app.route("/api/wheather/current")
def api_wheather_current():
    """Auto-detected current-location weather (lat/lon from the browser)."""
    try:
        lat = request.args.get("lat", type=float)
        lon = request.args.get("lon", type=float)
        if lat is None or lon is None:
            return jsonify({"success": False, "error": "lat and lon are required."}), 400
 
        data = wheather.get_weather_by_coords(lat, lon)
        return jsonify({"success": True, "data": data})
 
    except wheather.WeatherServiceError as exc:
        return jsonify({"success": False, "error": str(exc)}), 502
    except Exception as exc:
        return jsonify({"success": False, "error": "Could not fetch current weather."}), 500
 
 
@app.route("/api/wheather/search")
def api_wheather_search():
    """Weather for a searched city name."""
    try:
        city = (request.args.get("city") or "").strip()
        if not city:
            return jsonify({"success": False, "error": "Please enter a city name."}), 400
 
        data = wheather.get_weather_by_city(city)
        return jsonify({"success": True, "data": data})
 
    except wheather.LocationNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404
    except wheather.WeatherServiceError as exc:
        return jsonify({"success": False, "error": str(exc)}), 502
    except Exception:
        return jsonify({"success": False, "error": "Could not fetch weather for that city."}), 500
 
 
@app.route("/weather_sound/<path:filename>")
def serve_weather_sound(filename):
    """
    Serves ambience mp3s for the Weather Center from a top-level
    weather_sound/ folder (mirrors the alarm_tone / reminder_tone
    pattern already used elsewhere in this project):
 
        weather_sound/sunny.mp3
        weather_sound/rainy.mp3
        weather_sound/cloudy.mp3
        weather_sound/windy.mp3
        weather_sound/snowy.mp3
 
    Add your own mp3 files to that folder — this route just serves
    them. The frontend degrades gracefully (silently) if a file is
    missing, so the feature still works with zero audio files.
    """
    folder = os.path.join(BASE_DIR, "weather_sound")
    filepath = os.path.join(folder, filename)
    if os.path.exists(filepath):
        return send_from_directory(folder, filename)
    abort(404)
    

@app.route("/objecttracking")
def page_objecttracking():
    return render_template("objecttracking.html")


@app.route("/api/objecttracking/image", methods=["POST"])
def api_objecttracking_image():
    return objecttracking.handle_image()


@app.route("/api/objecttracking/video/start", methods=["POST"])
def api_objecttracking_video_start():
    return objecttracking.handle_video_start()


@app.route("/api/objecttracking/video/progress/<job_id>", methods=["GET"])
def api_objecttracking_video_progress(job_id):
    return objecttracking.handle_video_progress(job_id)


@app.route("/api/objecttracking/video/cancel/<job_id>", methods=["POST"])
def api_objecttracking_video_cancel(job_id):
    return objecttracking.handle_video_cancel(job_id)


@app.route("/api/objecttracking/video/download/<job_id>", methods=["GET"])
def api_objecttracking_video_download(job_id):
    return objecttracking.handle_video_download(job_id)


@app.route("/api/objecttracking/webcam/start", methods=["POST"])
def api_objecttracking_webcam_start():
    return objecttracking.handle_webcam_start()


@app.route("/api/objecttracking/webcam/process_frame", methods=["POST"])
def api_objecttracking_webcam_process_frame():
    return objecttracking.handle_webcam_process_frame()


@app.route("/api/objecttracking/webcam/feed", methods=["GET"])
def api_objecttracking_webcam_feed():
    return objecttracking.handle_webcam_feed()


@app.route("/api/objecttracking/webcam/stats", methods=["GET"])
def api_objecttracking_webcam_stats():
    return objecttracking.handle_webcam_stats()


@app.route("/api/objecttracking/webcam/stop", methods=["POST"])
def api_objecttracking_webcam_stop():
    return objecttracking.handle_webcam_stop()


@app.route("/face_expression")
def page_face_expression():
    return render_template("face_expression.html")


@app.route("/api/facexpression/image", methods=["POST"])
def api_facexpression_image():
    return face_expression.handle_image()


@app.route("/api/facexpression/video/start", methods=["POST"])
def api_facexpression_video_start():
    return face_expression.handle_video_start()


@app.route("/api/facexpression/video/progress/<job_id>", methods=["GET"])
def api_facexpression_video_progress(job_id):
    return face_expression.handle_video_progress(job_id)


@app.route("/api/facexpression/video/cancel/<job_id>", methods=["POST"])
def api_facexpression_video_cancel(job_id):
    return face_expression.handle_video_cancel(job_id)


@app.route("/api/facexpression/video/download/<job_id>", methods=["GET"])
def api_facexpression_video_download(job_id):
    return face_expression.handle_video_download(job_id)


@app.route("/api/facexpression/webcam/start", methods=["POST"])
def api_facexpression_webcam_start():
    return face_expression.handle_webcam_start()


@app.route("/api/facexpression/webcam/process_frame", methods=["POST"])
def api_facexpression_webcam_process_frame():
    return face_expression.handle_webcam_process_frame()


@app.route("/api/facexpression/webcam/stop", methods=["POST"])
def api_facexpression_webcam_stop():
    return face_expression.handle_webcam_stop()



@app.route("/spaim_mail")
def page_spaim_mail():
    return render_template("spaim_mail.html")


# ── SPAM MAIL CHECKER API ────────────────────────────────────────────────────

@app.route("/api/spaim_mail/check", methods=["POST"])
def api_spaim_mail_check():
    """
    Classify pasted email/message text as spam or ham.

    Request JSON:  { "text": "<email/message content>" }
    Response JSON: see spaim_mail.check_email() for the full shape.
    """
    import spaim_mail

    data = request.get_json(force=True, silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"success": False, "error": "Please paste an email or message first."}), 400

    result = spaim_mail.check_email(text)
    status_code = 200 if result.get("success") else 400
    return jsonify(result), status_code


@app.route("/wikipedia")
def page_wikipedia():
    return render_template("wikipedia.html")




# ── WIKIPEDIA AI ASSISTANT API ───────────────────────────────────────────────
 
@app.route("/api/wikipedia/search", methods=["POST"])
def api_wikipedia_search():
    """Resolve a natural-language question to a Wikipedia article and return
    a structured, ready-to-render answer.
 
    Request JSON:  { "query": "<user question>" }
    Response JSON: see wikipidea.ask_wikipidia() for the full shape. Always
    includes a "status" field so the frontend can branch on
    ok / empty / not_found / ambiguous / error without guessing.
    """
    import wikipidea
 
    data = request.get_json(force=True, silent=True) or {}
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({"status": "empty", "message": "Please type or say a question first."}), 400
 
    result = wikipidea.ask_wikipidia(query)
    status_code = 200 if result.get("status") in ("ok", "ambiguous") else \
        404 if result.get("status") == "not_found" else \
        400 if result.get("status") == "empty" else \
        502
    return jsonify(result), status_code






@app.route("/youtube_chatbot")
def page_youtube_chatbot():
    return render_template("youtube_chatbot.html")


# ══════════════════════════════════════════════════════════════════
#  AUTH API
# ══════════════════════════════════════════════════════════════════

@app.route("/api/auth/register", methods=["POST"])
def api_register():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not email or "@" not in email:
        return jsonify({"error": "Please enter a valid email."}), 400
    if len(username) < 2:
        return jsonify({"error": "Username must be at least 2 characters."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400

    try:
        db.create_or_update_pending_user(email, username, generate_password_hash(password))
    except ValueError:
        return jsonify({"error": "Email already registered. Please sign in instead."}), 409

    code = gen_otp_code()
    db.create_otp(email, code, purpose="verify_email")
    email_utils.send_otp_email(email, code, purpose="verify_email")

    # Init user settings for the pending user
    pending = db.get_user_by_email(email)
    if pending:
        db.init_user_settings(pending["id"])

    return jsonify({"status": "otp_sent", "message": "Verification code sent to your email."})


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if not email or "@" not in email or len(password) < 6:
        return jsonify({"error": "Please enter a valid email and password."}), 400

    user = db.get_user_by_email(email)

    if user and user["failed_attempts"] >= MAX_LOGIN_ATTEMPTS:
        return jsonify({
            "error": "Too many failed attempts. Please reset your password to unlock your account."
        }), 429

    if user and not user["password_hash"]:
        return jsonify({
            "error": "This account uses Google Sign-In. Please continue with Google instead."
        }), 401

    if not user or not check_password_hash(user["password_hash"], password):
        remaining = None
        if user:
            attempts = min(user["failed_attempts"] + 1, MAX_LOGIN_ATTEMPTS)
            db.update_failed_attempts(email, attempts)
            remaining = max(0, MAX_LOGIN_ATTEMPTS - attempts)
        return jsonify({"error": "Invalid email or password.", "remaining_attempts": remaining}), 401

    if not user["is_verified"]:
        code = gen_otp_code()
        db.create_otp(email, code, purpose="verify_email")
        email_utils.send_otp_email(email, code, purpose="verify_email")
        return jsonify({"needs_verification": True, "email": email}), 403

    db.update_failed_attempts(email, 0)
    db.update_last_login(user["id"])
    db.init_user_settings(user["id"])
    access_token, refresh_token = generate_tokens(user)
    return jsonify({
        "status": "ok",
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user": user_to_public(user),
    })


@app.route("/api/auth/resend-otp", methods=["POST"])
def api_resend_otp():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    purpose = data.get("purpose") or "verify_email"

    if not email:
        return jsonify({"error": "Email is required."}), 400

    if purpose == "verify_email":
        user = db.get_user_by_email(email)
        if not user:
            return jsonify({"error": "No pending signup found for this email."}), 404
        if user["is_verified"]:
            return jsonify({"error": "This email is already verified. Please sign in."}), 400

    code = gen_otp_code()
    db.create_otp(email, code, purpose=purpose)
    email_utils.send_otp_email(email, code, purpose=purpose)
    return jsonify({"message": "A new code has been sent."})


@app.route("/api/auth/verify-otp", methods=["POST"])
def api_verify_otp():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    code = (data.get("code") or "").strip()

    if not email or len(code) != 6:
        return jsonify({"error": "Enter the 6-digit code."}), 400

    otp = db.get_active_otp(email, purpose="verify_email")
    if not otp or otp["expires_at"] < int(datetime.datetime.utcnow().timestamp()):
        return jsonify({"error": "Code expired. Please request a new one."}), 400
    if otp["attempts"] >= MAX_OTP_ATTEMPTS:
        db.delete_otp(email, purpose="verify_email")
        return jsonify({"error": "Too many attempts. Please request a new code."}), 429
    if not codes_match(otp["code"], code):
        db.bump_otp_attempts(otp["id"])
        return jsonify({"error": "Incorrect code. Please try again."}), 400

    db.mark_verified(email)
    db.delete_otp(email, purpose="verify_email")
    db.update_failed_attempts(email, 0)

    user = db.get_user_by_email(email)
    db.update_last_login(user["id"])
    db.init_user_settings(user["id"])
    access_token, refresh_token = generate_tokens(user)
    return jsonify({
        "status": "ok",
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user": user_to_public(user),
    })


@app.route("/api/auth/forgot-password", methods=["POST"])
def api_forgot_password():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()

    user = db.get_user_by_email(email)
    if user:
        code = gen_otp_code()
        db.create_otp(email, code, purpose="reset_password")
        email_utils.send_otp_email(email, code, purpose="reset_password")

    # Always respond success (don't reveal whether the email exists)
    return jsonify({"message": "If that email exists, a reset code has been sent."})


@app.route("/api/auth/verify-reset-code", methods=["POST"])
def api_verify_reset_code():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    code = (data.get("code") or "").strip()

    if not email or len(code) != 6:
        return jsonify({"error": "Enter the 6-digit code."}), 400

    otp = db.get_active_otp(email, purpose="reset_password")
    if not otp or otp["expires_at"] < int(datetime.datetime.utcnow().timestamp()):
        return jsonify({"error": "Code expired. Please request a new one."}), 400
    if otp["attempts"] >= MAX_OTP_ATTEMPTS:
        db.delete_otp(email, purpose="reset_password")
        return jsonify({"error": "Too many attempts. Please request a new code."}), 429
    if not codes_match(otp["code"], code):
        db.bump_otp_attempts(otp["id"])
        return jsonify({"error": "Incorrect code. Please try again."}), 400

    db.delete_otp(email, purpose="reset_password")
    reset_token = db.create_reset_token(email)
    return jsonify({"status": "ok", "reset_token": reset_token, "message": "Code verified!"})


@app.route("/api/auth/reset-password", methods=["POST"])
def api_reset_password():
    data = request.get_json(force=True, silent=True) or {}
    reset_token = data.get("reset_token") or ""
    password = data.get("password") or ""

    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400

    row = db.get_reset_token(reset_token)
    if not row or row["expires_at"] < int(datetime.datetime.utcnow().timestamp()):
        return jsonify({"error": "Reset session expired. Please start again."}), 400

    db.set_password(row["email"], generate_password_hash(password))
    db.update_failed_attempts(row["email"], 0)
    db.delete_reset_token(reset_token)
    return jsonify({"status": "ok"})


@app.route("/api/auth/me")
def api_me():
    try:
        user = get_current_user()
    except Exception as e:
        print(f"[AUTH] /api/auth/me crashed: {type(e).__name__}: {e}")
        user = None
    if not user:
        return jsonify({"error": "Not authenticated."}), 401
    return jsonify({"status": "ok", "user": user_to_public(user)})


# ══════════════════════════════════════════════════════════════════
#  USER PROFILE & SETTINGS API
# ══════════════════════════════════════════════════════════════════

@app.route("/api/user/profile", methods=["GET"])
def api_user_profile():
    """Return the authenticated user's full profile data."""
    user = get_current_user()
    if not user:
        return jsonify({"error": "Not authenticated."}), 401

    import time as _time
    features_used = db.get_user_features_used(user["id"])
    total_entities = db.count_user_entities(user["id"])

    # Format dates
    created_ts = user["created_at"]
    last_login_ts = dict(user).get("last_login_at")
    try:
        created_str = datetime.datetime.utcfromtimestamp(created_ts).strftime("%B %Y")
    except Exception:
        created_str = "Unknown"
    try:
        if last_login_ts:
            now = int(_time.time())
            diff = now - last_login_ts
            if diff < 60:
                last_login_str = "Just now"
            elif diff < 3600:
                last_login_str = f"{diff // 60} minutes ago"
            elif diff < 86400:
                last_login_str = f"{diff // 3600} hours ago"
            else:
                last_login_str = datetime.datetime.utcfromtimestamp(last_login_ts).strftime("%b %d, %Y %I:%M %p")
        else:
            last_login_str = "Never"
    except Exception:
        last_login_str = "Unknown"

    user_dict = dict(user)
    profile = {
        "id": user_dict.get("id"),
        "username": user_dict.get("username"),
        "email": user_dict.get("email"),
        "joined": created_str,
        "last_login": last_login_str,
        "features_used": len(features_used),
        "total_features": 31,
        "total_entities": total_entities,
        "has_google": bool(user_dict.get("google_id")),
        "has_password": bool(user_dict.get("password_hash")),
        "is_verified": bool(user_dict.get("is_verified")),
    }
    return jsonify({"status": "ok", "profile": profile})


@app.route("/api/user/profile", methods=["PUT"])
def api_update_profile():
    """Update the user's display name."""
    user = get_current_user()
    if not user:
        return jsonify({"error": "Not authenticated."}), 401
    data = request.get_json(force=True, silent=True) or {}
    new_username = (data.get("username") or "").strip()
    if len(new_username) < 2:
        return jsonify({"error": "Username must be at least 2 characters."}), 400
    db.update_username(user["id"], new_username)
    return jsonify({"status": "ok", "username": new_username})


@app.route("/api/user/password", methods=["PUT"])
def api_change_password():
    """Change the user's password (requires current password)."""
    user = get_current_user()
    if not user:
        return jsonify({"error": "Not authenticated."}), 401
    data = request.get_json(force=True, silent=True) or {}
    current = data.get("current_password") or ""
    new_pass = data.get("new_password") or ""

    if not user["password_hash"]:
        return jsonify({"error": "This account uses Google Sign-In. Set a password via Forgot Password."}), 400
    if not check_password_hash(user["password_hash"], current):
        return jsonify({"error": "Current password is incorrect."}), 401
    if len(new_pass) < 6:
        return jsonify({"error": "New password must be at least 6 characters."}), 400

    db.set_password(user["email"], generate_password_hash(new_pass))
    return jsonify({"status": "ok", "message": "Password changed successfully."})


@app.route("/api/user/settings", methods=["GET"])
def api_get_settings():
    """Return the user's per-user settings."""
    user = get_current_user()
    if not user:
        return jsonify({"error": "Not authenticated."}), 401
    settings = db.get_user_settings(user["id"])
    return jsonify({"status": "ok", "settings": settings})


@app.route("/api/user/settings", methods=["PUT"])
def api_save_settings():
    """Save/update user settings (partial update — merges)."""
    user = get_current_user()
    if not user:
        return jsonify({"error": "Not authenticated."}), 401
    data = request.get_json(force=True, silent=True) or {}
    updated = db.save_user_settings(user["id"], data)
    return jsonify({"status": "ok", "settings": updated})


@app.route("/api/user/export", methods=["GET"])
def api_export_data():
    """Export all user data as a JSON download."""
    user = get_current_user()
    if not user:
        return jsonify({"error": "Not authenticated."}), 401

    import json as _json
    export = {
        "user": {
            "username": user["username"],
            "email": user["email"],
            "joined": user["created_at"],
        },
        "settings": db.get_user_settings(user["id"]),
        "features": {},
    }
    # Collect feature entity IDs
    for feature in ["askanything", "entertainment", "foodrecipe", "horoscope",
                     "alarm", "dailytask", "reminder"]:
        ids = db.get_user_entities(user["id"], feature)
        if ids:
            export["features"][feature] = ids

    resp_text = _json.dumps(export, indent=2, ensure_ascii=False)
    return Response(
        resp_text,
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="snetch_export_{user["username"]}.json"'},
    )


# ══════════════════════════════════════════════════════════════════
#  BLUEPRINT RESPONSE FILTERING (user-scoping for blueprint features)
# ══════════════════════════════════════════════════════════════════
# Blueprint features (shopping, youtube_chatbot, image_chatbot,
# document_chatbot) can't be modified, so we filter their list
# responses and track entity creation via after_request.
#
# image_chatbot / document_chatbot / youtube_chatbot were previously
# NOT covered here at all, and their blueprints are mounted at
# /image_chatbot/api/..., /document_chatbot/api/..., /youtube_chatbot/api/...
# — paths that don't start with "/api/", so g.current_user_id was never
# even populated for them (see inject_user_context above). Combined,
# those two gaps meant every signed-in user could see every other
# user's Image/Document/YouTube AI Chat threads. Both are now fixed.

import json as _json_module

# Map of (path, method) -> (feature_name, [response_keys_for_lists], id_field)
# Some features (chat-style ones) split their thread list into two keys
# ("pinned" and "recent") instead of one, so this takes a list of keys.
_BLUEPRINT_LIST_FILTERS = {
    ("/api/shopping/lists", "GET"): ("shopping", ["lists"], "id"),
    ("/api/shopping/lists/archived", "GET"): ("shopping", ["lists"], "id"),
    ("/image_chatbot/api/threads", "GET"): ("image_chatbot", ["pinned", "recent"], "thread_id"),
    ("/document_chatbot/api/threads", "GET"): ("document_chatbot", ["pinned", "recent"], "thread_id"),
    ("/youtube_chatbot/api/threads", "GET"): ("youtube_chatbot", ["pinned", "recent"], "thread_id"),
    ("/api/countingset/countdowns", "GET"): ("countingset_countdowns", ["records"], "id"),
    ("/api/countingset/stopwatches", "GET"): ("countingset_stopwatches", ["records"], "id"),
}

# Map of (path, method) -> (feature_name, id_field, nested_obj_key)
# nested_obj_key is None when the id is a top-level field in the response
# (e.g. {"thread_id": "..."}); otherwise the id is read from
# response[nested_obj_key][id_field] (e.g. {"list": {"id": "..."}}).
_BLUEPRINT_CREATE_TRACKERS = {
    ("/api/shopping/lists", "POST"): ("shopping", "id", "list"),
    ("/image_chatbot/api/new_chat", "POST"): ("image_chatbot", "thread_id", None),
    ("/document_chatbot/api/new_chat", "POST"): ("document_chatbot", "thread_id", None),
    ("/youtube_chatbot/api/new_chat", "POST"): ("youtube_chatbot", "thread_id", None),
    ("/api/countingset/countdowns", "POST"): ("countingset_countdowns", "id", "record"),
    ("/api/countingset/stopwatches", "POST"): ("countingset_stopwatches", "id", "record"),
}

# (path_prefix, feature_name) for DELETE routes shaped like
# "<path_prefix>/<entity_id>" — the entity_id is the final path segment.
_BLUEPRINT_DELETE_PREFIXES = [
    ("/api/shopping/lists/", "shopping"),
    ("/image_chatbot/api/thread/", "image_chatbot"),
    ("/document_chatbot/api/thread/", "document_chatbot"),
    ("/youtube_chatbot/api/thread/", "youtube_chatbot"),
    ("/api/countingset/countdowns/", "countingset_countdowns"),
    ("/api/countingset/stopwatches/", "countingset_stopwatches"),
]


@app.after_request
def scope_blueprint_responses(response):
    """Filter blueprint list responses and track creates/deletes per-user."""
    uid = getattr(g, "current_user_id", None)
    if uid is None:
        return response
    if not response.content_type or "application/json" not in response.content_type:
        return response

    path = request.path
    method = request.method

    # ── Filter list responses ──
    key = (path, method)
    if key in _BLUEPRINT_LIST_FILTERS:
        feature, list_keys, id_field = _BLUEPRINT_LIST_FILTERS[key]
        try:
            data = response.get_json(silent=True)
            if data:
                user_ids = set(db.get_user_entities(uid, feature))
                changed = False
                for list_key in list_keys:
                    if list_key in data:
                        data[list_key] = [
                            item for item in data[list_key]
                            if str(item.get(id_field, "")) in user_ids
                        ]
                        changed = True
                if changed:
                    response.set_data(_json_module.dumps(data))
        except Exception:
            pass

    # ── Track creates ──
    if key in _BLUEPRINT_CREATE_TRACKERS and response.status_code in (200, 201):
        feature, id_field, nested_obj_key = _BLUEPRINT_CREATE_TRACKERS[key]
        try:
            data = response.get_json(silent=True)
            if data:
                source = data.get(nested_obj_key, {}) if nested_obj_key else data
                entity_id = source.get(id_field) if isinstance(source, dict) else None
                if entity_id:
                    db.map_feature_entity(uid, feature, str(entity_id))
        except Exception:
            pass

    # ── Track deletes (DELETE "<prefix>/<entity_id>") ──
    if method == "DELETE" and response.status_code in (200, 204):
        for prefix, feature in _BLUEPRINT_DELETE_PREFIXES:
            if path.startswith(prefix):
                entity_id = path[len(prefix):].strip("/").split("/")[0]
                if entity_id:
                    db.unmap_feature_entity(uid, feature, entity_id)
                break

    return response




@app.route("/api/auth/google/start")
def google_start():
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        return redirect("/login?error=google_not_configured")

    state = secrets.token_urlsafe(16)
    session["google_oauth_state"] = state

    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": url_for("google_callback", _external=True),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
        "access_type": "online",
    }
    return redirect(f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}")


@app.route("/api/auth/google/callback")
def google_callback():
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        return redirect("/login?error=google_not_configured")

    error = request.args.get("error")
    if error:
        return redirect("/login?error=google_cancelled")

    state = request.args.get("state")
    if not state or state != session.get("google_oauth_state"):
        return redirect("/login?error=google_failed")
    session.pop("google_oauth_state", None)

    code = request.args.get("code")
    if not code:
        return redirect("/login?error=google_failed")

    try:
        token_resp = requests.post("https://oauth2.googleapis.com/token", data={
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": url_for("google_callback", _external=True),
        }, timeout=10)
        token_resp.raise_for_status()
        google_access_token = token_resp.json()["access_token"]

        userinfo_resp = requests.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {google_access_token}"},
            timeout=10,
        )
        userinfo_resp.raise_for_status()
        info = userinfo_resp.json()

        email = info["email"]
        name = info.get("name") or email.split("@")[0]
        google_id = info["sub"]
    except Exception as e:
        print(f"[GOOGLE OAUTH FAILED]: {e}")
        return redirect("/login?error=google_failed")

    user = db.link_google_login(email, google_id, name=name)
    if not user:
        return redirect("/login?error=google_failed")
    db.update_last_login(user["id"])
    db.init_user_settings(user["id"])
    access_token, refresh_token = generate_tokens(user)

    # We can't set localStorage from a server redirect, so we land on a
    # tiny bridge page that stores the tokens then forwards to the dashboard.
    return render_template(
        "oauth_bridge.html",
        access_token=access_token,
        refresh_token=refresh_token,
        user=user_to_public(user),
    )


@app.after_request
def inject_responsive_assets(response):
    if response.mimetype == "text/html":
        html = response.get_data(as_text=True)
        # Check if viewport meta is present, if not inject it
        if '<meta name="viewport"' not in html:
            if '<head>' in html:
                meta = '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
                html = html.replace('<head>', f'<head>\n    {meta}')
        
        # Inject CSS
        if '<head>' in html and 'responsive.css' not in html:
            css = '<link rel="stylesheet" href="/static/responsive.css">'
            html = html.replace('</head>', f'    {css}\n</head>')
            
        # Inject JS
        if '</body>' in html and 'responsive-sidebar.js' not in html:
            js = '<script src="/static/responsive-sidebar.js"></script>'
            html = html.replace('</body>', f'    {js}\n</body>')
            
        response.set_data(html)
    return response

def open_browser():
    webbrowser.open("http://127.0.0.1:5000/login")


if __name__ == "__main__":
    # Resume any previously-set alarms once, at process startup (replaces the
    # old @app.before_first_request hook, which Flask 3.x removed).
    alarm.start_all_alarms()

    # use_reloader=False -> single process, so the browser opens exactly once
    # and reliably (no race with Flask's debug-mode child-process reloader).
    threading.Timer(1.25, open_browser).start()
    app.run(debug=True, use_reloader=False, port=5000, threaded=True)
