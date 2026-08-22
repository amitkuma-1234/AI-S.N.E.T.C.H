"""
horoscopeapi.py — S.N.E.T.C.H AI ASTROLOGY ASSISTANT (backend module)

Premium, chat-driven astrology consultation flow used by app.py:

    1. create a session                       -> create_session()
    2. save the 5 personal details             -> save_details()
    3. confirm details (locks the profile)     -> confirm_details()
    4. drive the chat (query -> 5 dynamic         stream_message()
       follow-up questions -> final reading)
    5. regenerate the last AI message          -> regenerate_last()
    6. like / dislike a message                -> set_feedback()

Storage: a dedicated SQLite file (db_storage/horoscope_data.db) — kept
separate from every other feature's storage, the same way askanything.py
owns askanything_data.db.

AI backend: a local Ollama model via langchain_ollama (same engine used by
askanything.py). The model is loaded lazily so the rest of this module
(session/details/verify/etc.) keeps working even if langchain_ollama isn't
installed or Ollama isn't running — in that case, generation falls back to
clear, still-useful text instead of crashing the request.
"""

import os
import re
import time
import uuid
import json
import sqlite3
import hashlib

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "db_storage", "horoscope_data.db")

GROQ_MODEL = "openai/gpt-oss-120b"

ZODIAC_SIGNS = [
    "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
    "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
]

WELCOME_QUESTION = "✨ Your details are confirmed! Now tell me — what would you like to know?"

# Emitted once, between the direct answer and the first follow-up question,
# so the frontend can split one streamed response into two chat bubbles.
# This is generated entirely by our own code (never by the LLM), so there is
# no risk of it colliding with real model output.
HA_SPLIT_MARKER = "\u2063HA-SPLIT-MARKER\u2063"

READING_SECTIONS = [
    "Summary", "Main Prediction", "Detailed Analysis", "Positive Factors",
    "Challenges", "Suggestions", "Lucky Color", "Lucky Number",
    "Lucky Day", "Recommended Actions",
]

# Statuses a session can be in:
#   awaiting_details   -> personal details not yet submitted
#   awaiting_confirm    -> details submitted, waiting for user to hit Confirm
#   awaiting_query      -> profile confirmed, waiting for the main question
#   awaiting_followup   -> main question received, working through 5 AI questions
#   complete            -> final reading has been generated


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
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            dob TEXT NOT NULL DEFAULT '',
            birth_time TEXT NOT NULL DEFAULT '',
            birth_place TEXT NOT NULL DEFAULT '',
            zodiac TEXT NOT NULL DEFAULT '',
            query TEXT NOT NULL DEFAULT '',
            questions_json TEXT NOT NULL DEFAULT '[]',
            answers_json TEXT NOT NULL DEFAULT '[]',
            step INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'awaiting_details',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'chat',
            rating TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL
        )
    """)
    conn.commit()
    conn.close()


def _row_to_session(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "dob": row["dob"],
        "birth_time": row["birth_time"],
        "birth_place": row["birth_place"],
        "zodiac": row["zodiac"],
        "query": row["query"],
        "questions": json.loads(row["questions_json"] or "[]"),
        "answers": json.loads(row["answers_json"] or "[]"),
        "step": row["step"],
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _msg_to_dict(row):
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        "kind": row["kind"],
        "rating": row["rating"],
        "created_at": row["created_at"],
    }


# ══════════════════════════════════════════════════════════════════
#  SESSION CRUD
# ══════════════════════════════════════════════════════════════════

def create_session():
    session_id = uuid.uuid4().hex
    now = int(time.time())
    conn = get_conn()
    conn.execute(
        "INSERT INTO sessions (id, status, created_at, updated_at) VALUES (?,?,?,?)",
        (session_id, "awaiting_details", now, now),
    )
    conn.commit()
    conn.close()
    return get_session(session_id)


def session_exists(session_id):
    conn = get_conn()
    row = conn.execute("SELECT id FROM sessions WHERE id=?", (session_id,)).fetchone()
    conn.close()
    return row is not None


def get_session(session_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        conn.close()
        return None
    msg_rows = conn.execute(
        "SELECT * FROM messages WHERE session_id=? ORDER BY id ASC", (session_id,)
    ).fetchall()
    conn.close()
    data = _row_to_session(row)
    data["messages"] = [_msg_to_dict(m) for m in msg_rows]
    return data


def _touch(session_id):
    conn = get_conn()
    conn.execute("UPDATE sessions SET updated_at=? WHERE id=?", (int(time.time()), session_id))
    conn.commit()
    conn.close()


def save_details(session_id, name, dob, birth_time, birth_place, zodiac):
    """STEP 1-5: store the 5 personal details, move to awaiting_confirm."""
    conn = get_conn()
    conn.execute(
        """UPDATE sessions
           SET name=?, dob=?, birth_time=?, birth_place=?, zodiac=?,
               status='awaiting_confirm', updated_at=?
           WHERE id=?""",
        (name.strip(), dob.strip(), birth_time.strip(), birth_place.strip(),
         zodiac.strip().capitalize(), int(time.time()), session_id),
    )
    conn.commit()
    conn.close()
    return get_session(session_id)


def confirm_details(session_id):
    """VERIFY DETAILS -> Confirm: locks the profile and opens the chat."""
    conn = get_conn()
    conn.execute(
        "UPDATE sessions SET status='awaiting_query', updated_at=? WHERE id=?",
        (int(time.time()), session_id),
    )
    conn.commit()
    conn.close()
    add_message(session_id, "assistant", WELCOME_QUESTION, kind="welcome")
    return get_session(session_id)


def reset_to_details(session_id):
    """EDIT: send the user back to Step 1 without losing the session id."""
    conn = get_conn()
    conn.execute(
        "UPDATE sessions SET status='awaiting_details', updated_at=? WHERE id=?",
        (int(time.time()), session_id),
    )
    conn.commit()
    conn.close()
    return get_session(session_id)


# ══════════════════════════════════════════════════════════════════
#  MESSAGES
# ══════════════════════════════════════════════════════════════════

def add_message(session_id, role, content, kind="chat"):
    now = int(time.time())
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, kind, rating, created_at) VALUES (?,?,?,?,'',?)",
        (session_id, role, content, kind, now),
    )
    conn.commit()
    msg_id = cur.lastrowid
    conn.close()
    return {"id": msg_id, "role": role, "content": content, "kind": kind, "rating": "", "created_at": now}


def get_messages(session_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM messages WHERE session_id=? ORDER BY id ASC", (session_id,)
    ).fetchall()
    conn.close()
    return [_msg_to_dict(r) for r in rows]


def delete_last_assistant_message(session_id):
    conn = get_conn()
    row = conn.execute(
        "SELECT id FROM messages WHERE session_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    if row:
        conn.execute("DELETE FROM messages WHERE id=?", (row["id"],))
        conn.commit()
    conn.close()


def set_feedback(session_id, message_id, kind):
    """kind is 'like', 'dislike', or '' to clear."""
    conn = get_conn()
    cur = conn.execute(
        "UPDATE messages SET rating=? WHERE id=? AND session_id=?",
        (kind, message_id, session_id),
    )
    conn.commit()
    ok = cur.rowcount > 0
    conn.close()
    return ok


# ══════════════════════════════════════════════════════════════════
#  AI MODEL (lazy-loaded so the rest of this module works without it)
# ══════════════════════════════════════════════════════════════════

_model = None
_model_load_failed = False

code_block_re = re.compile(r"```[a-zA-Z0-9]*\n?(.*?)```", re.DOTALL)


def clean_code(text):
    return code_block_re.sub(lambda m: m.group(1), text or "").strip()


def _get_model():
    global _model, _model_load_failed
    if _model is not None or _model_load_failed:
        return _model
    try:
        from langchain_groq import ChatGroq
        _model = ChatGroq(model=GROQ_MODEL, api_key=os.getenv("GROQ_API_KEY"))
    except Exception as e:
        print(f"[HOROSCOPEAPI] AI model unavailable: {type(e).__name__}: {e}")
        _model_load_failed = True
    return _model


def _profile_context(state):
    ctx = (
        f"Name: {state['name']}\n"
        f"Date of Birth: {state['dob']}\n"
        f"Birth Time: {state['birth_time'] or 'Not provided'}\n"
        f"Birth Place: {state['birth_place']}\n"
        f"Zodiac Sign: {state['zodiac']}\n"
        f"User's Main Question: {state['query']}\n"
    )
    if state["questions"]:
        ctx += "\nConsultation Q&A so far:\n"
        for i, q in enumerate(state["questions"]):
            a = state["answers"][i] if i < len(state["answers"]) else ""
            if a:
                ctx += f"  Q{i + 1}: {q}\n  A{i + 1}: {a}\n"
    return ctx


# ── Follow-up question generation (5 at once, stored internally) ──────

_FALLBACK_QUESTIONS = [
    "What specific challenges have you faced recently regarding this?",
    "How has this situation influenced your state of mind or emotions?",
    "Are there any external pressures or people playing a major role here?",
    "What is your ideal resolution or outcome that you're hoping for?",
    "Is there any past event or pattern you've noticed related to this?",
]

# Query-aware fallback question sets, used only when the AI model itself is
# unavailable, so even the "no model" fallback still feels tailored to what
# the user actually asked instead of always showing the same 5 lines.
_TOPIC_FALLBACK_QUESTIONS = [
    (
        ("wife", "husband", "spouse", "partner's name", "future wife", "future husband"),
        [
            "Have you ever been in love?",
            "Is there someone you currently like?",
            "Has anyone ever shown romantic interest in you?",
            "What qualities do you want in your future partner?",
            "What are you currently doing — study, job, or business?",
        ],
    ),
    (
        ("marry", "marriage", "wedding"),
        [
            "What is your current relationship status?",
            "How is your career or work life going right now?",
            "Do you feel any family expectations around marriage?",
            "What do you look for in a life partner?",
            "What are your plans for the next couple of years?",
        ],
    ),
    (
        ("rich", "wealth", "money", "financial", "finance"),
        [
            "How would you describe your current career situation?",
            "Are you involved in any business or side ventures?",
            "Do you currently invest, save, or have any financial goals?",
            "What is your educational or professional background?",
            "How would you describe your day-to-day financial habits?",
        ],
    ),
    (
        ("career", "job", "profession", "promotion", "business"),
        [
            "What field or industry are you currently working in?",
            "What are your biggest strengths at work?",
            "What challenges are you facing in your career right now?",
            "Are you considering switching fields or starting something new?",
            "What does your ideal career look like a few years from now?",
        ],
    ),
    (
        ("love", "relationship", "boyfriend", "girlfriend", "crush"),
        [
            "Are you currently in a relationship?",
            "What has your dating or relationship history been like?",
            "Is there someone specific on your mind right now?",
            "What matters most to you in a relationship?",
            "How do you usually handle conflicts with people close to you?",
        ],
    ),
    (
        ("health", "illness", "recovery"),
        [
            "How would you describe your overall health lately?",
            "Are there any specific health concerns on your mind?",
            "How is your daily routine — sleep, diet, and exercise?",
            "Have you experienced any recent stress or lifestyle changes?",
            "Are you currently following any treatment or wellness plan?",
        ],
    ),
]


def _fallback_questions_for(query):
    """Pick a topic-matched fallback question set, so even a model outage
    still asks something related to the user's actual question."""
    q = (query or "").lower()
    for keywords, questions in _TOPIC_FALLBACK_QUESTIONS:
        if any(k in q for k in keywords):
            return list(questions)
    return list(_FALLBACK_QUESTIONS)


def _generate_five_questions(state):
    model = _get_model()
    if model is None:
        return _fallback_questions_for(state.get("query", ""))

    prompt = f"""You are an expert Vedic astrologer conducting a personal consultation.

Client Details:
Name: {state['name']}
Date of Birth: {state['dob']}
Birth Time: {state['birth_time'] or 'Not provided'}
Birth Place: {state['birth_place']}
Zodiac Sign: {state['zodiac']}
User's Main Question: {state['query']}

You need to ask exactly 5 highly relevant, distinct, and personalized follow-up
questions to deeply understand the client's situation before giving a reading.

Rules:
- Generate exactly 5 follow-up questions.
- The questions must be tailored to their specific query and birth details.
- Do NOT make the questions generic. Make them insightful and natural.
- Format the output as a clean numbered list:
  1. [First Question]
  2. [Second Question]
  3. [Third Question]
  4. [Fourth Question]
  5. [Fifth Question]

Respond with ONLY the 5 numbered questions. No extra text, intro, or explanation."""

    try:
        response = model.invoke(prompt)
        text = clean_code(getattr(response, "content", "") or "")
        lines = re.split(r"\n+", text)
        parsed = []
        for line in lines:
            line = line.strip()
            match = re.match(r"^\d+[\.\)]\s*(.*)", line)
            if match and match.group(1).strip():
                parsed.append(match.group(1).strip())
            elif line and not re.match(r"^\d+\s*$", line):
                parsed.append(re.sub(r"^\d+\s*", "", line).strip())
        parsed = [q for q in parsed if q]
        fallback = _fallback_questions_for(state.get("query", ""))
        while len(parsed) < 5:
            parsed.append(fallback[len(parsed) % len(fallback)])
        return parsed[:5]
    except Exception as e:
        print(f"[HOROSCOPEAPI] question generation failed: {e}")
        return _fallback_questions_for(state.get("query", ""))


def _regenerate_one_question(state, index):
    """Regenerate a single follow-up question (used by Regenerate)."""
    fallback = _fallback_questions_for(state.get("query", ""))
    model = _get_model()
    if model is None:
        return fallback[index % len(fallback)]

    prompt = f"""You are an expert Vedic astrologer mid-consultation.

{_profile_context(state)}

Ask ONE new, highly relevant follow-up question (different from the ones already
asked above) to better understand the client's situation before giving a final
reading. Respond with ONLY the single question text, nothing else."""
    try:
        response = model.invoke(prompt)
        text = clean_code(getattr(response, "content", "") or "").strip()
        text = re.sub(r"^\d+[\.\)]\s*", "", text).strip('"').strip()
        return text or fallback[index % len(fallback)]
    except Exception as e:
        print(f"[HOROSCOPEAPI] question regeneration failed: {e}")
        return fallback[index % len(fallback)]


def _fake_stream(text, chunk_size=3):
    """Yield already-known text in small word chunks so short AI messages
    (like a follow-up question) still get a smooth typing/streaming feel in
    the UI, consistent with the real token-streamed final reading below."""
    words = text.split(" ")
    buf = []
    for i, w in enumerate(words):
        buf.append(w)
        if len(buf) >= chunk_size or i == len(words) - 1:
            piece = " ".join(buf)
            if i != len(words) - 1:
                piece += " "
            yield piece
            buf = []


# ── Final reading generation (real token streaming) ────────────────────

READING_PROMPT_TEMPLATE = """You are a highly experienced Vedic astrologer giving a
deeply personal, premium astrology reading to a client at the end of a full
consultation.

{context}

Based on ALL the information above — birth details, zodiac sign, the client's
original question, and every follow-up answer they gave — write ONE detailed,
personalized reading that directly answers their original question.

Format your response EXACTLY as Markdown using these ten section headings, in
this order, each on its own line starting with "## ":

## Summary
## Main Prediction
## Detailed Analysis
## Positive Factors
## Challenges
## Suggestions
## Lucky Color
## Lucky Number
## Lucky Day
## Recommended Actions

Guidelines:
- Reference their zodiac sign and relevant planetary influences naturally.
- Connect their follow-up answers to astrological insight.
- "Summary" and "Main Prediction" should directly address their original question.
- "Positive Factors", "Challenges", and "Suggestions" should each be short bullet
  points (use "- " at the start of each line).
- "Lucky Color", "Lucky Number", and "Lucky Day" should each be ONE short value
  (e.g. "Emerald Green", "7", "Thursday") optionally with a one-line reason.
- "Recommended Actions" should be a short bullet list of practical next steps.
- Be warm, empathetic, insightful, and encouraging — like a real one-on-one reading.
- Do not include any text before "## Summary" or after the last section.
"""

FALLBACK_READING = """## Summary
The stars indicate a period of growth and transformation ahead for you.

## Main Prediction
Trust your instincts during this phase — the cosmic currents favor steady,
patient progress over sudden leaps.

## Detailed Analysis
Your AI astrologer's connection to the celestial engine is temporarily
unavailable, so this is a general reading rather than a fully personalized
one. Please try again shortly for a complete, detailed analysis.

## Positive Factors
- A supportive planetary period for personal effort
- Opportunities favor those who stay consistent

## Challenges
- Avoid impulsive decisions in the coming weeks

## Suggestions
- Revisit your question once the AI engine is back online for a full reading

## Lucky Color
Blue

## Lucky Number
7

## Lucky Day
Thursday

## Recommended Actions
- Stay patient and consistent
- Re-run this reading later for full personalization
"""


def _reading_prompt(state):
    prompt = READING_PROMPT_TEMPLATE.format(context=_profile_context(state))
    if _is_name_query(state.get("query", "")):
        prompt += (
            "\n\nIMPORTANT: The client's ORIGINAL question was asking for an "
            "actual NAME. In the \"Summary\" section AND the \"Main Prediction\" "
            "section, you MUST state one specific, concrete first name as the "
            "astrological answer (e.g. \"Ananya\") — lead with the name itself "
            "in the first sentence of each of those two sections. Do not "
            "substitute a description of personality traits for an actual name."
        )
    return prompt


def _stream_reading(state):
    """Generator: real token-by-token streaming of the final reading."""
    model = _get_model()
    if model is None:
        yield from _fake_stream(FALLBACK_READING, chunk_size=6)
        return

    try:
        any_chunk = False
        for chunk in model.stream(_reading_prompt(state)):
            piece = getattr(chunk, "content", "") or ""
            if piece:
                any_chunk = True
                yield piece
        if not any_chunk:
            yield from _fake_stream(FALLBACK_READING, chunk_size=6)
    except Exception as e:
        print(f"[HOROSCOPEAPI] reading generation failed: {e}")
        yield from _fake_stream(FALLBACK_READING, chunk_size=6)


def _stream_freeform_answer(state, question):
    """Post-reading free chat: answer a follow-up question using full
    consultation context, still in the astrologer's voice."""
    model = _get_model()
    prompt = f"""You are the same Vedic astrologer who just gave this client a full
reading.

{_profile_context(state)}

The client now asks an additional question: "{question}"

Answer it warmly and insightfully, staying consistent with their profile and
the reading you already gave them. Keep it focused (2-4 paragraphs), in plain
prose (no markdown headings needed)."""
    if model is None:
        yield from _fake_stream(
            "I'm having trouble reaching the celestial engine right now — "
            "please try asking again in a moment.",
            chunk_size=6,
        )
        return
    try:
        any_chunk = False
        for chunk in model.stream(prompt):
            piece = getattr(chunk, "content", "") or ""
            if piece:
                any_chunk = True
                yield piece
        if not any_chunk:
            yield "The stars are quiet on this one — could you rephrase your question?"
    except Exception as e:
        print(f"[HOROSCOPEAPI] freeform answer failed: {e}")
        yield "⚠️ Something went wrong while consulting the stars. Please try again."


# ── Direct, confident answer (comes FIRST, before the 5 follow-ups) ────

_DIRECT_ANSWER_TOPICS = [
    (("wife's name", "wife name", "future wife"), "Possible Future Wife Name"),
    (("husband's name", "husband name", "future husband"), "Possible Future Husband Name"),
    (("spouse's name", "spouse name", "partner's name", "partner name"), "Possible Future Partner Name"),
    (("marry", "marriage", "wedding"), "Expected Marriage Time"),
    (("rich", "wealth", "money", "financial", "finance"), "Financial Outlook"),
    (("career", "job", "profession", "promotion", "business"), "Best Career"),
    (("love", "relationship", "boyfriend", "girlfriend", "crush"), "Relationship Outlook"),
    (("health", "illness", "recovery"), "Health Outlook"),
]


def _direct_answer_label(query):
    """Pick a short, confident label for the direct-answer line, based on
    what the user actually asked (falls back to a generic label)."""
    q = (query or "").lower()
    for keywords, label in _DIRECT_ANSWER_TOPICS:
        if any(k in q for k in keywords):
            return label
    return "Direct Answer"


def _is_name_query(query):
    """True when the client is explicitly asking for an actual NAME, not
    just a description (e.g. "my future wife's name" / "husband name kya
    hoga"), so we can force a concrete name instead of personality traits."""
    q = (query or "").lower()
    return "name" in q and any(
        k in q for k in ("wife", "husband", "spouse", "partner", "soulmate", "life partner")
    )


DIRECT_ANSWER_PROMPT_TEMPLATE = """You are an expert Vedic astrologer. A client just
asked you the following question at the very start of a consultation:

{context}

Give a DIRECT, CONFIDENT, immediate answer to their exact question above — no
long introduction, no disclaimers, and no "let me check your chart first"
preamble. Respond with 2-4 short, confident sentences that clearly answer
what they asked, grounded naturally in their zodiac sign and birth details.
You will ask follow-up questions afterwards, so do NOT ask any questions here
— only the direct answer itself, in plain prose (no markdown headings)."""

_NAME_QUERY_INSTRUCTION = (
    "\n\nIMPORTANT: The client is asking for an actual NAME, not a description "
    "of personality traits. You MUST lead with ONE specific, concrete first "
    "name as your direct astrological impression (e.g. \"Ananya\" or \"Rohan\") "
    "— do not describe qualities instead of naming someone, and do not hedge "
    "with a list of several options. State the name itself in the very first "
    "sentence, then you may add one short supporting sentence about why it "
    "resonates (starting letter, nakshatra, or numerology), but the name must "
    "come first and be unambiguous."
)

_FALLBACK_DIRECT_ANSWER = (
    "The stars already point to a promising path here — your chart shows real "
    "potential on this front. I'll sharpen this further once I understand a "
    "little more about your situation."
)

_FALLBACK_NAMES_WIFE = ["Ananya", "Priya", "Ishita", "Riya", "Meera", "Kavya", "Anika"]
_FALLBACK_NAMES_HUSBAND = ["Arjun", "Rohan", "Aditya", "Vikram", "Kabir", "Aryan", "Dev"]


def _pick_fallback_name(state, label):
    """Deterministic (but per-profile) fallback name, used only when the AI
    model is unavailable and the client asked for an actual name."""
    pool = _FALLBACK_NAMES_HUSBAND if "Husband" in label else _FALLBACK_NAMES_WIFE
    seed = f"{state.get('name', '')}-{state.get('dob', '')}-{state.get('birth_place', '')}".encode("utf-8")
    idx = int(hashlib.md5(seed).hexdigest(), 16) % len(pool)
    return pool[idx]


def _fallback_direct_answer_text(state, label):
    if _is_name_query(state.get("query", "")):
        name = _pick_fallback_name(state, label)
        return (
            f"{name} — this name resonates strongly with the planetary influences "
            f"in your chart right now."
        )
    return _FALLBACK_DIRECT_ANSWER


def _direct_answer_prompt(state):
    prompt = DIRECT_ANSWER_PROMPT_TEMPLATE.format(context=_profile_context(state))
    if _is_name_query(state.get("query", "")):
        prompt += _NAME_QUERY_INSTRUCTION
    return prompt


def _stream_direct_answer(state):
    """Generator: streams the confident, direct answer that must appear
    immediately after the user's main question, before the 5 follow-ups."""
    label = _direct_answer_label(state.get("query", ""))
    yield f"**{label}:**\n\n"

    fallback_text = _fallback_direct_answer_text(state, label)
    model = _get_model()
    if model is None:
        yield from _fake_stream(fallback_text, chunk_size=6)
        return
    try:
        any_chunk = False
        for chunk in model.stream(_direct_answer_prompt(state)):
            piece = getattr(chunk, "content", "") or ""
            if piece:
                any_chunk = True
                yield piece
        if not any_chunk:
            yield from _fake_stream(fallback_text, chunk_size=6)
    except Exception as e:
        print(f"[HOROSCOPEAPI] direct answer generation failed: {e}")
        yield from _fake_stream(fallback_text, chunk_size=6)


# ══════════════════════════════════════════════════════════════════
#  CHAT DRIVER — the single endpoint that powers the whole
#  question -> direct answer -> 5 follow-ups -> final reading -> free chat flow
# ══════════════════════════════════════════════════════════════════

def _persist_answers(conn, session_id, answers):
    conn.execute(
        "UPDATE sessions SET answers_json=?, updated_at=? WHERE id=?",
        (json.dumps(answers), int(time.time()), session_id),
    )


def stream_message(session_id, user_text):
    """Generator consumed by a streaming Flask response. Handles every
    stage of the conversation depending on the session's current status."""
    state = get_session(session_id)
    if state is None:
        yield "⚠️ Session not found. Please start a new reading."
        return

    add_message(session_id, "user", user_text, kind="chat")
    status = state["status"]

    # ── Stage 1: this message IS the user's main astrology question ──
    if status == "awaiting_query":
        conn = get_conn()
        conn.execute(
            "UPDATE sessions SET query=?, status='awaiting_followup', step=0, updated_at=? WHERE id=?",
            (user_text.strip(), int(time.time()), session_id),
        )
        conn.commit()
        conn.close()

        state = get_session(session_id)

        # 1) Direct, confident answer FIRST — appears immediately.
        direct_full = []
        for piece in _stream_direct_answer(state):
            direct_full.append(piece)
            yield piece
        add_message(session_id, "assistant", "".join(direct_full).strip(), kind="direct_answer")

        # Marker so the frontend splits this one stream into two bubbles.
        yield HA_SPLIT_MARKER

        # 2) Then kick off the personalized analysis: 5 dynamic follow-ups,
        #    generated fresh from THIS query (never generic/static).
        questions = _generate_five_questions(state)
        conn = get_conn()
        conn.execute(
            "UPDATE sessions SET questions_json=? WHERE id=?",
            (json.dumps(questions), session_id),
        )
        conn.commit()
        conn.close()

        full = []
        for piece in _fake_stream(questions[0]):
            full.append(piece)
            yield piece
        add_message(session_id, "assistant", "".join(full).strip(), kind="question")
        _touch(session_id)
        return

    # ── Stage 2: this message answers the current follow-up question ──
    if status == "awaiting_followup":
        answers = state["answers"] + [user_text.strip()]
        next_step = state["step"] + 1

        conn = get_conn()
        _persist_answers(conn, session_id, answers)

        if next_step < 5:
            conn.execute(
                "UPDATE sessions SET step=? WHERE id=?", (next_step, session_id)
            )
            conn.commit()
            conn.close()

            state = get_session(session_id)
            next_question = state["questions"][next_step]
            full = []
            for piece in _fake_stream(next_question):
                full.append(piece)
                yield piece
            add_message(session_id, "assistant", "".join(full).strip(), kind="question")
            _touch(session_id)
            return

        # All 5 follow-ups answered -> generate the final reading (real stream)
        conn.execute(
            "UPDATE sessions SET step=?, status='complete' WHERE id=?",
            (next_step, session_id),
        )
        conn.commit()
        conn.close()

        state = get_session(session_id)
        full = []
        for piece in _stream_reading(state):
            full.append(piece)
            yield piece
        add_message(session_id, "assistant", "".join(full).strip(), kind="reading")
        _touch(session_id)
        return

    # ── Stage 3: reading already complete -> free-form astrology chat ──
    full = []
    for piece in _stream_freeform_answer(state, user_text):
        full.append(piece)
        yield piece
    add_message(session_id, "assistant", "".join(full).strip(), kind="chat")
    _touch(session_id)


def regenerate_last(session_id):
    """Generator: regenerate the most recent AI message, matching whatever
    stage it belonged to (a follow-up question or the final reading)."""
    state = get_session(session_id)
    if state is None:
        yield "⚠️ Session not found. Please start a new reading."
        return

    delete_last_assistant_message(session_id)
    status = state["status"]

    if status == "awaiting_followup":
        idx = state["step"]
        new_question = _regenerate_one_question(state, idx)
        questions = list(state["questions"])
        if idx < len(questions):
            questions[idx] = new_question
        conn = get_conn()
        conn.execute(
            "UPDATE sessions SET questions_json=? WHERE id=?",
            (json.dumps(questions), session_id),
        )
        conn.commit()
        conn.close()

        full = []
        for piece in _fake_stream(new_question):
            full.append(piece)
            yield piece
        add_message(session_id, "assistant", "".join(full).strip(), kind="question")
        _touch(session_id)
        return

    if status == "complete":
        full = []
        for piece in _stream_reading(state):
            full.append(piece)
            yield piece
        add_message(session_id, "assistant", "".join(full).strip(), kind="reading")
        _touch(session_id)
        return

    # Nothing meaningful to regenerate (e.g. still on the static welcome line)
    yield WELCOME_QUESTION
    add_message(session_id, "assistant", WELCOME_QUESTION, kind="welcome")
    _touch(session_id)