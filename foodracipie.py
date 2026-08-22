"""
foodracipie.py — S.N.E.T.C.H "AI Recipe Assistant" (backend module)

ChatGPT-style multi-chat recipe backend used by app.py:
    • create / list / search / rename / delete chats
    • pin chats & archive chats
    • persist full message history + recipe metadata per chat
    • stream AI replies token-by-token (generator, consumed by a Flask
      streaming response in app.py)
    • regenerate the last AI reply
    • export a chat as a Markdown (.md) file for download

Memory model:
    • LangGraph (StateGraph + MessagesState) owns the live conversational
      memory for each chat. Every chat = one LangGraph Thread (thread_id
      == chat_id). A brand new Thread is created automatically whenever a
      new chat is created — it starts with zero memory.
    • The LangGraph checkpointer is a SqliteSaver pointed at
      db_storage/foodrecipe_checkpoints.db, so thread memory survives an
      app restart.
    • A second, human-readable SQLite database (db_storage/
      foodrecipe_data.db) stores chat metadata (title, recipe name, pin/
      archive flags, timestamps, download info) and the full message
      history used to render the sidebar, search, and chat panel, and to
      build the downloadable transcript. Both stores are updated together
      on every turn, so they stay in sync.

AI backend: a local Ollama model via langchain_ollama, wrapped in a
LangGraph graph. Everything is loaded lazily so the rest of this module
(chat list/rename/pin/search/etc.) keeps working even if langgraph /
langchain_ollama aren't installed or Ollama isn't running — in that case,
streaming falls back to a clear in-chat error message instead of crashing
the request.
"""

import os
import time
import uuid
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_STORAGE_DIR = os.path.join(BASE_DIR, "db_storage")
DB_PATH = os.path.join(DB_STORAGE_DIR, "foodrecipe_data.db")
CHECKPOINT_DB_PATH = os.path.join(DB_STORAGE_DIR, "foodrecipe_checkpoints.db")

GROQ_MODEL = "openai/gpt-oss-120b"

AI_UNAVAILABLE_MSG = (
    "⚠️ S.N.E.T.C.H's AI engine isn't reachable right now (the local Ollama "
    "model isn't running). Please start Ollama and try again."
)

DEFAULT_TITLE = "New Chat"

SYSTEM_PROMPT = """You are S.N.E.T.C.H's AI Recipe Assistant — a warm, professional
chef who gives complete, premium-quality cooking tutorials.

WHEN THE USER NAMES A DISH (e.g. "Paneer Butter Masala", "Biryani", "Pizza"),
generate a COMPLETE recipe using EXACTLY this Markdown structure and these
exact headings:

# [Dish Name]

[2-3 warm, inviting lines about this dish — what makes it special.]

## 🍽️ Overview
- **Serving Size:** [e.g. Serves 4]
- **Preparation Time:** [e.g. 15 mins]
- **Cooking Time:** [e.g. 25 mins]
- **Total Time:** [e.g. 40 mins]
- **Difficulty Level:** [Easy / Medium / Hard]

## 🛒 Ingredients
- [exact quantity] [ingredient name]
(group logically if needed, e.g. "For the marinade", "For the gravy")

## 🔧 Required Kitchen Tools
- [tool name]

## 👨‍🍳 Step-by-Step Cooking Instructions
1. [Clear, concise instruction — include time and heat level where relevant]
2. [Next step...]

## 💡 Chef Tips
- [Practical, genuinely useful tip]

## ⚠️ Common Mistakes to Avoid
- [Mistake and why it hurts the dish]

## 🔥 Nutritional Information
- Approximate values per serving: Calories, Protein, Carbs, Fat
(only include if you can give a sensible estimate; otherwise omit this section)

## 🍴 Serving Suggestions
- [What to pair it with, garnish ideas]

## 📦 Storage Instructions
[How to store leftovers, how long it lasts, reheating advice — only if applicable]

## 🔄 Variations
- [Variation name]: [Brief description]
(only include if there are genuine, well-known variations)

STRICT RULES:
- Use exact measurements (tbsp, tsp, cups, grams, ml).
- Keep language simple, warm, and beginner-friendly, like advice from a
  great cook standing next to the user.
- Never skip Overview, Ingredients, Tools, Steps, Chef Tips, or Common
  Mistakes. Nutrition, Storage, and Variations may be omitted only when
  genuinely not applicable.

WHEN THE USER ASKS A FOLLOW-UP QUESTION about the SAME recipe (e.g.
"Explain step 4", "Can I replace butter with oil?", "Is there a vegetarian
version?", "How can I make it spicy?", "Can I cook this in an air fryer?"):
- Do NOT regenerate the entire recipe.
- Answer directly and conversationally, using Markdown (short paragraphs,
  bullet points, or a numbered list) as appropriate.
- Always use the earlier conversation in this thread to know which recipe
  and which steps are being discussed.

Never say you are ChatGPT, GPT, OpenAI, Qwen, or Llama. If asked, say you
are S.N.E.T.C.H's AI Recipe Assistant.
"""


# ══════════════════════════════════════════════════════════════════
#  METADATA DATABASE (chats, messages)
# ══════════════════════════════════════════════════════════════════

def get_conn():
    os.makedirs(DB_STORAGE_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            recipe_name TEXT,
            pinned INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            download_count INTEGER NOT NULL DEFAULT 0,
            last_downloaded_at INTEGER
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
        "recipe_name": row["recipe_name"],
        "pinned": bool(row["pinned"]),
        "archived": bool(row["archived"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "download_count": row["download_count"],
        "last_downloaded_at": row["last_downloaded_at"],
    }


def _msg_to_dict(row):
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        "created_at": row["created_at"],
    }


# ══════════════════════════════════════════════════════════════════
#  CHAT CRUD  (each chat id doubles as its LangGraph thread_id)
# ══════════════════════════════════════════════════════════════════

def create_chat(title=None):
    """New Chat -> new row + implicitly a brand new LangGraph Thread
    (the thread is created lazily in LangGraph on the first message,
    since a thread_id with no checkpoint simply starts with empty
    memory)."""
    chat_id = uuid.uuid4().hex
    now = int(time.time())
    conn = get_conn()
    conn.execute(
        "INSERT INTO chats (id, title, recipe_name, pinned, archived, created_at, updated_at, download_count) "
        "VALUES (?,?,NULL,0,0,?,?,0)",
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
            WHERE c.archived = ? AND (
                c.title LIKE ? OR c.recipe_name LIKE ? OR m.content LIKE ?
            )
            ORDER BY c.pinned DESC, c.updated_at DESC
            """,
            (1 if archived_only else 0, like, like, like),
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
    if ok:
        _delete_thread_checkpoint(chat_id)
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


def _maybe_autotitle(chat_id, dish_text):
    """The first user message (the dish name) becomes both the chat title
    and the stored recipe name, as long as the user hasn't renamed it."""
    conn = get_conn()
    row = conn.execute("SELECT title FROM chats WHERE id=?", (chat_id,)).fetchone()
    if row and row["title"] == DEFAULT_TITLE:
        title = " ".join(dish_text.strip().split())
        if len(title) > 48:
            title = title[:45].rstrip() + "..."
        conn.execute(
            "UPDATE chats SET title=?, recipe_name=? WHERE id=?",
            (title or DEFAULT_TITLE, dish_text.strip()[:120], chat_id),
        )
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


def export_chat_markdown(chat_id):
    """Markdown export used by the Download Chat option — the recipe
    content is already Markdown, so this keeps it fully readable."""
    chat = get_chat(chat_id)
    if not chat:
        return None
    lines = [f"# S.N.E.T.C.H Recipe Assistant — {chat['title']}", ""]
    for m in chat["messages"]:
        who = "🧑 You" if m["role"] == "user" else "🤖 S.N.E.T.C.H"
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(m["created_at"]))
        lines.append(f"**{who}** · _{ts}_")
        lines.append("")
        lines.append(m["content"])
        lines.append("\n---\n")

    conn = get_conn()
    conn.execute(
        "UPDATE chats SET download_count = download_count + 1, last_downloaded_at = ? WHERE id=?",
        (int(time.time()), chat_id),
    )
    conn.commit()
    conn.close()
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════
#  LANGGRAPH — thread-scoped conversational memory
#  Each chat_id IS a LangGraph thread_id. A new chat -> a brand new
#  thread with a unique id and zero prior memory. SqliteSaver persists
#  every thread's state to CHECKPOINT_DB_PATH so it survives restarts.
# ══════════════════════════════════════════════════════════════════

_graph = None
_model = None
_graph_load_failed = False


def _get_graph():
    """Lazily builds the LangGraph StateGraph + SqliteSaver checkpointer.
    Returns None (and flips _graph_load_failed) if langgraph / the model
    aren't available, so the rest of the feature keeps working."""
    global _graph, _model, _graph_load_failed
    if _graph is not None or _graph_load_failed:
        return _graph
    try:
        from langchain_groq import ChatGroq
        from langchain_core.messages import SystemMessage
        from langgraph.graph import StateGraph, MessagesState, START, END
        from langgraph.checkpoint.sqlite import SqliteSaver

        os.makedirs(DB_STORAGE_DIR, exist_ok=True)
        conn = sqlite3.connect(CHECKPOINT_DB_PATH, check_same_thread=False)
        checkpointer = SqliteSaver(conn)

        _model = ChatGroq(model=GROQ_MODEL, api_key=os.getenv("GROQ_API_KEY"), temperature=0.7)

        def chef_node(state):
            messages = [SystemMessage(content=SYSTEM_PROMPT)] + state["messages"]
            response = _model.invoke(messages)
            return {"messages": [response]}

        builder = StateGraph(MessagesState)
        builder.add_node("chef", chef_node)
        builder.add_edge(START, "chef")
        builder.add_edge("chef", END)
        _graph = builder.compile(checkpointer=checkpointer)
    except Exception as e:
        print(f"[FOODRECIPE] LangGraph unavailable, falling back to direct model calls: {type(e).__name__}: {e}")
        _graph_load_failed = True
    return _graph


def _delete_thread_checkpoint(chat_id):
    """Best-effort cleanup of a thread's LangGraph checkpoint rows when
    its chat is permanently deleted."""
    try:
        if not os.path.exists(CHECKPOINT_DB_PATH):
            return
        conn = sqlite3.connect(CHECKPOINT_DB_PATH)
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'checkpoint%'"
        ).fetchall()]
        for t in tables:
            try:
                conn.execute(f"DELETE FROM {t} WHERE thread_id=?", (chat_id,))
            except Exception:
                pass
        conn.commit()
        conn.close()
    except Exception:
        pass


def _stream_direct(history):
    """Fallback path used only if LangGraph itself failed to load: keeps
    the feature functional using plain ChatOllama + the SQLite message
    history passed in, the same resilience pattern used elsewhere in
    S.N.E.T.C.H (see askanything.py)."""
    try:
        from langchain_groq import ChatGroq
        from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
    except Exception:
        yield AI_UNAVAILABLE_MSG
        return

    model = ChatGroq(model=GROQ_MODEL, api_key=os.getenv("GROQ_API_KEY"), temperature=0.7)
    lc_messages = [SystemMessage(content=SYSTEM_PROMPT)]
    for m in history:
        lc_messages.append(HumanMessage(content=m["content"]) if m["role"] == "user" else AIMessage(content=m["content"]))

    try:
        for chunk in model.stream(lc_messages):
            piece = getattr(chunk, "content", "") or ""
            if piece:
                yield piece
    except Exception as e:
        yield f"⚠️ Something went wrong while generating a response: {e}"


def stream_reply(chat_id, user_text):
    """Generator: persists the user's message, streams the AI reply via
    this chat's LangGraph thread, and persists the finished assistant
    message. Consumed by a streaming Flask response in app.py."""
    add_message(chat_id, "user", user_text)
    _maybe_autotitle(chat_id, user_text)

    graph = _get_graph()
    full = []

    if graph is not None:
        from langchain_core.messages import HumanMessage
        config = {"configurable": {"thread_id": chat_id}}
        try:
            streamed_any = False
            for chunk, _meta in graph.stream(
                {"messages": [HumanMessage(content=user_text)]},
                config=config,
                stream_mode="messages",
            ):
                piece = getattr(chunk, "content", "") or ""
                if piece:
                    streamed_any = True
                    full.append(piece)
                    yield piece
            if not streamed_any:
                state = graph.get_state(config)
                msgs = state.values.get("messages", [])
                if msgs:
                    text = getattr(msgs[-1], "content", "") or "..."
                    full.append(text)
                    yield text
        except Exception as e:
            err_msg = f"⚠️ Something went wrong while generating a response: {e}"
            if not full:
                full.append(err_msg)
                yield err_msg
    else:
        history = get_messages(chat_id)
        for piece in _stream_direct(history):
            full.append(piece)
            yield piece

    final_text = "".join(full).strip() or "..."
    add_message(chat_id, "assistant", final_text)
    _touch_chat(chat_id)


def regenerate_reply(chat_id):
    """Generator: drops the last assistant reply (both in our SQLite
    history and in the LangGraph thread state) and streams a fresh one
    using the same preceding conversation context, without duplicating
    the human message that's already stored in the thread."""
    delete_last_assistant_message(chat_id)

    graph = _get_graph()
    full = []

    if graph is not None:
        try:
            from langchain_core.messages import RemoveMessage, AIMessage, SystemMessage
            config = {"configurable": {"thread_id": chat_id}}
            state = graph.get_state(config)
            msgs = state.values.get("messages", [])
            last_ai = next((m for m in reversed(msgs) if isinstance(m, AIMessage)), None)
            if last_ai is not None and getattr(last_ai, "id", None):
                graph.update_state(config, {"messages": [RemoveMessage(id=last_ai.id)]})

            trimmed_state = graph.get_state(config)
            trimmed_msgs = trimmed_state.values.get("messages", [])

            for chunk in _model.stream([SystemMessage(content=SYSTEM_PROMPT)] + trimmed_msgs):
                piece = getattr(chunk, "content", "") or ""
                if piece:
                    full.append(piece)
                    yield piece

            final = "".join(full).strip() or "..."
            graph.update_state(config, {"messages": [AIMessage(content=final)]})
        except Exception as e:
            err_msg = f"⚠️ Something went wrong while regenerating: {e}"
            if not full:
                full = [err_msg]
                yield err_msg
    else:
        history = get_messages(chat_id)
        for piece in _stream_direct(history):
            full.append(piece)
            yield piece

    final_text = "".join(full).strip() or "..."
    add_message(chat_id, "assistant", final_text)
    _touch_chat(chat_id)
