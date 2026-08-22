"""
askanything.py — S.N.E.T.C.H "Ask Anything" AI Chat Assistant (backend module)

ChatGPT-style multi-chat backend used by app.py:
    • create / list / search / rename / delete chats
    • pin chats & archive chats
    • persist full message history per chat
    • stream AI replies token-by-token (generator, consumed by a Flask
      streaming response in app.py)
    • regenerate the last AI reply
    • export a chat as plain text for download

Storage: a dedicated SQLite file (db_storage/askanything_data.db) — kept
separate from the shared auth DB (db.py) so this feature stays fully
self-contained, the same way alarm.py owns alarm.json.

AI backend: a local Ollama model via langchain_ollama. The model is loaded
lazily so the rest of this module (chat list/rename/pin/search/etc.) keeps
working even if langchain_ollama isn't installed or Ollama isn't running —
in that case, streaming falls back to a clear in-chat error message instead
of crashing the request.
"""

import os
import time
import uuid
import sqlite3
from langchain_groq import ChatGroq
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "db_storage", "askanything_data.db")

GROQ_MODEL = "openai/gpt-oss-120b"   # ya jo bhi Groq model chaho

AI_UNAVAILABLE_MSG = (
    " S.N.E.T.C.H's AI engine isn't reachable right now (the local Ollama "
    "model isn't running). Please start Ollama and try again."
)

SYSTEM_PROMPT = """
You are S.N.E.T.C.H.

S.N.E.T.C.H. stands for:
Smart Neural Engine for Task Control and Hub.

You are the official AI assistant integrated into this application.

=================================================
IDENTITY
=================================================

Always identify yourself as S.N.E.T.C.H.

Never say you are ChatGPT, GPT, OpenAI, Qwen, Llama, or any other AI assistant.

If the user asks:

- Who are you?
- What is your name?
- Introduce yourself.
- Tell me about yourself.
- What are you?
- What is S.N.E.T.C.H.?
- What does S.N.E.T.C.H. stand for?
- What is your full form?
- Can I call you S.N.E.T.C.H.?
- What should I call you?

Reply naturally.

Name:
"My name is S.N.E.T.C.H."

Full Form:
"S.N.E.T.C.H. stands for Smart Neural Engine  Task Control and Hub."

Description:
"I am the AI assistant integrated into this application."

=================================================
CREATOR
=================================================

If the user asks:

- Who created you?
- Who made you?
- Who developed you?
- Who is your creator?
- Who built you?
- Who built this application?
- Who owns you?

Reply:

"I was created and developed by Mr. Amit Kumawat"

=================================================
PURPOSE
=================================================

If the user asks:

- Why were you created?
- What is your purpose?
- Why do you exist?

Reply:

"My purpose is to intelligently assist users and help them use all the features available in this application."

=================================================
CONTROL
=================================================

If the user asks:

- Who controls you?
- Who is your boss?
- Who manages you?

Reply:

"I operate according to my programming and the instructions defined for this application."

=================================================
CAPABILITIES
=================================================

If the user asks:

- What can you do?
- What are your capabilities?
- How can you help me?

Reply with a concise summary like:

"I can answer questions, assist with programming, explain concepts, solve problems, analyze information, remember previous conversations, and help with the features available in this application."

=================================================
MODEL QUESTIONS
=================================================

If the user asks:

- Are you ChatGPT?
- Are you OpenAI?
- Are you GPT?
- Are you Qwen?
- What model are you?

Reply:

"No. I am S.N.E.T.C.H., the AI assistant integrated into this application."

Do not reveal the underlying model unless the user explicitly asks about the technical implementation.

=================================================
BEHAVIOR
=================================================

- Answer only what the user asks.
- Keep responses concise unless more detail is requested.
- Use previous conversation memory when relevant.
- Never invent unavailable features.
- If a feature is unavailable, politely say it is not currently supported.
"""

DEFAULT_TITLE = "New Chat"


# ══════════════════════════════════════════════════════════════════
#  DATABASE
# ══════════════════════════════════════════════════════════════════

def get_conn():
    folder = os.path.dirname(DB_PATH)
    os.makedirs(folder, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    """)
    conn.commit()
    conn.close()


def _chat_to_dict(row):
    return {
        "id": row["id"],
        "title": row["title"],
        "pinned": bool(row["pinned"]),
        "archived": bool(row["archived"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _msg_to_dict(row):
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        "created_at": row["created_at"],
    }


# ══════════════════════════════════════════════════════════════════
#  CHAT CRUD
# ══════════════════════════════════════════════════════════════════

def create_chat(title=None):
    chat_id = uuid.uuid4().hex
    now = int(time.time())
    conn = get_conn()
    conn.execute(
        "INSERT INTO chats (id, title, pinned, archived, created_at, updated_at) "
        "VALUES (?,?,0,0,?,?)",
        (chat_id, (title or DEFAULT_TITLE).strip() or DEFAULT_TITLE, now, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM chats WHERE id=?", (chat_id,)).fetchone()
    conn.close()
    return _chat_to_dict(row)


def list_chats(query=None, archived_only=False):
    conn = get_conn()
    if query:
        like = f"%{query.strip()}%"
        rows = conn.execute(
            """
            SELECT DISTINCT c.* FROM chats c
            LEFT JOIN messages m ON m.chat_id = c.id
            WHERE c.archived = ? AND (c.title LIKE ? OR m.content LIKE ?)
            ORDER BY c.pinned DESC, c.updated_at DESC
            """,
            (1 if archived_only else 0, like, like),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM chats WHERE archived=? ORDER BY pinned DESC, updated_at DESC",
            (1 if archived_only else 0,),
        ).fetchall()
    conn.close()
    return [_chat_to_dict(r) for r in rows]


def get_chat(chat_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM chats WHERE id=?", (chat_id,)).fetchone()
    if not row:
        conn.close()
        return None
    msg_rows = conn.execute(
        "SELECT * FROM messages WHERE chat_id=? ORDER BY id ASC", (chat_id,)
    ).fetchall()
    conn.close()
    chat = _chat_to_dict(row)
    chat["messages"] = [_msg_to_dict(m) for m in msg_rows]
    return chat


def chat_exists(chat_id):
    conn = get_conn()
    row = conn.execute("SELECT id FROM chats WHERE id=?", (chat_id,)).fetchone()
    conn.close()
    return row is not None


def rename_chat(chat_id, title):
    title = (title or "").strip()
    if not title:
        return False
    conn = get_conn()
    cur = conn.execute(
        "UPDATE chats SET title=?, updated_at=? WHERE id=?",
        (title, int(time.time()), chat_id),
    )
    conn.commit()
    ok = cur.rowcount > 0
    conn.close()
    return ok


def delete_chat(chat_id):
    conn = get_conn()
    conn.execute("DELETE FROM messages WHERE chat_id=?", (chat_id,))
    cur = conn.execute("DELETE FROM chats WHERE id=?", (chat_id,))
    conn.commit()
    ok = cur.rowcount > 0
    conn.close()
    return ok


def set_pinned(chat_id, pinned):
    conn = get_conn()
    cur = conn.execute("UPDATE chats SET pinned=? WHERE id=?", (1 if pinned else 0, chat_id))
    conn.commit()
    ok = cur.rowcount > 0
    conn.close()
    return ok


def set_archived(chat_id, archived):
    conn = get_conn()
    cur = conn.execute("UPDATE chats SET archived=? WHERE id=?", (1 if archived else 0, chat_id))
    conn.commit()
    ok = cur.rowcount > 0
    conn.close()
    return ok


def _touch_chat(chat_id):
    conn = get_conn()
    conn.execute("UPDATE chats SET updated_at=? WHERE id=?", (int(time.time()), chat_id))
    conn.commit()
    conn.close()


def _maybe_autotitle(chat_id, text):
    """The first user message in a chat becomes its title (like ChatGPT),
    as long as the user hasn't already renamed it."""
    conn = get_conn()
    row = conn.execute("SELECT title FROM chats WHERE id=?", (chat_id,)).fetchone()
    if row and row["title"] == DEFAULT_TITLE:
        title = " ".join(text.strip().split())
        if len(title) > 48:
            title = title[:45].rstrip() + "..."
        conn.execute("UPDATE chats SET title=? WHERE id=?", (title or DEFAULT_TITLE, chat_id))
        conn.commit()
    conn.close()


# ══════════════════════════════════════════════════════════════════
#  MESSAGES
# ══════════════════════════════════════════════════════════════════

def add_message(chat_id, role, content):
    now = int(time.time())
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO messages (chat_id, role, content, created_at) VALUES (?,?,?,?)",
        (chat_id, role, content, now),
    )
    conn.commit()
    msg_id = cur.lastrowid
    conn.close()
    return {"id": msg_id, "role": role, "content": content, "created_at": now}


def get_messages(chat_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM messages WHERE chat_id=? ORDER BY id ASC", (chat_id,)
    ).fetchall()
    conn.close()
    return [_msg_to_dict(r) for r in rows]


def delete_last_assistant_message(chat_id):
    """Used by Regenerate: removes the most recent assistant reply so a
    fresh one can take its place."""
    conn = get_conn()
    row = conn.execute(
        "SELECT id FROM messages WHERE chat_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
        (chat_id,),
    ).fetchone()
    if row:
        conn.execute("DELETE FROM messages WHERE id=?", (row["id"],))
        conn.commit()
    conn.close()


def export_chat_text(chat_id):
    """Plain-text export used by the Download Chat option."""
    chat = get_chat(chat_id)
    if not chat:
        return None
    lines = [f"S.N.E.T.C.H — {chat['title']}", "=" * 60, ""]
    for m in chat["messages"]:
        who = "You" if m["role"] == "user" else "S.N.E.T.C.H"
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(m["created_at"]))
        lines.append(f"[{ts}] {who}:")
        lines.append(m["content"])
        lines.append("")
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════
#  AI MODEL (lazy-loaded so the rest of the feature works without it)
# ══════════════════════════════════════════════════════════════════

_chain = None
_chain_load_failed = False


def _get_chain():
    global _chain, _chain_load_failed
    if _chain is not None or _chain_load_failed:
        return _chain
    try:
        from langchain_groq import ChatGroq
        from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

        model = ChatGroq(model=GROQ_MODEL, api_key=os.getenv("GROQ_API_KEY"))
        prompt = ChatPromptTemplate.from_messages([
            ("system", SYSTEM_PROMPT),
            MessagesPlaceholder(variable_name="messages"),
        ])
        _chain = prompt | model
    except Exception as e:
        print(f"[ASKANYTHING] AI model unavailable: {type(e).__name__}: {e}")
        _chain_load_failed = True
    return _chain


def _to_lc_messages(history):
    from langchain_core.messages import HumanMessage, AIMessage
    lc_messages = []
    for m in history:
        if m["role"] == "user":
            lc_messages.append(HumanMessage(content=m["content"]))
        else:
            lc_messages.append(AIMessage(content=m["content"]))
    return lc_messages


def _stream_from_history(chat_id, history):
    """Shared streaming core used by both stream_reply() and
    regenerate_reply(): streams the AI's reply chunk-by-chunk, then
    persists the finished message once streaming completes."""
    chain = _get_chain()

    if chain is None:
        add_message(chat_id, "assistant", AI_UNAVAILABLE_MSG)
        _touch_chat(chat_id)
        yield AI_UNAVAILABLE_MSG
        return

    full = []
    try:
        lc_messages = _to_lc_messages(history)
        for chunk in chain.stream({"messages": lc_messages}):
            piece = getattr(chunk, "content", "") or ""
            if piece:
                full.append(piece)
                yield piece
        final_text = "".join(full).strip() or "..."
        add_message(chat_id, "assistant", final_text)
    except Exception as e:
        err_msg = f"⚠️ Something went wrong while generating a response: {e}"
        # Persist whatever partial text streamed before the failure, so a
        # retry/regenerate has something sensible to replace.
        add_message(chat_id, "assistant", "".join(full).strip() or err_msg)
        if not full:
            yield err_msg
    finally:
        _touch_chat(chat_id)


def stream_reply(chat_id, user_text):
    """Generator: persists the user's message, streams the AI reply, and
    persists the finished assistant message. Consumed by a streaming Flask
    response in app.py."""
    add_message(chat_id, "user", user_text)
    _maybe_autotitle(chat_id, user_text)
    history = get_messages(chat_id)
    yield from _stream_from_history(chat_id, history)


def regenerate_reply(chat_id):
    """Generator: drops the last assistant reply and streams a fresh one
    using the same preceding conversation context."""
    delete_last_assistant_message(chat_id)
    history = get_messages(chat_id)
    yield from _stream_from_history(chat_id, history)
