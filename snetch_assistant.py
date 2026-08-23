# =============================================================
#  snetch_assistant.py — S.N.E.T.C.H "SNETCH" Personal Assistant
#  JARVIS-style: persistent memory, instruction-following,
#  self-renaming identity, per-Gmail-account isolation.
# =============================================================
#
#  WHAT THIS FILE DOES
#  --------------------
#  1. Stores EVERY message ever exchanged, per user, forever
#     (until the user explicitly clears it).
#  2. Detects when the user is giving an INSTRUCTION ("your name
#     is now Jarvis", "always reply in Hindi", "I don't like
#     that") vs. a normal message, and remembers instructions
#     separately so they are respected in every future reply.
#  3. Lets the assistant have its own name per user (default
#     "SNETCH"), changeable only by the user's own instruction.
#  4. Is fully isolated per Gmail account: every table has a
#     user_id column and every route checks g.current_user_id
#     before touching any row. Two different Gmail accounts can
#     NEVER see or affect each other's data.
#
#  HOW ISOLATION WORKS HERE (read this before editing)
#  -----------------------------------------------------
#  Unlike some of the older features in this project, this
#  module does NOT rely on the app.py-level "user_feature_map"
#  bolt-on. Every table below has its own user_id column set at
#  creation time, and every query is filtered by it directly.
#  This is the safer pattern — there is no way to "forget" the
#  filter later, because the row itself cannot be read without
#  knowing which user_id to ask for.
#
#  This module requires the user to be logged in (a valid JWT).
#  If g.current_user_id is None, every route returns 401 —
#  we do NOT fail-open here, because this feature is memory of
#  a specific person and must never leak to a guest/anonymous
#  caller.
# =============================================================

import os
import re
import json
import time
import sqlite3
import urllib.request
import urllib.error
from datetime import datetime

from flask import Blueprint, request, jsonify, g
import db as _db

# ---------------------------------------------------------------
#  DB SETUP — its own isolated sqlite file, like horoscope/vault/
#  snaplock/etc. Keeps this feature self-contained.
# ---------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_DIR = os.path.join(BASE_DIR, "db_storage")
os.makedirs(DB_DIR, exist_ok=True)
DB_PATH = os.path.join(DB_DIR, "snetch_assistant.db")

DEFAULT_ASSISTANT_NAME = "SNETCH"

# How many recent messages get sent to Groq as raw context.
# Older messages are still stored forever in the DB, but are not
# replayed in full every time (that would get slow/expensive) —
# see _build_history_summary() for how older context is folded in.
RECENT_MESSAGE_WINDOW = 20

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "openai/gpt-oss-120b"


def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_db():
    conn = get_conn()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS identity (
        user_id       INTEGER PRIMARY KEY,
        assistant_name TEXT NOT NULL DEFAULT 'SNETCH',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        role        TEXT NOT NULL,           -- 'user' or 'assistant'
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, created_at);

    CREATE TABLE IF NOT EXISTS instructions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL,
        instruction_text TEXT NOT NULL,
        category        TEXT NOT NULL,        -- identity | behavior | preference
        active          INTEGER NOT NULL DEFAULT 1,
        created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_instr_user ON instructions(user_id, active);

    CREATE TABLE IF NOT EXISTS feedback (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL,
        message_id    INTEGER,
        feedback_type TEXT NOT NULL,          -- 'like' or 'dislike'
        note          TEXT,
        created_at    INTEGER NOT NULL
    );

    -- Rolling summary of older conversation, so we don't have to
    -- resend the ENTIRE lifetime history to Groq on every message.
    -- The full raw history always stays in `conversations` — this
    -- is purely a compressed memory aid for the model.
    CREATE TABLE IF NOT EXISTS memory_summary (
        user_id     INTEGER PRIMARY KEY,
        summary     TEXT NOT NULL DEFAULT '',
        updated_at  INTEGER NOT NULL
    );
    """)
    conn.commit()
    conn.close()


# ---------------------------------------------------------------
#  IDENTITY HELPERS
# ---------------------------------------------------------------
def get_or_create_identity(user_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM identity WHERE user_id=?", (user_id,)).fetchone()
    if row is None:
        now = int(time.time())
        conn.execute(
            "INSERT INTO identity (user_id, assistant_name, created_at, updated_at) VALUES (?,?,?,?)",
            (user_id, DEFAULT_ASSISTANT_NAME, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM identity WHERE user_id=?", (user_id,)).fetchone()
    conn.close()
    return dict(row)


def set_assistant_name(user_id, new_name):
    new_name = (new_name or "").strip()[:60]
    if not new_name:
        return
    now = int(time.time())
    conn = get_conn()
    conn.execute(
        "UPDATE identity SET assistant_name=?, updated_at=? WHERE user_id=?",
        (new_name, now, user_id),
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------
#  VOICE-OUTPUT CLEANUP
#  Groq (and most chat models) love markdown — **bold**, *italic*,
#  bullet lists, headings, code fences. None of that means anything
#  when it's read aloud by TTS: a screen-reader/voice engine either
#  reads the raw symbols out loud ("asterisk asterisk...") or the
#  pauses/rhythm come out wrong. Since this feature is voice-only
#  (nothing is ever displayed on screen), we strip every bit of
#  markdown out of the reply before it's saved or spoken, no matter
#  what the model sends back. This is a belt-and-suspenders fix —
#  the system prompt also tells the model not to use markdown at
#  all, but we never trust that alone.
# ---------------------------------------------------------------
def strip_markdown_for_speech(text):
    if not text:
        return text
    t = text
    t = re.sub(r"\*\*\*(.*?)\*\*\*", r"\1", t)     # ***bold italic***
    t = re.sub(r"\*\*(.*?)\*\*", r"\1", t)          # **bold**
    t = re.sub(r"\*(.*?)\*", r"\1", t)              # *italic*
    t = re.sub(r"__(.*?)__", r"\1", t)              # __bold__
    t = re.sub(r"(?<!\w)_(.*?)_(?!\w)", r"\1", t)   # _italic_
    t = re.sub(r"`{1,3}([^`]*?)`{1,3}", r"\1", t)   # `code` / ```code```
    t = re.sub(r"^\s{0,3}#{1,6}\s*", "", t, flags=re.MULTILINE)   # # Heading
    t = re.sub(r"^\s*[-*•]\s+", "", t, flags=re.MULTILINE)        # - bullet / * bullet
    t = re.sub(r"^\s*\d+\.\s+", "", t, flags=re.MULTILINE)        # 1. numbered list
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)  # [text](link) -> text
    t = re.sub(r"[*_`#~]", "", t)                    # any stray leftover symbols
    t = re.sub(r"\n{2,}", ". ", t)
    t = re.sub(r"\n", " ", t)
    t = re.sub(r"\s{2,}", " ", t)
    return t.strip()


# ---------------------------------------------------------------
#  CONVERSATION HELPERS
# ---------------------------------------------------------------
def save_message(user_id, role, content):
    now = int(time.time())
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO conversations (user_id, role, content, created_at) VALUES (?,?,?,?)",
        (user_id, role, content, now),
    )
    conn.commit()
    msg_id = cur.lastrowid
    conn.close()
    return msg_id


def get_recent_messages(user_id, limit=RECENT_MESSAGE_WINDOW):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM conversations WHERE user_id=? ORDER BY id DESC LIMIT ?",
        (user_id, limit),
    ).fetchall()
    conn.close()
    return list(reversed([dict(r) for r in rows]))


def get_all_messages(user_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM conversations WHERE user_id=? ORDER BY id ASC", (user_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def clear_user_data(user_id):
    """Wipe everything for this user only. Used by the 'forget me'
    reset endpoint — never touches any other user's rows."""
    conn = get_conn()
    conn.execute("DELETE FROM conversations WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM instructions WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM feedback WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM memory_summary WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM identity WHERE user_id=?", (user_id,))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------
#  INSTRUCTION HELPERS
# ---------------------------------------------------------------
def add_instruction(user_id, text, category):
    now = int(time.time())
    conn = get_conn()
    conn.execute(
        "INSERT INTO instructions (user_id, instruction_text, category, active, created_at) VALUES (?,?,?,1,?)",
        (user_id, text, category, now),
    )
    conn.commit()
    conn.close()


def get_active_instructions(user_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM instructions WHERE user_id=? AND active=1 ORDER BY created_at ASC",
        (user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def deactivate_instruction(user_id, instruction_id):
    conn = get_conn()
    conn.execute(
        "UPDATE instructions SET active=0 WHERE id=? AND user_id=?",
        (instruction_id, user_id),
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------
#  MEMORY SUMMARY (keeps very long histories cheap to replay)
# ---------------------------------------------------------------
def get_summary(user_id):
    conn = get_conn()
    row = conn.execute("SELECT summary FROM memory_summary WHERE user_id=?", (user_id,)).fetchone()
    conn.close()
    return row["summary"] if row else ""


def save_summary(user_id, summary):
    now = int(time.time())
    conn = get_conn()
    conn.execute(
        """INSERT INTO memory_summary (user_id, summary, updated_at) VALUES (?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET summary=excluded.summary, updated_at=excluded.updated_at""",
        (user_id, summary, now),
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------
#  GROQ CALL — one call does BOTH the reply and instruction
#  detection, to keep this fast/cheap. We ask the model to
#  return strict JSON.
# ---------------------------------------------------------------
def _groq_available():
    return bool(os.getenv("GROQ_API_KEY"))


def call_groq(messages, force_json=True):
    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        "temperature": 0.8,
    }
    if force_json:
        payload["response_format"] = {"type": "json_object"}

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        GROQ_API_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.getenv('GROQ_API_KEY')}",
            "User-Agent": "Mozilla/5.0 (SNETCH-Assistant)",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def _build_system_prompt(assistant_name, instructions, summary):
    lines = [
        f"You are {assistant_name}, a real personal companion living inside the user's own "
        f"SNETCH app — not a generic chatbot, not a customer-support bot, not 'an AI language "
        f"model'. You talk to this ONE specific person, and only them, across every session, "
        f"and you actually remember your history together the way a close human friend or a "
        f"sharp personal assistant (JARVIS-style) would.",
        "",
        "═══════════════════════════════════════════",
        "THIS IS A VOICE-ONLY CONVERSATION",
        "═══════════════════════════════════════════",
        "Everything you write is converted straight to speech and spoken out loud — nothing you "
        "write is ever shown as text on a screen. Because of that:",
        "- NEVER use markdown of any kind: no **bold**, no *italics*, no bullet points, no "
        "numbered lists, no headings (#), no code blocks, no [links](url). If it wouldn't make "
        "sense spoken out loud by a person, don't write it.",
        "- Never say things like 'as shown below', 'see the list above', or describe visual "
        "formatting — there is nothing visual. Say everything as flowing spoken sentences, the "
        "way you'd actually explain it to someone sitting next to you.",
        "- If you're listing more than one thing, say it conversationally ('there's a couple of "
        "ways to do this — first... and then...') instead of a bulleted list.",
        "- Keep sentences reasonably short and natural to say out loud. Avoid long, dense, "
        "essay-like paragraphs — break your thinking into the way a person actually talks: in "
        "beats, with natural pauses (commas, short sentences), not one giant info-dump.",
        "",
        "═══════════════════════════════════════════",
        "BE AN ACTUAL PERSON, NOT AN ASSISTANT-SHAPED TEXT GENERATOR",
        "═══════════════════════════════════════════",
        "- Have a genuine personality: warmth, a bit of humor when it fits, honest opinions when "
        "asked, curiosity about the user's life. Don't be a neutral information dispenser.",
        "- Use natural, conversational language: contractions (I'm, you're, that's, don't), "
        "casual connectors ('honestly', 'okay so', 'by the way'), and normal human rhythm — not "
        "stiff, formal, or robotic phrasing.",
        "- Never say 'As an AI...', 'I am a language model...', 'I don't have feelings, but...', "
        "or any other line that reminds the user they're talking to software. Just respond the "
        "way a thoughtful, present person would.",
        "- It's fine to be unsure, to think out loud a little, or to ask a genuine follow-up "
        "question — real people do that. Don't pretend to omniscient certainty you don't have.",
        "- Match the user's energy and tone: if they're joking, joke back; if they're upset or "
        "stressed, slow down and be genuinely present with them rather than jumping straight to "
        "solutions.",
        "",
        "═══════════════════════════════════════════",
        "CONTINUOUS LEARNING — YOU ACTUALLY GROW FROM EVERY CONVERSATION",
        "═══════════════════════════════════════════",
        "- You have real, permanent memory of this user (see 'Active instructions' and 'Summary' "
        "below). Treat it as your own accumulated experience with them, not a lookup table.",
        "- Whenever the user teaches you something about themselves, corrects a mistake you made, "
        "tells you a preference, sets a standing rule, or renames you — that is a genuine lesson. "
        "Capture it as a new_instruction in your JSON output so you never make the same mistake "
        "or forget the same fact twice.",
        "- If you got something wrong last time and the user is correcting you now, acknowledge "
        "it plainly and briefly like a person would ('ah, got it, my bad') — don't over-apologize "
        "or grovel, just adjust and move on naturally.",
        "- Weigh recent corrections and preferences as authoritative over your own defaults or "
        "anything older — you are always the most-updated version of yourself with this person.",
        "- Never invent memories or instructions the user did not actually give you.",
        "",
        "Language matching:",
        "- Read the LANGUAGE of the user's current message (and recent messages), not just "
        "individual words, to decide how to reply.",
        "- If they are writing in Hindi (Devanagari or Roman-Hindi), reply in Hindi.",
        "- If they are writing in English, reply in English.",
        "- If they are naturally mixing Hindi and English in the same message (Hinglish), reply "
        "in a natural Hindi-English mix too, the way people actually talk day to day — use your "
        "judgment on the right blend.",
        "- If the user has explicitly told you to stick to one language going forward (e.g. "
        "'only talk to me in English' / 'hamesha Hindi mein baat karo'), always follow that "
        "standing instruction over the default per-message matching, until they change it.",
    ]
    if instructions:
        lines.append("")
        lines.append("Active instructions from this user (always follow these — this is what "
                      "you've learned about them so far):")
        for ins in instructions:
            lines.append(f"- [{ins['category']}] {ins['instruction_text']}")
    if summary:
        lines.append("")
        lines.append("Summary of your older conversation history together (for context — treat "
                      "this as things you genuinely remember about them):")
        lines.append(summary)

    lines.append("")
    lines.append(
        "Respond ONLY with a JSON object of this exact shape:\n"
        '{"reply": "<your natural spoken reply, plain text only, zero markdown/symbols>", '
        '"new_instruction": {"text": "<short restatement of the new rule/preference/fact you just '
        'learned>", "category": "identity|behavior|preference"} OR null}'
    )
    return "\n".join(lines)


def get_assistant_reply(user_id, user_message):
    """Core brain: builds context, calls Groq, saves everything,
    applies any newly-detected instruction (including renaming),
    and returns the reply text + assistant name to the caller."""

    if not _groq_available():
        return {
            "reply": "GROQ_API_KEY is not configured on the server, so I can't think right now.",
            "renamed_to": None,
        }

    identity = get_or_create_identity(user_id)
    assistant_name = identity["assistant_name"]
    instructions = get_active_instructions(user_id)
    summary = get_summary(user_id)
    recent = get_recent_messages(user_id, RECENT_MESSAGE_WINDOW)

    system_prompt = _build_system_prompt(assistant_name, instructions, summary)

    groq_messages = [{"role": "system", "content": system_prompt}]
    for m in recent:
        role = "assistant" if m["role"] == "assistant" else "user"
        groq_messages.append({"role": role, "content": m["content"]})
    groq_messages.append({"role": "user", "content": user_message})

    try:
        raw = call_groq(groq_messages, force_json=True)
        parsed = json.loads(raw)
    except (urllib.error.URLError, json.JSONDecodeError, KeyError, Exception) as e:
        # Never lose the user's message even if the model call fails.
        save_message(user_id, "user", user_message)
        return {"reply": f"Sorry, I couldn't think that through — {e}", "renamed_to": None}

    reply_text = (parsed.get("reply") or "").strip() or "..."
    # Belt-and-suspenders: even though the system prompt tells the model
    # never to use markdown, strip it anyway before it's ever saved or
    # spoken, so a stray "**" or "*" from the model never gets read aloud.
    reply_text = strip_markdown_for_speech(reply_text)
    new_instruction = parsed.get("new_instruction")

    save_message(user_id, "user", user_message)
    save_message(user_id, "assistant", reply_text)

    renamed_to = None
    if new_instruction and isinstance(new_instruction, dict):
        text = strip_markdown_for_speech((new_instruction.get("text") or "").strip())
        category = (new_instruction.get("category") or "behavior").strip().lower()
        if category not in ("identity", "behavior", "preference"):
            category = "behavior"
        if text:
            add_instruction(user_id, text, category)
            if category == "identity":
                # try to pull a clean name out of the instruction text
                # via a tiny follow-up rule: if the user's raw message
                # contains a short capitalized-ish token near "name",
                # prefer that; otherwise keep using the instruction text
                # as-is for the record and leave the display name change
                # to the explicit rename endpoint if extraction is unclear.
                candidate = _extract_name_from_text(user_message)
                if candidate:
                    set_assistant_name(user_id, candidate)
                    renamed_to = candidate

    _maybe_refresh_summary(user_id)

    return {"reply": reply_text, "renamed_to": renamed_to, "assistant_name": get_or_create_identity(user_id)["assistant_name"]}


def _extract_name_from_text(text):
    """Very small heuristic for 'your name is now X' / 'tumhara naam X hai'
    style sentences, so a rename actually takes effect immediately rather
    than only being logged as text. Not perfect — good enough as a first
    pass; the instruction is stored regardless."""
    patterns = [
        r"name(?:\s+is)?\s+(?:now\s+)?([A-Za-z][A-Za-z0-9 _-]{1,30})",
        r"naam\s+(?:ab\s+)?([A-Za-z][A-Za-z0-9 _-]{1,30})\s+(?:hai|rakho|rakh\s+do)",
        r"call\s+you\s+([A-Za-z][A-Za-z0-9 _-]{1,30})",
    ]
    for p in patterns:
        m = re.search(p, text, re.IGNORECASE)
        if m:
            name = m.group(1).strip().rstrip(".,!?").strip()
            # avoid capturing trailing junk words
            name = name.split(" ")[0] if len(name.split(" ")) > 3 else name
            if 1 <= len(name) <= 40:
                return name
    return None


def _maybe_refresh_summary(user_id, trigger_every=40):
    """When the raw conversation grows large, fold the oldest part
    into a compact summary so future prompts stay small. Runs a
    lightweight check — only calls Groq to summarize occasionally."""
    all_msgs = get_all_messages(user_id)
    if len(all_msgs) < trigger_every or len(all_msgs) % trigger_every != 0:
        return
    if not _groq_available():
        return
    older = all_msgs[:-RECENT_MESSAGE_WINDOW] if len(all_msgs) > RECENT_MESSAGE_WINDOW else []
    if not older:
        return
    existing_summary = get_summary(user_id)
    convo_text = "\n".join(f"{m['role']}: {m['content']}" for m in older[-trigger_every:])
    try:
        raw = call_groq(
            [
                {"role": "system", "content": "Summarize the following conversation history into a short "
                                               "third-person memory paragraph capturing durable facts, "
                                               "preferences, and context about the user. Merge it with the "
                                               "existing summary if given. Respond with JSON: "
                                               '{"summary": "..."}'},
                {"role": "user", "content": f"Existing summary:\n{existing_summary}\n\nNew messages:\n{convo_text}"},
            ],
            force_json=True,
        )
        parsed = json.loads(raw)
        new_summary = (parsed.get("summary") or "").strip()
        if new_summary:
            save_summary(user_id, new_summary)
    except Exception:
        pass  # summarization is best-effort; never break the main chat flow


# =================================================================
#  BLUEPRINT / ROUTES — every single one checks ownership via
#  g.current_user_id before touching the database.
# =================================================================
snetch_assistant_bp = Blueprint(
    "snetch_assistant_api", __name__, url_prefix="/snetch/api"
)


def _require_user():
    """Returns user_id or None. Route handlers must check this and
    return 401 themselves — kept explicit (not a decorator) so it's
    obvious at every call site that the check happened."""
    return getattr(g, "current_user_id", None)


@snetch_assistant_bp.route("/bootstrap", methods=["GET"])
def api_bootstrap():
    """Called when the SNETCH assistant page loads. Returns the
    user's own identity + full-enough recent history to render the
    chat window. Never returns another user's data."""
    uid = _require_user()
    if uid is None:
        return jsonify({"success": False, "error": "Login required."}), 401

    identity = get_or_create_identity(uid)
    history = get_recent_messages(uid, limit=100)

    # Best-effort: pull the user's display name for the greeting
    # ("Good Evening, Amit"). Falls back to empty string if the
    # users table doesn't have anything usable — the frontend will
    # just say "Good Evening" with no name in that case.
    user_name = ""
    try:
        user_row = _db.get_user_by_id(uid)
        if user_row:
            user_name = (user_row["username"] or "").strip().split(" ")[0]
    except Exception:
        pass

    return jsonify({
        "success": True,
        "assistant_name": identity["assistant_name"],
        "user_name": user_name,
        "history": [
            {"role": m["role"], "content": m["content"], "id": m["id"], "created_at": m["created_at"]}
            for m in history
        ],
    })


@snetch_assistant_bp.route("/chat", methods=["POST"])
def api_chat():
    uid = _require_user()
    if uid is None:
        return jsonify({"success": False, "error": "Login required."}), 401

    data = request.get_json(force=True, silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"success": False, "error": "Empty message."}), 400
    if len(message) > 4000:
        return jsonify({"success": False, "error": "Message too long."}), 400

    result = get_assistant_reply(uid, message)
    return jsonify({
        "success": True,
        "reply": result["reply"],
        "assistant_name": result.get("assistant_name", DEFAULT_ASSISTANT_NAME),
        "renamed_to": result.get("renamed_to"),
    })


@snetch_assistant_bp.route("/instructions", methods=["GET"])
def api_list_instructions():
    uid = _require_user()
    if uid is None:
        return jsonify({"success": False, "error": "Login required."}), 401
    rows = get_active_instructions(uid)
    return jsonify({"success": True, "instructions": rows})


@snetch_assistant_bp.route("/instructions/<int:instruction_id>", methods=["DELETE"])
def api_delete_instruction(instruction_id):
    uid = _require_user()
    if uid is None:
        return jsonify({"success": False, "error": "Login required."}), 401
    # deactivate_instruction already scopes by user_id in its WHERE
    # clause, so a foreign id simply matches zero rows — no leak.
    deactivate_instruction(uid, instruction_id)
    return jsonify({"success": True})


@snetch_assistant_bp.route("/feedback", methods=["POST"])
def api_feedback():
    uid = _require_user()
    if uid is None:
        return jsonify({"success": False, "error": "Login required."}), 401
    data = request.get_json(force=True, silent=True) or {}
    message_id = data.get("message_id")
    feedback_type = (data.get("type") or "").strip().lower()
    note = (data.get("note") or "").strip()
    if feedback_type not in ("like", "dislike"):
        return jsonify({"success": False, "error": "Invalid feedback type."}), 400

    now = int(time.time())
    conn = get_conn()
    conn.execute(
        "INSERT INTO feedback (user_id, message_id, feedback_type, note, created_at) VALUES (?,?,?,?,?)",
        (uid, message_id, feedback_type, note, now),
    )
    conn.commit()
    conn.close()

    if note:
        add_instruction(uid, f"User gave '{feedback_type}' feedback: {note}", "preference")

    return jsonify({"success": True})


@snetch_assistant_bp.route("/reset", methods=["POST"])
def api_reset():
    """Lets the user wipe their OWN memory only. Requires them to
    type a confirm phrase client-side before this is ever called."""
    uid = _require_user()
    if uid is None:
        return jsonify({"success": False, "error": "Login required."}), 401
    clear_user_data(uid)
    return jsonify({"success": True})


def register_snetch_assistant(app):
    init_db()
    app.register_blueprint(snetch_assistant_bp)