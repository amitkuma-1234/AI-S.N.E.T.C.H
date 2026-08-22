# ============================================================
#  image_chatbot.py — AI Image Chatbot (S.N.E.T.C.H)
#  Local Ollama vision model (qwen2.5vl:7b) + LangGraph Thread
#  Memory + SQLite persistence.
#
#  Every "New Image Chat" gets a brand-new LangGraph Thread ID.
#  Each Thread remembers only its own conversation. All chat
#  data (threads, messages, uploaded image info) is persisted
#  in SQLite so it survives an app restart.
# ============================================================

import os
import io
import json
import time
import uuid
import base64
import queue
import sqlite3
import logging
import threading
import requests
from datetime import datetime
from typing import Callable

from flask import (
    Blueprint, request, jsonify, Response, stream_with_context, send_file,
)
from werkzeug.utils import secure_filename

try:
    from utils.logger import logger
except ImportError:
    logger = logging.getLogger("image_chatbot")
    logging.basicConfig(level=logging.INFO)

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

try:
    from PIL import Image as PILImage
    PIL_OK = True
except ImportError:
    PIL_OK = False
    logger.warning("Pillow missing. Run: pip install Pillow")

try:
    from langchain_core.messages import HumanMessage
    from langgraph.graph import StateGraph, START, END
    from langgraph.graph.message import add_messages
    from langgraph.checkpoint.memory import MemorySaver
    from typing import TypedDict, Annotated
    LANGGRAPH_OK = True
except ImportError:
    LANGGRAPH_OK = False


# ════════════════════════════════════════════════════════════
#  CONFIG
# ════════════════════════════════════════════════════════════

GROQ_API_URL  = "https://api.groq.com/openai/v1/chat/completions"
VISION_MODEL  = "qwen/qwen3.6-27b"
OLLAMA_TIMEOUT_SEC = 180

BASE_DIR       = os.path.dirname(os.path.abspath(__file__))
DB_STORAGE_DIR = os.path.join(BASE_DIR, "db_storage")
IMG_DB_PATH    = os.path.join(DB_STORAGE_DIR, "image_chatbot.db")
CHECKPOINT_DB_PATH = os.path.join(DB_STORAGE_DIR, "image_chatbot_checkpoints.db")
UPLOAD_DIR     = os.path.join(DB_STORAGE_DIR, "image_chat_uploads")

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "bmp", "gif"}
ALLOWED_MIME_PREFIX = "image/"
MAX_UPLOAD_BYTES    = 20 * 1024 * 1024  # 20 MB
ONLY_IMAGE_ERROR     = "Only image files are supported."

HISTORY_TURNS_FOR_CONTEXT = 6   # last N messages (user+assistant) sent as context

_web_graph_store = {}     # thread_id -> {"graph":..., "config":...}
_checkpointer_singleton = None


# ════════════════════════════════════════════════════════════
#  OLLAMA VISION HELPERS
# ════════════════════════════════════════════════════════════

def is_ollama_ready() -> bool:
    return bool(os.getenv("GROQ_API_KEY"))


def _ollama_error() -> str:
    return "GROQ_API_KEY not set in .env file."


def _encode_image_b64(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def _build_vision_messages(thread_id: str, question: str) -> list:
    """Builds the Ollama chat message list: a system prompt, a
    trimmed slice of prior conversation (for context/memory), and
    the new question — with the uploaded image attached to every
    user turn so the vision model always has it available."""
    row = get_thread_row(thread_id)
    if not row or not row["img_path"] or not os.path.isfile(row["img_path"]):
        raise ValueError("No image is loaded for this chat yet.")

    b64_image = _encode_image_b64(row["img_path"])

    system_prompt = (
        "You are S.N.E.T.C.H's AI Image Analyst — an expert vision assistant. "
        "Answer the user's questions using ONLY what is visibly present in the "
        "attached image. Be precise and thorough: describe objects, people, "
        "colors, text, counts, charts, diagrams, or errors exactly as asked. "
        "If something cannot be determined from the image, say so honestly. "
        "Format your answers clearly using Markdown — use bullet lists or "
        "tables when that makes the answer easier to read."
    )

    messages = [{"role": "system", "content": system_prompt}]

    history = get_message_rows(thread_id, limit=HISTORY_TURNS_FOR_CONTEXT)
    for row_msg in history:
        if row_msg["role"] == "user":
            messages.append({
                "role": "user",
                "content": [
                    {"type": "text", "text": row_msg["content"]},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"}},
                ],
            })
        else:
            messages.append({"role": "assistant", "content": row_msg["content"]})

    messages.append({
        "role": "user",
        "content": [
            {"type": "text", "text": question},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"}},
        ],
    })
    return messages


def ask_vision_ollama(thread_id: str, question: str) -> str:
    messages = _build_vision_messages(thread_id, question)
    payload = json.dumps({
        "model": VISION_MODEL,
        "messages": messages,
        "stream": False,
        "temperature": 0.2,
    }).encode("utf-8")

    req = urllib.request.Request(
        GROQ_API_URL, data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.getenv('GROQ_API_KEY')}",
        }, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT_SEC) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body["choices"][0]["message"]["content"].strip()
    except urllib.error.URLError as e:
        raise RuntimeError(_ollama_error() + f" — {e}")
    except Exception as e:
        raise RuntimeError(f"Groq call failed: {e}")


def ask_vision_ollama_stream(thread_id: str, question: str,
                              on_token: Callable[[str], None] | None = None) -> str:
    messages = _build_vision_messages(thread_id, question)
    payload = {
        "model": VISION_MODEL,
        "messages": messages,
        "stream": True,
        "temperature": 0.2,
    }
    parts = []
    try:
        with requests.post(
            GROQ_API_URL,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {os.getenv('GROQ_API_KEY')}",
            },
            json=payload,
            timeout=OLLAMA_TIMEOUT_SEC,
            stream=True,
        ) as resp:
            resp.raise_for_status()
            for raw_line in resp.iter_lines(decode_unicode=True):
                if not raw_line or raw_line == "data: [DONE]":
                    continue
                line = raw_line
                if line.startswith("data: "):
                    line = line[6:]
                chunk = json.loads(line)
                delta = chunk.get("choices", [{}])[0].get("delta", {})
                token = delta.get("content", "")
                if token:
                    parts.append(token)
                    if on_token:
                        on_token(token)
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Groq call failed: {e}")
    return "".join(parts).strip()


def process_image_query(thread_id: str, question: str, stream: bool = False,
                         on_token: Callable[[str], None] | None = None) -> str:
    if stream:
        return ask_vision_ollama_stream(thread_id, question, on_token=on_token)
    return ask_vision_ollama(thread_id, question)


# ════════════════════════════════════════════════════════════
#  IMAGE VALIDATION
# ════════════════════════════════════════════════════════════

def _validate_image_file(path: str, ext: str) -> tuple[bool, str]:
    """Validate that the uploaded file really is a static image of a
    supported format. Returns (ok, error_message)."""
    if not PIL_OK:
        # Degrade gracefully: trust the extension/MIME check already done.
        return True, ""
    try:
        with PILImage.open(path) as img:
            img.verify()
        with PILImage.open(path) as img:
            fmt = (img.format or "").upper()
            if ext == "gif":
                n_frames = getattr(img, "n_frames", 1)
                if n_frames and n_frames > 1:
                    return False, "Animated GIFs are not supported. Please upload a static image."
            valid_formats = {"PNG", "JPEG", "JPG", "WEBP", "BMP", "GIF"}
            if fmt not in valid_formats:
                return False, ONLY_IMAGE_ERROR
    except Exception:
        return False, ONLY_IMAGE_ERROR
    return True, ""


# ════════════════════════════════════════════════════════════
#  SQLITE DATABASE
# ════════════════════════════════════════════════════════════

def _img_conn() -> sqlite3.Connection:
    os.makedirs(DB_STORAGE_DIR, exist_ok=True)
    conn = sqlite3.connect(IMG_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_image_chatbot_db() -> None:
    os.makedirs(DB_STORAGE_DIR, exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    conn = _img_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS threads (
            thread_id         TEXT PRIMARY KEY,
            title             TEXT NOT NULL DEFAULT 'New Image Chat',
            img_name          TEXT,
            img_type          TEXT,
            img_size          INTEGER,
            img_path          TEXT,
            upload_time       INTEGER,
            upload_status     TEXT NOT NULL DEFAULT 'pending',
            processing_status TEXT NOT NULL DEFAULT 'awaiting_upload',
            is_pinned         INTEGER NOT NULL DEFAULT 0,
            is_archived       INTEGER NOT NULL DEFAULT 0,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id  TEXT NOT NULL,
            role       TEXT NOT NULL,
            content    TEXT NOT NULL,
            liked      INTEGER NOT NULL DEFAULT 0,
            disliked   INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_img_messages_thread ON messages(thread_id)")
    conn.commit()
    conn.close()


def create_thread_row(thread_id: str, title: str = "New Image Chat") -> None:
    now = int(time.time())
    conn = _img_conn()
    conn.execute(
        "INSERT INTO threads (thread_id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (thread_id, title, now, now),
    )
    conn.commit()
    conn.close()


def get_thread_row(thread_id: str):
    conn = _img_conn()
    row = conn.execute("SELECT * FROM threads WHERE thread_id=?", (thread_id,)).fetchone()
    conn.close()
    return row


def list_thread_rows(search: str = "", archived: bool = False):
    conn = _img_conn()
    if search:
        like = f"%{search.lower()}%"
        rows = conn.execute("""
            SELECT DISTINCT t.* FROM threads t
            LEFT JOIN messages m ON m.thread_id = t.thread_id
            WHERE t.is_archived = ?
              AND (LOWER(t.title) LIKE ? OR LOWER(COALESCE(t.img_name,'')) LIKE ?
                   OR LOWER(m.content) LIKE ?)
            ORDER BY t.is_pinned DESC, t.updated_at DESC
        """, (1 if archived else 0, like, like, like)).fetchall()
    else:
        rows = conn.execute("""
            SELECT * FROM threads WHERE is_archived = ?
            ORDER BY is_pinned DESC, updated_at DESC
        """, (1 if archived else 0,)).fetchall()
    conn.close()
    return rows


def touch_thread(thread_id: str) -> None:
    conn = _img_conn()
    conn.execute("UPDATE threads SET updated_at=? WHERE thread_id=?", (int(time.time()), thread_id))
    conn.commit()
    conn.close()


def set_thread_img_info(thread_id: str, name: str, ftype: str, size: int, path: str,
                         upload_time: int, processing_status: str, upload_status: str) -> None:
    conn = _img_conn()
    conn.execute("""
        UPDATE threads SET img_name=?, img_type=?, img_size=?, img_path=?, upload_time=?,
               processing_status=?, upload_status=?, updated_at=? WHERE thread_id=?
    """, (name, ftype, size, path, upload_time, processing_status, upload_status,
          int(time.time()), thread_id))
    conn.commit()
    conn.close()


def set_processing_status(thread_id: str, status: str) -> None:
    conn = _img_conn()
    conn.execute("UPDATE threads SET processing_status=?, updated_at=? WHERE thread_id=?",
                 (status, int(time.time()), thread_id))
    conn.commit()
    conn.close()


def rename_thread_row(thread_id: str, title: str) -> None:
    conn = _img_conn()
    conn.execute("UPDATE threads SET title=?, updated_at=? WHERE thread_id=?",
                 (title.strip()[:120] or "New Image Chat", int(time.time()), thread_id))
    conn.commit()
    conn.close()


def set_pin_row(thread_id: str, pinned: bool) -> None:
    conn = _img_conn()
    conn.execute("UPDATE threads SET is_pinned=?, updated_at=? WHERE thread_id=?",
                 (1 if pinned else 0, int(time.time()), thread_id))
    conn.commit()
    conn.close()


def set_archive_row(thread_id: str, archived: bool) -> None:
    conn = _img_conn()
    conn.execute("UPDATE threads SET is_archived=?, updated_at=? WHERE thread_id=?",
                 (1 if archived else 0, int(time.time()), thread_id))
    conn.commit()
    conn.close()


def delete_thread_row(thread_id: str) -> None:
    conn = _img_conn()
    conn.execute("DELETE FROM threads WHERE thread_id=?", (thread_id,))
    conn.execute("DELETE FROM messages WHERE thread_id=?", (thread_id,))
    conn.commit()
    conn.close()


def add_message_row(thread_id: str, role: str, content: str) -> int:
    conn = _img_conn()
    cur = conn.execute(
        "INSERT INTO messages (thread_id, role, content, created_at) VALUES (?,?,?,?)",
        (thread_id, role, content, int(time.time())),
    )
    conn.commit()
    msg_id = cur.lastrowid
    conn.close()
    return msg_id


def get_message_rows(thread_id: str, limit: int | None = None):
    conn = _img_conn()
    if limit:
        rows = conn.execute(
            "SELECT * FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT ?",
            (thread_id, limit),
        ).fetchall()
        rows = list(reversed(rows))
    else:
        rows = conn.execute(
            "SELECT * FROM messages WHERE thread_id=? ORDER BY id ASC", (thread_id,)
        ).fetchall()
    conn.close()
    return rows


def delete_message_row(message_id: int) -> None:
    conn = _img_conn()
    conn.execute("DELETE FROM messages WHERE id=?", (message_id,))
    conn.commit()
    conn.close()


def set_message_feedback_row(message_id: int, feedback: str) -> None:
    liked = 1 if feedback == "like" else 0
    disliked = 1 if feedback == "dislike" else 0
    conn = _img_conn()
    conn.execute("UPDATE messages SET liked=?, disliked=? WHERE id=?",
                 (liked, disliked, message_id))
    conn.commit()
    conn.close()


def _serialize_thread(row) -> dict:
    return {
        "thread_id": row["thread_id"],
        "title": row["title"],
        "image": {
            "name": row["img_name"],
            "type": row["img_type"],
            "size": row["img_size"],
            "upload_time": row["upload_time"],
        } if row["img_name"] else None,
        "upload_status": row["upload_status"],
        "processing_status": row["processing_status"],
        "is_pinned": bool(row["is_pinned"]),
        "is_archived": bool(row["is_archived"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _serialize_message(row) -> dict:
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        "liked": bool(row["liked"]),
        "disliked": bool(row["disliked"]),
        "created_at": row["created_at"],
    }


# ════════════════════════════════════════════════════════════
#  LANGGRAPH THREAD MEMORY — one isolated Thread per New Image
#  Chat, checkpointed to SQLite when langgraph/langchain are
#  installed. Falls back gracefully otherwise (the messages
#  table above remains the source of truth either way).
# ════════════════════════════════════════════════════════════

if LANGGRAPH_OK:
    class ImageChatState(TypedDict):
        messages: Annotated[list, add_messages]
        thread_id: str

    def _get_checkpointer():
        global _checkpointer_singleton
        if _checkpointer_singleton is not None:
            return _checkpointer_singleton
        try:
            from langgraph.checkpoint.sqlite import SqliteSaver
            conn = sqlite3.connect(CHECKPOINT_DB_PATH, check_same_thread=False)
            _checkpointer_singleton = SqliteSaver(conn)
        except ImportError:
            _checkpointer_singleton = MemorySaver()
        return _checkpointer_singleton

    def _image_graph_node(state):
        thread_id = state["thread_id"]
        question = state["messages"][-1].content
        answer = process_image_query(thread_id, question, stream=False)
        return {"messages": [HumanMessage(content=answer)]}

    def _make_image_graph():
        g = StateGraph(ImageChatState)
        g.add_node("answer", _image_graph_node)
        g.add_edge(START, "answer")
        g.add_edge("answer", END)
        return g.compile(checkpointer=_get_checkpointer())

    def _get_or_create_image_graph(thread_id: str):
        """Every unique thread_id lazily gets its OWN LangGraph Thread
        (own checkpointed state) the first time it's used — a brand
        new Thread ID from /new_chat therefore always starts with a
        completely clean, isolated memory."""
        if thread_id not in _web_graph_store:
            _web_graph_store[thread_id] = {
                "graph": _make_image_graph(),
                "config": {"configurable": {"thread_id": thread_id}},
            }
        return _web_graph_store[thread_id]

    def _sync_langgraph_memory(thread_id: str, question: str, answer: str) -> None:
        """Persist this Q/A turn into the Thread's LangGraph checkpoint
        (SQLite-backed) without re-running the model — the answer was
        already generated/streamed to the user."""
        try:
            bot = _get_or_create_image_graph(thread_id)
            bot["graph"].update_state(
                bot["config"],
                {"messages": [HumanMessage(content=question), HumanMessage(content=answer)]},
            )
        except Exception as e:
            logger.warning(f"LangGraph memory sync skipped: {e}")

    def _drop_langgraph_thread(thread_id: str) -> None:
        _web_graph_store.pop(thread_id, None)
else:
    def _sync_langgraph_memory(thread_id: str, question: str, answer: str) -> None:
        pass

    def _drop_langgraph_thread(thread_id: str) -> None:
        pass


# ════════════════════════════════════════════════════════════
#  FLASK BLUEPRINT — /image_chatbot/api/*
# ════════════════════════════════════════════════════════════

image_chatbot_bp = Blueprint(
    "image_chatbot_api", __name__, url_prefix="/image_chatbot/api"
)


@image_chatbot_bp.route("/new_chat", methods=["POST"])
def api_new_chat():
    thread_id = uuid.uuid4().hex
    create_thread_row(thread_id, "New Image Chat")
    return jsonify({"success": True, "thread_id": thread_id,
                     "thread": _serialize_thread(get_thread_row(thread_id))})


@image_chatbot_bp.route("/upload", methods=["POST"])
def api_upload():
    thread_id = request.form.get("thread_id", "").strip()
    file = request.files.get("file")

    if not thread_id or not get_thread_row(thread_id):
        return jsonify({"success": False, "error": "Invalid or missing chat thread."}), 400
    if not file or not file.filename:
        return jsonify({"success": False, "error": "No file provided."}), 400

    filename = secure_filename(file.filename) or "image"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    mimetype = (file.mimetype or "").lower()

    if ext not in ALLOWED_EXTENSIONS or not mimetype.startswith(ALLOWED_MIME_PREFIX):
        return jsonify({"success": False, "error": ONLY_IMAGE_ERROR}), 400

    set_processing_status(thread_id, "uploading")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    dest_path = os.path.join(UPLOAD_DIR, f"{thread_id}.{ext}")

    file.save(dest_path)
    size = os.path.getsize(dest_path)

    if size > MAX_UPLOAD_BYTES:
        os.remove(dest_path)
        set_processing_status(thread_id, "failed")
        return jsonify({"success": False, "error": "Image exceeds the 20MB limit."}), 400
    if size == 0:
        os.remove(dest_path)
        set_processing_status(thread_id, "failed")
        return jsonify({"success": False, "error": "Uploaded file is empty."}), 400

    ok, err = _validate_image_file(dest_path, ext)
    if not ok:
        os.remove(dest_path)
        set_processing_status(thread_id, "failed")
        return jsonify({"success": False, "error": err}), 422

    upload_time = int(time.time())
    set_thread_img_info(thread_id, filename, ext, size, dest_path, upload_time,
                         "processing", "success")

    # Image is ready for analysis — no separate indexing step needed;
    # the vision model reads the image directly on each question.
    set_processing_status(thread_id, "ready")

    row = get_thread_row(thread_id)
    if row["title"] == "New Image Chat":
        rename_thread_row(thread_id, os.path.splitext(filename)[0][:80])

    touch_thread(thread_id)
    return jsonify({
        "success": True,
        "thread": _serialize_thread(get_thread_row(thread_id)),
    })


@image_chatbot_bp.route("/thread/<thread_id>/image", methods=["GET"])
def api_thread_image(thread_id):
    row = get_thread_row(thread_id)
    if not row or not row["img_path"] or not os.path.isfile(row["img_path"]):
        return jsonify({"success": False, "error": "Image not found."}), 404
    return send_file(row["img_path"])


@image_chatbot_bp.route("/threads", methods=["GET"])
def api_threads():
    search = request.args.get("search", "").strip()
    scope = request.args.get("scope", "all")
    rows = list_thread_rows(search=search, archived=(scope == "archived"))
    threads = [_serialize_thread(r) for r in rows]
    pinned = [t for t in threads if t["is_pinned"]]
    recent = [t for t in threads if not t["is_pinned"]]
    return jsonify({"success": True, "pinned": pinned, "recent": recent})


@image_chatbot_bp.route("/thread/<thread_id>", methods=["GET"])
def api_thread_detail(thread_id):
    row = get_thread_row(thread_id)
    if not row:
        return jsonify({"success": False, "error": "Chat not found."}), 404
    msgs = get_message_rows(thread_id)
    return jsonify({
        "success": True,
        "thread": _serialize_thread(row),
        "messages": [_serialize_message(m) for m in msgs],
    })


@image_chatbot_bp.route("/thread/<thread_id>/rename", methods=["POST"])
def api_rename_thread(thread_id):
    if not get_thread_row(thread_id):
        return jsonify({"success": False, "error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"success": False, "error": "Title cannot be empty."}), 400
    rename_thread_row(thread_id, title)
    return jsonify({"success": True, "thread": _serialize_thread(get_thread_row(thread_id))})


@image_chatbot_bp.route("/thread/<thread_id>/pin", methods=["POST"])
def api_pin_thread(thread_id):
    row = get_thread_row(thread_id)
    if not row:
        return jsonify({"success": False, "error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    pinned = data.get("pinned")
    pinned = (not row["is_pinned"]) if pinned is None else bool(pinned)
    set_pin_row(thread_id, pinned)
    return jsonify({"success": True, "thread": _serialize_thread(get_thread_row(thread_id))})


@image_chatbot_bp.route("/thread/<thread_id>/archive", methods=["POST"])
def api_archive_thread(thread_id):
    row = get_thread_row(thread_id)
    if not row:
        return jsonify({"success": False, "error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    archived = data.get("archived")
    archived = (not row["is_archived"]) if archived is None else bool(archived)
    set_archive_row(thread_id, archived)
    return jsonify({"success": True, "thread": _serialize_thread(get_thread_row(thread_id))})


@image_chatbot_bp.route("/thread/<thread_id>", methods=["DELETE"])
def api_delete_thread(thread_id):
    row = get_thread_row(thread_id)
    if not row:
        return jsonify({"success": False, "error": "Chat not found."}), 404
    if row["img_path"] and os.path.isfile(row["img_path"]):
        try:
            os.remove(row["img_path"])
        except OSError:
            pass
    delete_thread_row(thread_id)
    _drop_langgraph_thread(thread_id)
    return jsonify({"success": True})


@image_chatbot_bp.route("/thread/<thread_id>/download", methods=["GET"])
def api_download_thread(thread_id):
    row = get_thread_row(thread_id)
    if not row:
        return jsonify({"success": False, "error": "Chat not found."}), 404
    msgs = get_message_rows(thread_id)
    lines = [
        "S.N.E.T.C.H — Image Chatbot Transcript",
        f"Chat: {row['title']}",
        f"Image: {row['img_name'] or 'N/A'}",
        "=" * 60, "",
    ]
    for m in msgs:
        who = "You" if m["role"] == "user" else "Assistant"
        ts = datetime.fromtimestamp(m["created_at"]).strftime("%Y-%m-%d %H:%M")
        lines.append(f"[{ts}] {who}:\n{m['content']}\n")
    text = "\n".join(lines)
    buf = io.BytesIO(text.encode("utf-8"))
    buf.seek(0)
    safe_name = secure_filename(row["title"] or "chat") or "chat"
    return send_file(buf, mimetype="text/plain", as_attachment=True,
                      download_name=f"{safe_name}.txt")


@image_chatbot_bp.route("/message/<int:message_id>/feedback", methods=["POST"])
def api_message_feedback(message_id):
    data = request.get_json(force=True, silent=True) or {}
    feedback = data.get("type", "none")
    if feedback not in ("like", "dislike", "none"):
        return jsonify({"success": False, "error": "Invalid feedback type."}), 400
    set_message_feedback_row(message_id, feedback)
    return jsonify({"success": True})


def _stream_answer_response(thread_id: str, question: str, save_user_message: bool):
    """Shared SSE generator for /ask and /regenerate."""
    row = get_thread_row(thread_id)
    if not row or row["processing_status"] != "ready":
        def err_gen():
            yield f"data: {json.dumps({'error': 'No image is ready for this chat yet.'})}\n\n"
        return err_gen()

    if save_user_message:
        add_message_row(thread_id, "user", question)
        touch_thread(thread_id)

    def generate():
        q: queue.Queue = queue.Queue()
        state = {"text": ""}

        def on_token(t):
            state["text"] += t
            q.put(t)

        def worker():
            try:
                final = process_image_query(thread_id, question, stream=True, on_token=on_token)
                if not state["text"] and final:
                    state["text"] = final
            except Exception as e:
                q.put(("__ERROR__", str(e)))
            finally:
                q.put(None)

        threading.Thread(target=worker, daemon=True).start()

        while True:
            item = q.get()
            if item is None:
                break
            if isinstance(item, tuple) and item[0] == "__ERROR__":
                yield f"data: {json.dumps({'error': item[1]})}\n\n"
                return
            yield f"data: {json.dumps({'token': item})}\n\n"

        answer = state["text"].strip() or "I couldn't generate a response. Please try again."
        msg_id = add_message_row(thread_id, "assistant", answer)
        touch_thread(thread_id)
        _sync_langgraph_memory(thread_id, question, answer)
        yield f"data: {json.dumps({'done': True, 'message_id': msg_id, 'answer': answer})}\n\n"

    return generate()


@image_chatbot_bp.route("/ask", methods=["POST"])
def api_ask():
    data = request.get_json(force=True, silent=True) or {}
    thread_id = (data.get("thread_id") or "").strip()
    question = (data.get("question") or "").strip()
    if not thread_id or not get_thread_row(thread_id):
        return jsonify({"success": False, "error": "Invalid chat thread."}), 400
    if not question:
        return jsonify({"success": False, "error": "Question cannot be empty."}), 400

    return Response(
        stream_with_context(_stream_answer_response(thread_id, question, save_user_message=True)),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@image_chatbot_bp.route("/regenerate", methods=["POST"])
def api_regenerate():
    data = request.get_json(force=True, silent=True) or {}
    thread_id = (data.get("thread_id") or "").strip()
    row = get_thread_row(thread_id)
    if not row:
        return jsonify({"success": False, "error": "Invalid chat thread."}), 400

    msgs = get_message_rows(thread_id)
    if not msgs or msgs[-1]["role"] != "assistant":
        return jsonify({"success": False, "error": "Nothing to regenerate yet."}), 400

    question = None
    for m in reversed(msgs):
        if m["role"] == "user":
            question = m["content"]
            break
    if not question:
        return jsonify({"success": False, "error": "No previous question found."}), 400

    delete_message_row(msgs[-1]["id"])

    return Response(
        stream_with_context(_stream_answer_response(thread_id, question, save_user_message=False)),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def register_image_chatbot(app) -> None:
    """Wire this feature's API into the main Flask app.

    image_chatbot.py deliberately does not import app.py (to avoid
    touching any other feature/file). Add these two lines once in
    app.py, near the other feature imports:

        import image_chatbot
        image_chatbot.register_image_chatbot(app)
    """
    init_image_chatbot_db()
    app.register_blueprint(image_chatbot_bp)


# Always make sure the database/upload folders exist, even if the Flask
# app never calls register_image_chatbot() (e.g. CLI-only usage).
init_image_chatbot_db()


def main():
    print("=== S.N.E.T.C.H Image AI Chatbot ===")
    print("This feature runs as a Flask blueprint mounted at /image_chatbot.")
    print("Start the main app with:  python app.py")
    print(f"Vision model expected: {VISION_MODEL} (via local Ollama)")
    if not is_ollama_ready():
        print("⚠ Local Ollama is not reachable right now.")
        print(f"  Start it and run: ollama pull {VISION_MODEL}")


if __name__ == "__main__":
    main()
