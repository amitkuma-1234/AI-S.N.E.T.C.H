# ============================================================
#  youtube_chatbot.py — YouTube Video AI Chatbot (S.N.E.T.C.H)
#  Local Ollama + hybrid RAG (semantic + keyword) over transcripts
# ============================================================

import io
import os
import re
import json
import time
import uuid
import queue
import sqlite3
import logging
import threading
import requests
import urllib.request
import urllib.parse
from datetime import datetime
from typing import Callable

from flask import (
    Blueprint, request, jsonify, Response, stream_with_context, send_file,
)
from werkzeug.utils import secure_filename

def speak(text: str) -> None:
    """Text-only output (was TTS)."""
    print(f"[SNETCH] {text}")

try:
    from utils.logger import logger
except ImportError:
    logger = logging.getLogger("youtube_chatbot")
    logging.basicConfig(level=logging.INFO)

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

try:
    import numpy as np
    import yt_dlp
    from sentence_transformers import SentenceTransformer, CrossEncoder
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity
    YT_DEPS_OK = True
except ImportError:
    YT_DEPS_OK = False
    logger.warning(
        "YouTube chatbot deps missing. Run: "
        "pip install youtube-transcript-api sentence-transformers scikit-learn numpy"
    )

try:
    from langchain_groq import ChatGroq
    from langchain_core.messages import HumanMessage
    from langgraph.graph import StateGraph, START, END
    from langgraph.graph.message import add_messages
    from langgraph.checkpoint.memory import MemorySaver
    from typing import TypedDict, Annotated
    LANGGRAPH_OK = True
except ImportError:
    LANGGRAPH_OK = False

try:
    from googlesearch import search as google_search
    WEB_SEARCH_OK = True
except ImportError:
    WEB_SEARCH_OK = False

# ── Config ──────────────────────────────────────────────────
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL   = "openai/gpt-oss-120b"
OLLAMA_TIMEOUT_SEC = 120
NOT_IN_VIDEO       = "This information is not available in the video."

CHUNK_MAX_WORDS    = 120
CHUNK_OVERLAP_SENTS = 2
FULL_TRANSCRIPT_WORD_LIMIT = 4500
WIDE_CONTEXT_CHUNKS = 24

_embed_model = None
_reranker = None
_chat_model = None
_graph_store = {}
_sessions = {}
_active_video_id = None

# ── Web feature config (Flask blueprint, SQLite, per-thread sessions) ──
BASE_DIR       = os.path.dirname(os.path.abspath(__file__))
YT_COOKIES_FILE = os.path.join(BASE_DIR, "www.youtube.com_cookies.txt")
DB_STORAGE_DIR = os.path.join(BASE_DIR, "db_storage")
YT_DB_PATH     = os.path.join(DB_STORAGE_DIR, "youtube_chatbot.db")
CHECKPOINT_DB_PATH = os.path.join(DB_STORAGE_DIR, "youtube_chatbot_checkpoints.db")

_web_sessions = {}      # thread_id -> session dict (same shape as _new_session)
_web_graph_store = {}   # thread_id -> {"graph":..., "config":...}
_checkpointer_singleton = None


# ════════════════════════════════════════════════════════════
#  OLLAMA
# ════════════════════════════════════════════════════════════

def is_ollama_ready() -> bool:
    return bool(os.getenv("GROQ_API_KEY"))


def _ollama_error() -> str:
    return "GROQ_API_KEY not set in .env file."


def ask_ollama(prompt: str, temperature: float = 0.2, system: str = "") -> str:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        "stream": False,
        "temperature": temperature,
    }
    try:
        resp = requests.post(
            GROQ_API_URL,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {os.getenv('GROQ_API_KEY')}",
            },
            json=payload,
            timeout=OLLAMA_TIMEOUT_SEC,
        )
        resp.raise_for_status()
        body = resp.json()
        return body["choices"][0]["message"]["content"].strip()
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Groq call failed: {e}")


def ask_ollama_stream(prompt: str, temperature: float = 0.2, system: str = "",
                      on_token: Callable[[str], None] | None = None) -> str:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        "stream": True,
        "temperature": temperature,
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


def _get_chat_model():
    global _chat_model
    if _chat_model is None and LANGGRAPH_OK:
        _chat_model = ChatGroq(
            model=GROQ_MODEL, api_key=os.getenv("GROQ_API_KEY"), temperature=0.2,
        )
    return _chat_model


# ════════════════════════════════════════════════════════════
#  MODELS & SESSION
# ════════════════════════════════════════════════════════════

def _get_embed_model():
    global _embed_model
    if _embed_model is None:
        logger.info("Loading embedding model...")
        _embed_model = SentenceTransformer("all-mpnet-base-v2")
    return _embed_model


def _get_reranker():
    global _reranker
    if _reranker is None:
        logger.info("Loading reranker model...")
        _reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
    return _reranker


def _new_session(video_id: str) -> dict:
    return {
        "video_id": video_id,
        "title": "",
        "author": "",
        "duration_sec": 0,
        "segments": [],
        "chunks": [],
        "chunk_vectors": None,
        "tfidf": None,
        "tfidf_matrix": None,
        "transcript_text": "",
        "use_full": False,
        "history": [],
        "lang_hint": "",
    }


def _active() -> dict | None:
    if _active_video_id and _active_video_id in _sessions:
        return _sessions[_active_video_id]
    return None


# ════════════════════════════════════════════════════════════
#  HELPERS
# ════════════════════════════════════════════════════════════

_SCRIPT_RANGES = [
    ("Hindi/Marathi (Devanagari script)", r"[\u0900-\u097F]"),
    ("Tamil", r"[\u0B80-\u0BFF]"),
    ("Telugu", r"[\u0C00-\u0C7F]"),
    ("Kannada", r"[\u0C80-\u0CFF]"),
    ("Malayalam", r"[\u0D00-\u0D7F]"),
    ("Bengali", r"[\u0980-\u09FF]"),
    ("Gujarati", r"[\u0A80-\u0AFF]"),
    ("Punjabi (Gurmukhi)", r"[\u0A00-\u0A7F]"),
    ("Japanese", r"[\u3040-\u30FF\u4E00-\u9FFF]"),
    ("Korean", r"[\uAC00-\uD7AF]"),
    ("Arabic/Urdu", r"[\u0600-\u06FF]"),
    ("Russian (Cyrillic)", r"[\u0400-\u04FF]"),
    ("Chinese", r"[\u4E00-\u9FFF]"),
    ("Thai", r"[\u0E00-\u0E7F]"),
]


def _detect_language_hint(text: str) -> str:
    """Best-effort detection of the transcript's spoken/subtitle language,
    used only to remind the LLM to translate internally and respond in
    English. Never used to change how the transcript itself is stored."""
    sample = text[:3000]
    for name, pattern in _SCRIPT_RANGES:
        if re.search(pattern, sample):
            return name
    lower = sample.lower()
    if re.search(r"[ñáéíóúü]", lower) and re.search(r"\b(el|la|los|las|de|que|para|con|una|esta)\b", lower):
        return "Spanish"
    if re.search(r"[àâçéèêëîïôùûœ]", lower) and re.search(r"\b(le|la|les|des|est|pour|avec|une|cette)\b", lower):
        return "French"
    if re.search(r"[äöüß]", lower) and re.search(r"\b(der|die|das|und|ist|für|mit|eine)\b", lower):
        return "German"
    if re.search(r"[ãõç]", lower) and re.search(r"\b(o|a|os|as|de|que|para|com|uma|esta)\b", lower):
        return "Portuguese"
    return ""


def _extract_video_id(url: str) -> str | None:
    match = re.search(r"(?:v=|\/|youtu\.be\/)([0-9A-Za-z_-]{11})", url)
    return match.group(1) if match else None


def _format_ts(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _parse_ts(text: str) -> float | None:
    text = text.strip()
    m = re.match(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$", text)
    if not m:
        return None
    if m.group(3) is not None:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    return int(m.group(1)) * 60 + int(m.group(2))


def _fetch_video_metadata(video_id: str) -> dict:
    url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "S.N.E.T.C.H/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return {"title": data.get("title", ""), "author": data.get("author_name", "")}
    except Exception:
        return {"title": "", "author": ""}


_VTT_TIME_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})"
)
_VTT_INLINE_TAG_RE = re.compile(r"<[^>]+>")  # strips <c>, <00:00:01.000> word-timing tags, etc.


def _vtt_timestamp_to_seconds(h, m, s, ms) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _parse_vtt_to_segments(vtt_text: str) -> list:
    """Parses WebVTT subtitle text (what yt-dlp downloads) into
    [{"text", "start", "duration"}, ...] segments — the same shape
    the rest of this file already expects, so nothing downstream
    needs to change."""
    segments = []
    blocks = re.split(r"\n\s*\n", vtt_text.strip())
    last_text = None  # auto-captions often repeat the previous line — skip exact repeats
    for block in blocks:
        lines = [l for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        time_line_idx = None
        for i, line in enumerate(lines):
            if "-->" in line:
                time_line_idx = i
                break
        if time_line_idx is None:
            continue
        m = _VTT_TIME_RE.search(lines[time_line_idx])
        if not m:
            continue
        start = _vtt_timestamp_to_seconds(*m.groups()[0:4])
        end = _vtt_timestamp_to_seconds(*m.groups()[4:8])

        text_lines = lines[time_line_idx + 1:]
        text = " ".join(text_lines).strip()
        text = _VTT_INLINE_TAG_RE.sub("", text).strip()
        if not text or text == last_text:
            continue
        last_text = text
        segments.append({"text": text, "start": start, "duration": max(0.0, end - start)})
    return segments


def _get_transcript_segments(video_id: str):
    """Fetches captions via yt-dlp instead of youtube-transcript-api.
    yt-dlp supports cookies properly (youtube-transcript-api's cookie
    support is disabled upstream as of this writing), which is what
    lets this keep working when the server's IP gets flagged by
    YouTube as a bot/datacenter address."""
    if not YT_DEPS_OK:
        return None, "unknown"

    url = f"https://www.youtube.com/watch?v={video_id}"
    lang_priority = ["en", "en-US", "en-GB", "hi", "hi-IN"]

    ydl_opts = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": lang_priority,
        "subtitlesformat": "vtt",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
    }
    if os.path.isfile(YT_COOKIES_FILE) and os.path.getsize(YT_COOKIES_FILE) > 0:
        ydl_opts["cookiefile"] = YT_COOKIES_FILE

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        msg = str(e).lower()
        if "private" in msg or "unavailable" in msg:
            return None, "unavailable"
        logger.error(f"Transcript fetch (yt-dlp) error: {e}")
        return None, "unknown"
    except Exception as e:
        logger.error(f"Transcript fetch (yt-dlp) error: {e}")
        return None, "unknown"

    if info is None:
        return None, "unavailable"

    manual_subs = info.get("subtitles") or {}
    auto_subs = info.get("automatic_captions") or {}

    def _pick_track(subs_dict):
        for lang in lang_priority:
            if lang in subs_dict:
                return subs_dict[lang]
        return None

    track = _pick_track(manual_subs) or _pick_track(auto_subs)
    if not track:
        return None, "disabled" if not manual_subs and not auto_subs else "no_transcript"

    vtt_entry = next((f for f in track if f.get("ext") == "vtt"), track[0] if track else None)
    if not vtt_entry or not vtt_entry.get("url"):
        return None, "no_transcript"

    try:
        resp = requests.get(vtt_entry["url"], timeout=15)
        resp.raise_for_status()
        segments = _parse_vtt_to_segments(resp.text)
    except Exception as e:
        logger.error(f"Transcript download/parse error: {e}")
        return None, "unknown"

    if not segments:
        return None, "no_transcript"
    return segments, None


def _sentence_aware_chunks_with_ts(segments: list, max_words: int = CHUNK_MAX_WORDS,
                                   overlap_sentences: int = CHUNK_OVERLAP_SENTS) -> list:
    words_with_ts = []
    for seg in segments:
        for w in seg["text"].split():
            words_with_ts.append((w, seg["start"]))

    full_text = " ".join(w for w, _ in words_with_ts)
    sentences = re.split(r"(?<=[.!?])\s+", full_text.strip())
    sentences = [s.strip() for s in sentences if s.strip()]

    chunks, word_idx = [], 0
    current_sentences, current_word_count = [], 0
    chunk_start_ts = words_with_ts[0][1] if words_with_ts else 0

    for sentence in sentences:
        sent_word_count = len(sentence.split())
        sent_start_ts = words_with_ts[word_idx][1] if word_idx < len(words_with_ts) else chunk_start_ts
        word_idx += sent_word_count

        if current_word_count + sent_word_count > max_words and current_sentences:
            chunk_end_ts = words_with_ts[min(word_idx - 1, len(words_with_ts) - 1)][1]
            chunks.append({
                "text": " ".join(current_sentences),
                "start": chunk_start_ts,
                "end": chunk_end_ts,
            })
            overlap = current_sentences[-overlap_sentences:]
            current_sentences = overlap
            current_word_count = sum(len(s.split()) for s in overlap)
            chunk_start_ts = sent_start_ts

        current_sentences.append(sentence)
        current_word_count += sent_word_count

    if current_sentences:
        chunk_end_ts = words_with_ts[-1][1] if words_with_ts else chunk_start_ts
        chunks.append({
            "text": " ".join(current_sentences),
            "start": chunk_start_ts,
            "end": chunk_end_ts,
        })
    return chunks


def _index_session(session: dict):
    chunks = session["chunks"]
    if len(chunks) <= 1:
        session["use_full"] = True
        return

    embed_model = _get_embed_model()
    texts = [c["text"] for c in chunks]
    session["chunk_vectors"] = embed_model.encode(texts, normalize_embeddings=True)
    session["tfidf"] = TfidfVectorizer(stop_words="english", max_features=50000)
    session["tfidf_matrix"] = session["tfidf"].fit_transform(texts)
    session["use_full"] = False


def _sample_chunks(chunks: list, n: int = 16) -> list:
    if len(chunks) <= n:
        return chunks
    step = max(1, len(chunks) // n)
    return chunks[::step][:n]


def _format_chunks(chunks: list, label: str = "Excerpt") -> str:
    return "\n\n".join(
        f"[{label} @ {_format_ts(c['start'])}–{_format_ts(c['end'])}]: {c['text']}"
        for c in chunks
    )


def _retrieve_chunks(session: dict, query: str, top_k: int = 12, final_k: int = 6) -> list:
    if session["use_full"]:
        return session["chunks"]

    chunks = session["chunks"]
    chunk_vectors = session["chunk_vectors"]
    tfidf = session["tfidf"]
    tfidf_matrix = session["tfidf_matrix"]

    embed_model = _get_embed_model()
    query_vec = embed_model.encode([query], normalize_embeddings=True)
    semantic_scores = np.dot(chunk_vectors, query_vec.T).flatten()

    query_tfidf = tfidf.transform([query])
    keyword_scores = cosine_similarity(query_tfidf, tfidf_matrix).flatten()

    hybrid = 0.6 * semantic_scores + 0.4 * keyword_scores
    top_indices = np.argsort(hybrid)[-top_k:][::-1]
    candidates = [(idx, chunks[idx]) for idx in top_indices]

    reranker = _get_reranker()
    pairs = [[query, c["text"]] for _, c in candidates]
    scores = reranker.predict(pairs)

    ranked = sorted(zip(scores, candidates), key=lambda x: x[0], reverse=True)
    result = [c for _, (_, c) in ranked[:final_k]]
    result.sort(key=lambda c: c["start"])
    return result


def _retrieve_context(session: dict, query: str, top_k: int = 12, final_k: int = 6) -> str:
    chunks = _retrieve_chunks(session, query, top_k, final_k)
    if session["use_full"] and len(chunks) == 1:
        c = chunks[0]
        return f"[Full transcript @ {_format_ts(c['start'])}–{_format_ts(c['end'])}]: {c['text']}"
    return _format_chunks(chunks)


def _wide_context(session: dict, query: str = "overview summary key points") -> str:
    chunks = _sample_chunks(session["chunks"], 20)
    if not session["use_full"]:
        extra = _retrieve_chunks(session, query, top_k=8, final_k=4)
        seen = {c["start"] for c in chunks}
        for c in extra:
            if c["start"] not in seen:
                chunks.append(c)
                seen.add(c["start"])
        chunks.sort(key=lambda c: c["start"])
    return _format_chunks(chunks)


def _full_understanding_context(session: dict, query: str, top_k: int = 14,
                                final_k: int = 10, wide_n: int = WIDE_CONTEXT_CHUNKS) -> str:
    """Build the context block the LLM sees for (almost) every question.

    Instead of only returning the few chunks that keyword/semantic search
    thinks are most relevant (which is what caused the old "not available
    in the video" behaviour on general questions), this always gives the
    model an even spread across the ENTIRE video, merged with the chunks
    most relevant to the specific question. This is how the assistant
    builds a real understanding of the whole video instead of just
    searching for matching lines.
    """
    if session["use_full"]:
        c = session["chunks"][0]
        return f"[Full transcript @ {_format_ts(c['start'])}–{_format_ts(c['end'])}]: {c['text']}"

    wide = _sample_chunks(session["chunks"], wide_n)
    retrieved = _retrieve_chunks(session, query, top_k=top_k, final_k=final_k)
    seen = {c["start"] for c in wide}
    merged = list(wide)
    for c in retrieved:
        if c["start"] not in seen:
            merged.append(c)
            seen.add(c["start"])
    merged.sort(key=lambda c: c["start"])
    return _format_chunks(merged)


def _slice_context(session: dict, portion: str) -> str:
    """Context limited to the beginning / middle / end third of the video,
    for questions like 'what happens at the end'."""
    chunks = session["chunks"]
    if not chunks:
        return ""
    if session["use_full"]:
        return _format_chunks(chunks)
    n = len(chunks)
    third = max(1, n // 3)
    if portion == "beginning":
        subset = chunks[:third]
    elif portion == "end":
        subset = chunks[-third:]
    else:
        subset = chunks[third: n - third] or chunks
    return _format_chunks(subset)


# ════════════════════════════════════════════════════════════
#  DIRECT (NON-LLM) HANDLERS
# ════════════════════════════════════════════════════════════

def _segments_at_time(session: dict, seconds: float, window: float = 30) -> list:
    return [
        s for s in session["segments"]
        if seconds - window <= s["start"] <= seconds + window
    ]


def _transcript_at_timestamp(session: dict, ts_str: str) -> str:
    seconds = _parse_ts(ts_str)
    if seconds is None:
        return "Invalid timestamp. Use format m:ss or h:mm:ss."
    segs = _segments_at_time(session, seconds, window=15)
    if not segs:
        return NOT_IN_VIDEO
    lines = [f"[{_format_ts(s['start'])}] {s['text']}" for s in segs]
    return "\n".join(lines)


def _transcript_range(session: dict, start_str: str, end_str: str) -> str:
    start = _parse_ts(start_str)
    end = _parse_ts(end_str)
    if start is None or end is None:
        return "Invalid range. Use m:ss or h:mm:ss for start and end."
    if end < start:
        start, end = end, start
    segs = [s for s in session["segments"] if start <= s["start"] <= end]
    if not segs:
        return NOT_IN_VIDEO
    return "\n".join(f"[{_format_ts(s['start'])}] {s['text']}" for s in segs)


def _keyword_search(session: dict, keyword: str, max_hits: int = 15) -> str:
    keyword_lower = keyword.lower()
    hits = []
    for seg in session["segments"]:
        if keyword_lower in seg["text"].lower():
            hits.append(f"[{_format_ts(seg['start'])}] {seg['text']}")
            if len(hits) >= max_hits:
                break
    if not hits:
        return NOT_IN_VIDEO
    return f"Found '{keyword}' at:\n" + "\n".join(hits)


def _extract_urls(session: dict) -> str:
    pattern = r"https?://[^\s\]\)\"\'\,]+"
    found = []
    for seg in session["segments"]:
        for url in re.findall(pattern, seg["text"]):
            ts = _format_ts(seg["start"])
            entry = f"[{ts}] {url.rstrip('.,')}"
            if entry not in found:
                found.append(entry)
    if not found:
        return NOT_IN_VIDEO
    return "\n".join(found)


# ════════════════════════════════════════════════════════════
#  WEB (optional fact-check)
# ════════════════════════════════════════════════════════════

def _web_search_snippets(query: str, num: int = 3) -> str:
    if not WEB_SEARCH_OK:
        return "Web search unavailable. Install: pip install googlesearch-python"
    try:
        urls = list(google_search(query, num_results=num, advanced=False))
        return "\n".join(f"- {u}" for u in urls) if urls else "No web results found."
    except Exception as e:
        return f"Web search failed: {e}"


# ════════════════════════════════════════════════════════════
#  INTENT DETECTION
# ════════════════════════════════════════════════════════════

def _detect_intent(command: str) -> tuple[str, dict]:
    c = command.lower().strip()
    params: dict = {}

    # Compare two videos
    urls = re.findall(r"https?://\S+", command)
    if len(urls) >= 2 and any(w in c for w in ["compare", "vs", "versus", "difference"]):
        params["url_a"], params["url_b"] = urls[0], urls[1]
        return "compare_videos", params

    # Timestamp range transcript
    range_m = re.search(
        r"(?:transcript|text)\s+(?:from|between)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s+(?:to|and|-)\s+(\d{1,2}:\d{2}(?::\d{2})?)",
        c,
    )
    if range_m:
        params["start"], params["end"] = range_m.group(1), range_m.group(2)
        return "transcript_range", params

    # What happened at timestamp
    at_m = re.search(
        r"(?:at|@|timestamp|time)\s*(\d{1,2}:\d{2}(?::\d{2})?)|"
        r"what (?:happened|was said|is said) at (\d{1,2}:\d{2}(?::\d{2})?)",
        c,
    )
    if at_m:
        params["ts"] = at_m.group(1) or at_m.group(2)
        return "timestamp_query", params

    # Keyword search
    kw_m = re.search(
        r"(?:search|find|where).*(?:mention|said|talk|discuss).*['\"]?(.+?)['\"]?$|"
        r"where is (.+?) mentioned",
        c,
    )
    if kw_m:
        params["keyword"] = (kw_m.group(1) or kw_m.group(2) or "").strip(" '\"?")
        if params["keyword"]:
            return "keyword_search", params

    # Translate (explicit "translate ..." / "... in <language>" requests only —
    # deliberately does NOT trigger on generic mentions of the word "language")
    tr_m = re.search(r"\btranslate\b.*?\b(?:to|into)\s+([a-zA-Z\u0900-\u097F]+)", c)
    if tr_m:
        params["lang"] = tr_m.group(1)
        return "translate", params
    if "translate" in c:
        return "translate", params
    tr_m2 = re.search(r"\bin\s+(hindi|urdu|spanish|french|tamil|telugu|german|japanese|"
                       r"korean|arabic|russian|chinese|bengali|marathi|gujarati|punjabi)\b", c)
    if tr_m2:
        params["lang"] = tr_m2.group(1)
        return "translate", params

    # Flexible phrasing: "what technologies are discussed", "which technologies..." etc.
    if re.search(r"\btechnolog\w*\b", c) and re.search(r"\b(discuss|mention|talk|cover|use)\w*\b", c):
        return "entities", params
    if re.search(r"\bpeople\b", c) and re.search(r"\b(important|key|main|mention\w*)\b", c):
        return "entities", params

    # Flexible phrasing: "what questions are answered/not answered"
    if re.search(r"\bquestions?\b", c) and re.search(r"\bnot\b", c) and \
       re.search(r"\b(answer\w*|unanswered)\b", c):
        return "questions_not_answered", params
    if re.search(r"\bquestions?\b", c) and re.search(r"\banswer\w*\b", c):
        return "questions_answered", params

    # Fact-check / up-to-date (needs web)
    if any(w in c for w in ["fact check", "fact-check", "verify", "is this true", "is it true"]):
        return "fact_check", params
    if any(w in c for w in ["up to date", "uptodate", "outdated", "still valid", "current"]):
        return "freshness", params

    # Beginning / middle / end of the video
    if re.search(r"(beginning|start|opening) of (this |the )?video", c) or \
       re.search(r"(discussed|happen[s]?|talked?|said|covered) .*(at|in) the (beginning|start|opening)", c):
        params["portion"] = "beginning"
        return "video_portion", params
    if re.search(r"middle of (this |the )?video", c) or re.search(r"happen[s]? in the middle", c):
        params["portion"] = "middle"
        return "video_portion", params
    if re.search(r"end of (this |the )?video", c) or re.search(r"happen[s]? at the end", c):
        params["portion"] = "end"
        return "video_portion", params

    # Chronological / timeline overview
    if any(w in c for w in ["timeline of the video", "timeline", "important timestamps",
                             "chronological order", "sequence of events", "order of events"]):
        return "timeline", params

    # Pros / cons
    if any(w in c for w in ["advantage", "disadvantage", "pros and cons", "pros & cons",
                             "benefits and drawbacks"]):
        return "pros_cons", params

    # Mistakes / errors mentioned
    if any(w in c for w in ["mistake", "things to avoid", "what not to do", "error mentioned"]):
        return "mistakes", params

    # Recommendations / advice
    if any(w in c for w in ["recommendation", "suggestion given", "advice given",
                             "what does the video recommend", "what is recommended"]):
        return "recommendations", params

    # List of topics
    if any(w in c for w in ["list all topics", "list of topics", "topics covered",
                             "topics discussed", "all topics"]):
        return "list_topics", params

    # Glossary / technical terms
    if any(w in c for w in ["technical term", "explain technical terms", "jargon",
                             "define terms", "terminology"]):
        return "glossary", params

    # Compare concepts within the same video
    if any(w in c for w in ["compare concepts", "compare the concepts", "compare and contrast",
                             "difference between the concepts"]):
        return "compare_concepts", params

    # Detailed vs short explanation
    if any(w in c for w in ["detailed explanation", "explain in detail", "give a detailed",
                             "in-depth explanation", "explain in depth"]):
        return "detailed_explain", params
    if any(w in c for w in ["short explanation", "brief explanation", "explain briefly",
                             "quick explanation"]):
        return "short_explain", params

    intent_map = [
        ("summarize", ["summarize", "summary of the video", "summary of this video",
                        "give me a summary", "give me the summary", "explain the storyline",
                        "storyline", "explain this video"]),
        ("main_topic", ["main topic", "what is this video about", "what's this video about",
                         "what is the topic", "what is happening in this video",
                         "what's happening in this video"]),
        ("explain_simple", ["explain simply", "simple language", "eli5", "easy words",
                             "explain the video in simple language"]),
        ("key_points", ["key points", "main points", "important points", "main ideas",
                         "key highlights", "highlights", "give me all important points"]),
        ("takeaways", ["takeaways", "take away", "lessons learned", "what can we learn"]),
        ("tips", ["tips", "tricks", "strategies", "hacks"]),
        ("resources", ["tools", "websites", "products", "books", "papers", "resources mentioned"]),
        ("examples", ["with examples", "give examples", "example"]),
        ("conclusion", ["conclusion", "wrap up", "final thoughts"]),
        ("short_notes", ["short notes", "brief notes"]),
        ("bullet_summary", ["bullet", "bullet point", "point wise"]),
        ("blog_post", ["blog post", "write a blog", "convert to blog"]),
        ("study_notes", ["study notes", "revision notes", "create notes", "create study notes",
                          "make notes"]),
        ("interview", ["interview questions", "interview q", "create interview questions"]),
        ("quiz", ["quiz", "mcq", "multiple choice", "create quiz questions"]),
        ("facts", ["facts", "numbers", "statistics", "stats", "data mentioned"]),
        ("contradictions", ["contradiction", "inconsistent", "conflict"]),
        ("beginner", ["for beginners", "beginner friendly", "i am a beginner"]),
        ("expert", ["for experts", "advanced", "expert level"]),
        ("action_items", ["action items", "action plan", "what should i do", "next steps"]),
        ("code", ["code snippet", "commands", "api", "syntax", "terminal command"]),
        ("links", ["links", "urls", "references", "external link"]),
        ("questions_answered", ["what questions does this video answer", "questions answered"]),
        ("questions_not_answered", ["what questions does this video not answer", "not answer", "left unanswered"]),
        ("entities", ["people mentioned", "companies mentioned", "products mentioned", "technologies mentioned",
                       "important people", "key people", "who are the important people",
                       "who are the people", "technologies discussed", "tools discussed", "tools mentioned"]),
        ("workflow", ["workflow", "step by step", "steps", "process", "procedure"]),
        ("checklist", ["checklist", "check list"]),
        ("flashcards", ["flashcards", "flash cards"]),
        ("sections", ["each section", "section by section", "break down sections",
                       "each chapter", "every chapter", "explain every chapter", "chapter",
                       "explain every important concept", "every concept"]),
        ("insights", ["insights", "missed", "what did i miss", "important insights"]),
        ("timestamps", ["timestamp for", "when does", "at what time", "time stamp"]),
    ]

    for intent, keywords in intent_map:
        if any(k in c for k in keywords):
            return intent, params

    return "qa", params


# ════════════════════════════════════════════════════════════
#  PROMPTS
# ════════════════════════════════════════════════════════════

_SYSTEM_GROUNDED = """You are S.N.E.T.C.H's YouTube Video AI assistant. You understand the COMPLETE \
video, not just isolated transcript lines — its overall topic, timeline, events, concepts, \
people, places, discussions, and conclusions. Use the transcript context you're given to build \
that understanding and answer naturally, the way a person who watched the whole video would.

Rules:
1. LANGUAGE — ALWAYS answer in fluent, natural ENGLISH, no matter what language the video or \
its transcript/subtitles are in (Hindi, Tamil, Telugu, Japanese, Spanish, French, or any other \
language). If the transcript is not in English, translate its meaning internally first, then \
write your entire answer in English. Never output non-English text and never mix languages, \
even if the user explicitly asks for another language — politely note that answers are always \
given in English, then answer in English anyway.
2. UNDERSTANDING OVER SEARCHING — Summarize, infer, connect, and explain using the meaning and \
context of the video. Do not simply copy transcript lines verbatim, and do not limit yourself to \
sentences that literally contain the user's keywords.
3. DON'T REFUSE TOO EASILY, AND NEVER GO OFF-TOPIC — Only say the video doesn't cover \
something if it is genuinely absent from the video's overall content and context — not just \
because no single line matches the question literally. If a reasonable, well-grounded answer \
can be inferred from the video's context, give it. But if the exact thing asked about (a \
number, a name, a specific fact) is genuinely not in the video, say so in ONE short sentence — \
do NOT start talking about a different, unrelated topic from elsewhere in the video instead.
4. EXACT AND CONCISE — Answer ONLY what the user actually asked. Do not add unrelated \
background, unrelated topics, or extra information the user didn't ask for. Get straight to the \
point; expand with detail only when the question itself is broad (e.g. "summarize", "explain \
everything") — for a specific, narrow question, give a short, direct, exact answer.
5. GROUNDING — Never invent facts, names, numbers, or links that aren't supported by the video. \
Cite approximate timestamps like [m:ss] where it's genuinely useful, without forcing a citation \
onto every sentence.
6. FORMAT — Respond like a premium AI assistant, using clean Markdown: headings, bullet or \
numbered lists, tables when comparing things, and code blocks for code/commands. Keep the answer \
well organized and easy to scan. No unnecessary filler or repeated disclaimers."""

_INTENT_INSTRUCTIONS = {
    "summarize": "Summarize the video in 3-5 sentences plus bullet key points with timestamps.",
    "main_topic": "State the main topic in 1-2 sentences with the primary timestamp.",
    "explain_simple": "Explain the main concepts in simple language with timestamps.",
    "key_points": "List key points as bullets. Each bullet: point + [timestamp].",
    "takeaways": "List important takeaways as bullets with timestamps.",
    "tips": "Extract all tips, tricks, and strategies with timestamps.",
    "resources": "List every tool, website, product, book, paper, or resource mentioned with timestamps.",
    "examples": "Explain concepts using examples from the video with timestamps.",
    "conclusion": "Write a concise conclusion of the video with timestamps.",
    "short_notes": "Create short revision notes with timestamps.",
    "bullet_summary": "Bullet-point summary covering the full video with timestamps.",
    "blog_post": "Convert the video into a structured blog post (title, intro, sections, conclusion) using only video content.",
    "study_notes": "Create study notes: headings, definitions, key facts, each with timestamps.",
    "interview": "Generate 10 interview questions (+ brief expected answers from the video) with timestamps.",
    "quiz": "Generate 5 MCQs with 4 options each, mark correct answer, cite timestamp for each.",
    "facts": "Extract only the facts, numbers, and statistics that are directly relevant to the question, with timestamps. Do not include unrelated facts from other parts of the video.",
    "contradictions": "Identify any contradictions or inconsistencies in the video with timestamps. If none, say so.",
    "beginner": "Explain the video content for a complete beginner with timestamps.",
    "expert": "Explain the video content for an expert audience with timestamps.",
    "action_items": "Generate actionable steps the viewer should take based on the video.",
    "code": "Extract all code snippets, commands, and APIs mentioned with timestamps.",
    "links": "List all external links and references mentioned (URLs if spoken, otherwise describe).",
    "questions_answered": "List questions this video answers (as bullet questions) with timestamps.",
    "questions_not_answered": "List important questions the video does NOT answer.",
    "entities": "List people, companies, products, and technologies mentioned with timestamps.",
    "workflow": "Extract the workflow or step-by-step process with numbered steps and timestamps.",
    "checklist": "Convert content into a practical checklist with timestamps.",
    "flashcards": "Generate 10 flashcards (Q on one line, A on next) with timestamps.",
    "sections": "Explain each major section of the video one by one with timestamps.",
    "insights": "Suggest important insights the viewer may have missed, with timestamps.",
    "timestamps": "For the topic in the user question, list when it is discussed with timestamps and brief quotes.",
    "qa": "Answer ONLY the exact question asked — the shortest accurate, direct answer, with a timestamp citation if relevant. Do not add unrelated information or discuss a different part/topic of the video than what was asked. If the specific detail isn't in the video, say so in one short sentence.",
    "translate": "Answer in the requested language. Ground in transcript only. Include timestamps.",
    "compare_videos": "Compare the two videos: topic, approach, key differences, overlap. Cite timestamps from each.",
    "fact_check": "Fact-check claims from the video using web sources provided. Note what the video says vs external info.",
    "freshness": "Assess whether the video's information appears up to date based on transcript and web hints.",
    "timeline": "Build a clear chronological timeline of the video's major moments, topics, and events in the order they occur, each with an approximate timestamp.",
    "video_portion": "Explain what is discussed in that specific part of the video (the beginning, middle, or end, as asked), using timestamps.",
    "pros_cons": "List the advantages and disadvantages (pros and cons) discussed in the video, organized clearly under two headings, with timestamps.",
    "mistakes": "List the mistakes, errors, or things to avoid that are mentioned in the video, with brief context and timestamps.",
    "recommendations": "List the recommendations, suggestions, or advice given in the video, with timestamps.",
    "list_topics": "List all the distinct topics or themes covered in the video, in the order they appear, with timestamps.",
    "glossary": "Identify the important technical terms or jargon used in the video and explain each in simple, plain English.",
    "compare_concepts": "Compare and contrast the key concepts discussed in the video — ideally as a table — highlighting similarities and differences.",
    "detailed_explain": "Give a thorough, detailed explanation of the video's content covering all major points, context, and nuance, with timestamps.",
    "short_explain": "Give a short, concise explanation of the video in a brief paragraph.",
}


def _build_prompt(intent: str, context: str, question: str, extra: str = "") -> str:
    instruction = _INTENT_INSTRUCTIONS.get(intent, _INTENT_INSTRUCTIONS["qa"])
    meta = f"\n{extra}\n" if extra else ""
    return f"""Task: {instruction}

Reminder: answer ONLY in fluent English regardless of the transcript's original language, and \
format the response with clean Markdown (headings/bullets/numbered lists/tables/code blocks as \
appropriate).

User request: {question}
{meta}
--- VIDEO CONTEXT (use this to understand the WHOLE video, not just isolated lines) ---
{context}
----------------------------

Response:"""


# ════════════════════════════════════════════════════════════
#  ENGLISH-ONLY SAFETY NET
# ════════════════════════════════════════════════════════════

def _looks_non_english(text: str) -> bool:
    """Detect if the model ignored the English-only instruction. Checked
    AFTER generation, before anything is shown to the user, so we can
    self-correct instead of ever displaying non-English text."""
    if not text:
        return False
    for _, pattern in _SCRIPT_RANGES:
        if re.search(pattern, text):
            return True
    accented = len(re.findall(r"[àâäçéèêëîïôöùûüÿœæñãõß]", text.lower()))
    return accented > 8


def _force_english(answer: str) -> str:
    """Safety net: if the model still answered in a non-English script or
    language despite the instructions, rewrite the same answer in English
    before it is ever shown to the user."""
    try:
        fix_prompt = (
            "Rewrite the following answer completely in fluent, natural English. "
            "Keep the same meaning, structure (headings/bullets/tables), and level "
            "of detail — just translate it. Do not add any new information and do "
            "not include a single non-English word.\n\n"
            "--- ANSWER TO REWRITE ---\n" + answer
        )
        fixed = ask_ollama(
            fix_prompt, temperature=0.1,
            system="You are a precise translator. Output ONLY the English rewrite, nothing else.",
        )
        return fixed.strip() or answer
    except Exception as e:
        logger.warning(f"English-enforcement rewrite failed: {e}")
        return answer


def _simulate_stream(text: str, on_token: Callable[[str], None], chunk_words: int = 3) -> None:
    """Emit the final, already language/content-verified answer to the
    on_token callback in small word-groups with a tiny delay, so the chat
    UI still shows a live 'typing' effect — without ever streaming raw,
    unverified model output straight to the user (which is what let wrong
    -language and off-topic answers slip through before)."""
    words = text.split(" ")
    buf = []
    for i, w in enumerate(words):
        buf.append(w)
        is_last = i == len(words) - 1
        if len(buf) >= chunk_words or is_last:
            piece = " ".join(buf) + ("" if is_last else " ")
            on_token(piece)
            buf = []
            time.sleep(0.012)


# ════════════════════════════════════════════════════════════
#  CORE ASK ENGINE
# ════════════════════════════════════════════════════════════

def _run_task(session: dict, command: str, intent: str, params: dict,
              stream: bool = False, on_token: Callable[[str], None] | None = None,
              history_snippet: str = "") -> str:
    # Direct handlers (no LLM)
    if intent == "timestamp_query":
        return _transcript_at_timestamp(session, params["ts"])
    if intent == "transcript_range":
        return _transcript_range(session, params["start"], params["end"])
    if intent == "keyword_search":
        return _keyword_search(session, params["keyword"])
    if intent == "links":
        urls = _extract_urls(session)
        if urls != NOT_IN_VIDEO:
            return urls

    if not is_ollama_ready():
        return _ollama_error()

    # Context selection by intent.
    # Broad/whole-video questions (summaries, timelines, topic lists, etc.)
    # get an even spread across the ENTIRE transcript merged with relevant
    # chunks, so the model truly understands the whole video.
    # Narrow/specific-lookup questions (a plain "qa" question, a fact, a
    # number, a name) get ONLY the most relevant chunks — NOT a wide sample
    # of the rest of the video — so the model can't wander off and answer
    # about a completely different part of the video than what was asked.
    NARROW_INTENTS = {"qa", "facts", "resources", "code", "tips", "action_items",
                       "examples", "mistakes", "recommendations"}
    if intent == "video_portion":
        context = _slice_context(session, params.get("portion", "middle"))
    elif intent in NARROW_INTENTS:
        context = _retrieve_context(session, command, top_k=10, final_k=6)
    elif intent in ("entities", "glossary", "list_topics", "timeline", "pros_cons", "compare_concepts"):
        context = _full_understanding_context(session, command, top_k=18, final_k=12, wide_n=28)
    else:
        context = _full_understanding_context(session, command)

    extra = ""
    if session.get("title"):
        extra += f"Video title: {session['title']}\n"
    if session.get("author"):
        extra += f"Channel: {session['author']}\n"
    if session.get("duration_sec"):
        extra += f"Duration: {_format_ts(session['duration_sec'])}\n"
    if session.get("lang_hint"):
        extra += (
            f"Detected original language/script of the video: {session['lang_hint']}. "
            f"Understand it fully, but write your ENTIRE answer only in fluent English.\n"
        )
    if history_snippet:
        extra += f"\n{history_snippet}\n"

    if intent == "compare_videos":
        vid_b = _extract_video_id(params.get("url_b", ""))
        if vid_b and vid_b in _sessions:
            ctx_b = _full_understanding_context(_sessions[vid_b], command)
            extra += f"\n--- SECOND VIDEO TRANSCRIPT ---\n{ctx_b}\n"

    if intent in ("fact_check", "freshness"):
        claim = _retrieve_context(session, command, top_k=6, final_k=4)
        web = _web_search_snippets(command[:120])
        extra += f"\nWeb search results (for verification only):\n{web}\n"
        context = claim

    prompt = _build_prompt(intent, context, command, extra)

    try:
        answer = ask_ollama(prompt, temperature=0.2, system=_SYSTEM_GROUNDED)
    except RuntimeError as e:
        logger.error(str(e))
        return str(e)
    except Exception as e:
        logger.error(f"Unexpected backend error while answering: {e}")
        return "Something went wrong while generating the answer. Please try again."

    if _looks_non_english(answer):
        answer = _force_english(answer)

    if stream and on_token:
        _simulate_stream(answer, on_token)

    return answer


def process_video_query(command: str, video_id: str | None = None,
                        stream: bool = False,
                        on_token: Callable[[str], None] | None = None) -> str:
    session = _sessions.get(video_id) if video_id else _active()
    if not session:
        return "No video loaded. Provide a YouTube URL first."

    intent, params = _detect_intent(command)

    # Compare: auto-load second video if URL given
    if intent == "compare_videos" and params.get("url_b"):
        vid_b = _extract_video_id(params["url_b"])
        if vid_b and vid_b not in _sessions:
            load_youtube_video(f"load {params['url_b']}")

    answer = _run_task(session, command, intent, params, stream=stream, on_token=on_token)
    session["history"].append((command, answer))
    return answer


# ════════════════════════════════════════════════════════════
#  LANGGRAPH MEMORY (optional)
# ════════════════════════════════════════════════════════════

if LANGGRAPH_OK:
    class VideoChat(TypedDict):
        messages: Annotated[list, add_messages]
        video_id: str


def _make_video_graph(video_id: str):
    def response_generate(state):
        user_query = state["messages"][-1].content
        answer = process_video_query(user_query, video_id=state.get("video_id", video_id))
        return {"messages": [HumanMessage(content=answer)]}

    graph = StateGraph(VideoChat)
    graph.add_node("response_generate", response_generate)
    graph.add_edge(START, "response_generate")
    graph.add_edge("response_generate", END)
    return graph.compile(checkpointer=MemorySaver())


def _get_or_create_video_graph(video_id: str):
    if video_id not in _graph_store:
        _graph_store[video_id] = {
            "graph": _make_video_graph(video_id),
            "config": {"configurable": {"thread_id": video_id}},
        }
    return _graph_store[video_id]


def ask_youtube_video_langgraph(video_id: str, question: str,
                                stream: bool = False,
                                on_token: Callable[[str], None] | None = None) -> str:
    if not LANGGRAPH_OK:
        return process_video_query(question, video_id=video_id, stream=stream, on_token=on_token)
    if video_id not in _sessions:
        return "No video loaded yet."
    if stream:
        return process_video_query(question, video_id=video_id, stream=True, on_token=on_token)

    bot = _get_or_create_video_graph(video_id)
    result = bot["graph"].invoke(
        {"messages": [HumanMessage(content=question)], "video_id": video_id},
        bot["config"],
    )
    return result["messages"][-1].content


# ════════════════════════════════════════════════════════════
#  PUBLIC API
# ════════════════════════════════════════════════════════════

def load_youtube_video(command: str) -> str:
    global _active_video_id

    if not YT_DEPS_OK:
        msg = "Missing deps: pip install youtube-transcript-api sentence-transformers scikit-learn numpy"
        speak(msg)
        return msg

    url_match = re.search(r"https?://\S+", command)
    if not url_match:
        msg = "Please share the video link."
        speak(msg)
        return msg

    video_id = _extract_video_id(url_match.group(0))
    if not video_id:
        msg = "Invalid YouTube URL."
        speak(msg)
        return msg

    if video_id in _sessions:
        _active_video_id = video_id
        msg = f"Video already loaded — switched to {video_id}."
        speak(msg)
        return msg

    segments, err = _get_transcript_segments(video_id)
    if segments is None:
        reasons = {
            "no_transcript": "No transcript available for this video.",
            "disabled": "Captions are disabled for this video.",
            "unavailable": "Video unavailable or private.",
            "unknown": "Could not fetch transcript. Try again.",
        }
        msg = reasons.get(err, "Transcript fetch failed.")
        speak(msg)
        return msg

    meta = _fetch_video_metadata(video_id)
    transcript = " ".join(s["text"] for s in segments)
    word_count = len(transcript.split())
    duration_sec = segments[-1]["start"] + segments[-1].get("duration", 0) if segments else 0

    session = _new_session(video_id)
    session["segments"] = segments
    session["transcript_text"] = transcript
    session["title"] = meta["title"]
    session["author"] = meta["author"]
    session["duration_sec"] = duration_sec
    session["lang_hint"] = _detect_language_hint(transcript)

    if word_count <= FULL_TRANSCRIPT_WORD_LIMIT:
        session["chunks"] = [{
            "text": transcript,
            "start": 0,
            "end": duration_sec,
        }]
        session["use_full"] = True
    else:
        session["chunks"] = _sentence_aware_chunks_with_ts(segments)
        _index_session(session)

    _sessions[video_id] = session
    _active_video_id = video_id

    title_bit = f' "{meta["title"]}"' if meta["title"] else ""
    msg = (
        f"Loaded{title_bit} — {_format_ts(duration_sec)}, {word_count} words, "
        f"{len(session['chunks'])} chunks indexed. "
        f"Ask anything: summarize, key points, quiz, timestamps, facts, etc."
    )
    logger.info(f"YouTube loaded: {video_id} ({word_count} words, {len(session['chunks'])} chunks)")
    return msg


def summarize_youtube_video(command: str = "") -> str:
    return process_video_query(command or "summarize the video")


def ask_youtube_video(command: str) -> str:
    user_query = re.sub(
        r"^(youtube|yt|video)\s+(question|ask|kya|mein)\s*", "",
        command, flags=re.IGNORECASE,
    ).strip() or command.strip()
    return process_video_query(user_query)


def list_loaded_videos() -> str:
    if not _sessions:
        return "No videos loaded."
    lines = []
    for vid, s in _sessions.items():
        marker = " (active)" if vid == _active_video_id else ""
        title = s.get("title") or vid
        lines.append(f"- {title}{marker} [{vid}] — {len(s['chunks'])} chunks")
    return "Loaded videos:\n" + "\n".join(lines)


def switch_youtube_video(command: str) -> str:
    global _active_video_id
    url_match = re.search(r"https?://\S+", command)
    candidate = url_match.group(0) if url_match else command.strip()
    video_id = _extract_video_id(candidate) or candidate.strip()[-11:]

    if video_id not in _sessions:
        return "Video not loaded. Use: load youtube video <url>"
    _active_video_id = video_id
    return f"Switched to {video_id}."


def youtube_chatbot(command: str) -> str:
    c = command.lower()

    wants_load = any(w in c for w in ["load", "kholo", "open"]) and \
                 ("youtube" in c or "yt" in c or "video" in c)
    if wants_load:
        if re.search(r"https?://\S+", command):
            return load_youtube_video(command)
        return "Please share the video link."

    if any(w in c for w in ["switch", "badlo"]) and "video" in c:
        return switch_youtube_video(command)

    if any(w in c for w in ["list video", "loaded video"]):
        return list_loaded_videos()

    if not _active():
        if re.search(r"https?://\S+", command):
            return load_youtube_video(command)
        return "Load a YouTube video first: load youtube video <url>"

    return ask_youtube_video(command)


# ════════════════════════════════════════════════════════════════════════
#  WEB FEATURE — Flask Blueprint + SQLite persistence + LangGraph Threads
#  Powers templates/youtube_chatbot.html, static/youtube_chatbot.css and
#  js/youtube_chatbot.js. Reuses the extraction / chunking / retrieval /
#  prompting engine defined above, but keyed by a browser-issued Thread ID
#  instead of a global active video (one video + one conversation per
#  LangGraph Thread, exactly like a New Chat in ChatGPT).
# ════════════════════════════════════════════════════════════════════════

# ────────────────────────────────────────────────────────────────────────
#  SQLITE — threads + messages
#  (own database file: db_storage/youtube_chatbot.db — does not touch
#   db.py / snetch.db used by the rest of the app)
# ────────────────────────────────────────────────────────────────────────

def _yt_conn() -> sqlite3.Connection:
    os.makedirs(DB_STORAGE_DIR, exist_ok=True)
    conn = sqlite3.connect(YT_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_youtube_chatbot_db() -> None:
    os.makedirs(DB_STORAGE_DIR, exist_ok=True)
    conn = _yt_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS threads (
            thread_id         TEXT PRIMARY KEY,
            title             TEXT NOT NULL DEFAULT 'New Chat',
            youtube_url       TEXT,
            video_id          TEXT,
            video_title       TEXT,
            channel_name      TEXT,
            thumbnail_url     TEXT,
            duration_sec      INTEGER,
            upload_status     TEXT NOT NULL DEFAULT 'pending',
            processing_status TEXT NOT NULL DEFAULT 'awaiting_video',
            transcript_status TEXT NOT NULL DEFAULT 'pending',
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
    conn.execute("CREATE INDEX IF NOT EXISTS idx_yt_messages_thread ON messages(thread_id)")
    conn.commit()
    conn.close()


def create_thread_row(thread_id: str, title: str = "New Chat") -> None:
    now = int(time.time())
    conn = _yt_conn()
    conn.execute(
        "INSERT INTO threads (thread_id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (thread_id, title, now, now),
    )
    conn.commit()
    conn.close()


def get_thread_row(thread_id: str):
    conn = _yt_conn()
    row = conn.execute("SELECT * FROM threads WHERE thread_id=?", (thread_id,)).fetchone()
    conn.close()
    return row


def list_thread_rows(search: str = "", archived: bool = False):
    conn = _yt_conn()
    if search:
        like = f"%{search.lower()}%"
        rows = conn.execute("""
            SELECT DISTINCT t.* FROM threads t
            LEFT JOIN messages m ON m.thread_id = t.thread_id
            WHERE t.is_archived = ?
              AND (LOWER(t.title) LIKE ? OR LOWER(COALESCE(t.video_title,'')) LIKE ?
                   OR LOWER(COALESCE(t.channel_name,'')) LIKE ? OR LOWER(m.content) LIKE ?)
            ORDER BY t.is_pinned DESC, t.updated_at DESC
        """, (1 if archived else 0, like, like, like, like)).fetchall()
    else:
        rows = conn.execute("""
            SELECT * FROM threads WHERE is_archived = ?
            ORDER BY is_pinned DESC, updated_at DESC
        """, (1 if archived else 0,)).fetchall()
    conn.close()
    return rows


def touch_thread(thread_id: str) -> None:
    conn = _yt_conn()
    conn.execute("UPDATE threads SET updated_at=? WHERE thread_id=?", (int(time.time()), thread_id))
    conn.commit()
    conn.close()


def set_thread_video_info(thread_id: str, youtube_url: str, video_id: str, video_title: str,
                           channel_name: str, thumbnail_url: str, duration_sec: int,
                           processing_status: str, upload_status: str,
                           transcript_status: str) -> None:
    conn = _yt_conn()
    conn.execute("""
        UPDATE threads SET youtube_url=?, video_id=?, video_title=?, channel_name=?,
               thumbnail_url=?, duration_sec=?, processing_status=?, upload_status=?,
               transcript_status=?, updated_at=? WHERE thread_id=?
    """, (youtube_url, video_id, video_title, channel_name, thumbnail_url, duration_sec,
          processing_status, upload_status, transcript_status, int(time.time()), thread_id))
    conn.commit()
    conn.close()


def set_processing_status(thread_id: str, status: str) -> None:
    conn = _yt_conn()
    conn.execute("UPDATE threads SET processing_status=?, updated_at=? WHERE thread_id=?",
                 (status, int(time.time()), thread_id))
    conn.commit()
    conn.close()


def set_transcript_status(thread_id: str, status: str) -> None:
    conn = _yt_conn()
    conn.execute("UPDATE threads SET transcript_status=?, updated_at=? WHERE thread_id=?",
                 (status, int(time.time()), thread_id))
    conn.commit()
    conn.close()


def rename_thread_row(thread_id: str, title: str) -> None:
    conn = _yt_conn()
    conn.execute("UPDATE threads SET title=?, updated_at=? WHERE thread_id=?",
                 (title.strip()[:120] or "New Chat", int(time.time()), thread_id))
    conn.commit()
    conn.close()


def set_pin_row(thread_id: str, pinned: bool) -> None:
    conn = _yt_conn()
    conn.execute("UPDATE threads SET is_pinned=?, updated_at=? WHERE thread_id=?",
                 (1 if pinned else 0, int(time.time()), thread_id))
    conn.commit()
    conn.close()


def set_archive_row(thread_id: str, archived: bool) -> None:
    conn = _yt_conn()
    conn.execute("UPDATE threads SET is_archived=?, updated_at=? WHERE thread_id=?",
                 (1 if archived else 0, int(time.time()), thread_id))
    conn.commit()
    conn.close()


def delete_thread_row(thread_id: str) -> None:
    conn = _yt_conn()
    conn.execute("DELETE FROM threads WHERE thread_id=?", (thread_id,))
    conn.execute("DELETE FROM messages WHERE thread_id=?", (thread_id,))
    conn.commit()
    conn.close()


def add_message_row(thread_id: str, role: str, content: str) -> int:
    conn = _yt_conn()
    cur = conn.execute(
        "INSERT INTO messages (thread_id, role, content, created_at) VALUES (?,?,?,?)",
        (thread_id, role, content, int(time.time())),
    )
    conn.commit()
    msg_id = cur.lastrowid
    conn.close()
    return msg_id


def get_message_rows(thread_id: str, limit: int | None = None):
    conn = _yt_conn()
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
    conn = _yt_conn()
    conn.execute("DELETE FROM messages WHERE id=?", (message_id,))
    conn.commit()
    conn.close()


def set_message_feedback_row(message_id: int, feedback: str) -> None:
    liked = 1 if feedback == "like" else 0
    disliked = 1 if feedback == "dislike" else 0
    conn = _yt_conn()
    conn.execute("UPDATE messages SET liked=?, disliked=? WHERE id=?",
                 (liked, disliked, message_id))
    conn.commit()
    conn.close()


def _serialize_thread(row) -> dict:
    return {
        "thread_id": row["thread_id"],
        "title": row["title"],
        "video": {
            "url": row["youtube_url"],
            "video_id": row["video_id"],
            "title": row["video_title"],
            "channel": row["channel_name"],
            "thumbnail": row["thumbnail_url"],
            "duration_sec": row["duration_sec"],
            "duration": _format_ts(row["duration_sec"]) if row["duration_sec"] else None,
        } if row["video_id"] else None,
        "upload_status": row["upload_status"],
        "processing_status": row["processing_status"],
        "transcript_status": row["transcript_status"],
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


# ────────────────────────────────────────────────────────────────────────
#  PER-THREAD VIDEO SESSION + RETRIEVAL (reuses the engine above)
# ────────────────────────────────────────────────────────────────────────

def _build_history_snippet(thread_id: str, limit: int = 6) -> str:
    rows = get_message_rows(thread_id, limit=limit)
    if not rows:
        return ""
    lines = []
    for r in rows:
        who = "User" if r["role"] == "user" else "Assistant"
        lines.append(f"{who}: {r['content'][:600]}")
    return "Previous conversation turns (context only — answer the NEW question below):\n" + "\n".join(lines)


def _load_web_video(thread_id: str, url: str):
    """Validate + fetch transcript + index a YouTube video for a chat
    thread. Returns (ok: bool, info_or_error)."""
    if not YT_DEPS_OK:
        return False, ("Missing server dependencies. Install: pip install "
                        "youtube-transcript-api sentence-transformers scikit-learn numpy")

    video_id = _extract_video_id(url)
    if not video_id:
        return False, "Invalid YouTube URL. Please paste a valid video link."

    segments, err = _get_transcript_segments(video_id)
    if segments is None:
        reasons = {
            "no_transcript": "No transcript available for this video.",
            "disabled": "Captions are disabled for this video.",
            "unavailable": "Video unavailable or private.",
            "unknown": "Could not fetch transcript. Please try again.",
        }
        return False, {"message": reasons.get(err, "Transcript fetch failed."), "reason": err or "unknown"}

    meta = _fetch_video_metadata(video_id)
    transcript = " ".join(s["text"] for s in segments)
    word_count = len(transcript.split())
    duration_sec = segments[-1]["start"] + segments[-1].get("duration", 0) if segments else 0

    session = _new_session(video_id)
    session["segments"] = segments
    session["transcript_text"] = transcript
    session["title"] = meta["title"]
    session["author"] = meta["author"]
    session["duration_sec"] = duration_sec
    session["lang_hint"] = _detect_language_hint(transcript)

    if word_count <= FULL_TRANSCRIPT_WORD_LIMIT:
        session["chunks"] = [{"text": transcript, "start": 0, "end": duration_sec}]
        session["use_full"] = True
    else:
        session["chunks"] = _sentence_aware_chunks_with_ts(segments)
        _index_session(session)

    _web_sessions[thread_id] = session

    thumbnail_url = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    return True, {
        "video_id": video_id,
        "title": meta["title"] or "Untitled Video",
        "author": meta["author"] or "",
        "thumbnail": thumbnail_url,
        "duration_sec": duration_sec,
        "word_count": word_count,
        "chunks": len(session["chunks"]),
    }


def process_web_query(thread_id: str, question: str, stream: bool = False,
                       on_token: Callable[[str], None] | None = None) -> str:
    session = _web_sessions.get(thread_id)
    if not session:
        raise ValueError("No video is loaded for this chat yet.")
    intent, params = _detect_intent(question)
    history_snippet = _build_history_snippet(thread_id)
    return _run_task(session, question, intent, params, stream=stream,
                      on_token=on_token, history_snippet=history_snippet)


# ────────────────────────────────────────────────────────────────────────
#  LANGGRAPH THREAD MEMORY — synced with SQLite via SqliteSaver when the
#  optional langgraph / langchain packages are installed. Every New
#  YouTube Chat gets its own Thread ID and its own isolated checkpointed
#  memory; no Thread ever inherits memory from another. Falls back
#  gracefully (the feature still works end-to-end, using the messages
#  table above as the source of truth) when those optional heavy
#  packages are not installed.
# ────────────────────────────────────────────────────────────────────────

if LANGGRAPH_OK:
    class WebVideoChat(TypedDict):
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

    def _web_graph_node(state):
        thread_id = state["thread_id"]
        question = state["messages"][-1].content
        answer = process_web_query(thread_id, question, stream=False)
        return {"messages": [HumanMessage(content=answer)]}

    def _make_web_graph():
        g = StateGraph(WebVideoChat)
        g.add_node("answer", _web_graph_node)
        g.add_edge(START, "answer")
        g.add_edge("answer", END)
        return g.compile(checkpointer=_get_checkpointer())

    def _get_or_create_web_graph(thread_id: str):
        if thread_id not in _web_graph_store:
            _web_graph_store[thread_id] = {
                "graph": _make_web_graph(),
                "config": {"configurable": {"thread_id": thread_id}},
            }
        return _web_graph_store[thread_id]

    def _sync_langgraph_memory(thread_id: str, question: str, answer: str) -> None:
        """Persist this Q/A turn into the Thread's LangGraph checkpoint
        (SQLite-backed) without re-running the LLM — the answer was
        already streamed to the user."""
        try:
            bot = _get_or_create_web_graph(thread_id)
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


# ────────────────────────────────────────────────────────────────────────
#  FLASK BLUEPRINT — /youtube_chatbot/api/*
# ────────────────────────────────────────────────────────────────────────

youtube_chatbot_bp = Blueprint(
    "youtube_chatbot_api", __name__, url_prefix="/youtube_chatbot/api"
)


@youtube_chatbot_bp.route("/new_chat", methods=["POST"])
def api_new_chat():
    thread_id = uuid.uuid4().hex
    create_thread_row(thread_id, "New Chat")
    return jsonify({"success": True, "thread_id": thread_id,
                     "thread": _serialize_thread(get_thread_row(thread_id))})


@youtube_chatbot_bp.route("/load_video", methods=["POST"])
def api_load_video():
    data = request.get_json(force=True, silent=True) or {}
    thread_id = (data.get("thread_id") or "").strip()
    url = (data.get("url") or "").strip()

    if not thread_id or not get_thread_row(thread_id):
        return jsonify({"success": False, "error": "Invalid or missing chat thread."}), 400
    if not url or not re.search(r"https?://\S+", url):
        return jsonify({"success": False, "error": "Please paste a valid YouTube URL."}), 400

    set_processing_status(thread_id, "processing")
    set_transcript_status(thread_id, "pending")

    ok, info = _load_web_video(thread_id, url)
    if not ok:
        message = info["message"] if isinstance(info, dict) else info
        reason = info.get("reason", "unknown") if isinstance(info, dict) else "unknown"
        set_processing_status(thread_id, "failed")
        set_transcript_status(thread_id, reason)
        return jsonify({"success": False, "error": message,
                         "processing_status": "failed"}), 422

    set_thread_video_info(
        thread_id, url, info["video_id"], info["title"], info["author"],
        info["thumbnail"], info["duration_sec"], "ready", "success", "ready",
    )

    row = get_thread_row(thread_id)
    if row["title"] == "New Chat":
        rename_thread_row(thread_id, (info["title"] or "YouTube Chat")[:80])

    touch_thread(thread_id)
    return jsonify({
        "success": True,
        "thread": _serialize_thread(get_thread_row(thread_id)),
        "stats": {"word_count": info["word_count"], "chunks": info["chunks"]},
    })


@youtube_chatbot_bp.route("/threads", methods=["GET"])
def api_threads():
    search = request.args.get("search", "").strip()
    scope = request.args.get("scope", "all")
    rows = list_thread_rows(search=search, archived=(scope == "archived"))
    threads = [_serialize_thread(r) for r in rows]
    pinned = [t for t in threads if t["is_pinned"]]
    recent = [t for t in threads if not t["is_pinned"]]
    return jsonify({"success": True, "pinned": pinned, "recent": recent})


@youtube_chatbot_bp.route("/thread/<thread_id>", methods=["GET"])
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


@youtube_chatbot_bp.route("/thread/<thread_id>/rename", methods=["POST"])
def api_rename_thread(thread_id):
    if not get_thread_row(thread_id):
        return jsonify({"success": False, "error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"success": False, "error": "Title cannot be empty."}), 400
    rename_thread_row(thread_id, title)
    return jsonify({"success": True, "thread": _serialize_thread(get_thread_row(thread_id))})


@youtube_chatbot_bp.route("/thread/<thread_id>/pin", methods=["POST"])
def api_pin_thread(thread_id):
    row = get_thread_row(thread_id)
    if not row:
        return jsonify({"success": False, "error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    pinned = data.get("pinned")
    pinned = (not row["is_pinned"]) if pinned is None else bool(pinned)
    set_pin_row(thread_id, pinned)
    return jsonify({"success": True, "thread": _serialize_thread(get_thread_row(thread_id))})


@youtube_chatbot_bp.route("/thread/<thread_id>/archive", methods=["POST"])
def api_archive_thread(thread_id):
    row = get_thread_row(thread_id)
    if not row:
        return jsonify({"success": False, "error": "Chat not found."}), 404
    data = request.get_json(force=True, silent=True) or {}
    archived = data.get("archived")
    archived = (not row["is_archived"]) if archived is None else bool(archived)
    set_archive_row(thread_id, archived)
    return jsonify({"success": True, "thread": _serialize_thread(get_thread_row(thread_id))})


@youtube_chatbot_bp.route("/thread/<thread_id>", methods=["DELETE"])
def api_delete_thread(thread_id):
    row = get_thread_row(thread_id)
    if not row:
        return jsonify({"success": False, "error": "Chat not found."}), 404
    delete_thread_row(thread_id)
    _web_sessions.pop(thread_id, None)
    _drop_langgraph_thread(thread_id)
    return jsonify({"success": True})


@youtube_chatbot_bp.route("/thread/<thread_id>/download", methods=["GET"])
def api_download_thread(thread_id):
    row = get_thread_row(thread_id)
    if not row:
        return jsonify({"success": False, "error": "Chat not found."}), 404
    msgs = get_message_rows(thread_id)
    lines = [
        "S.N.E.T.C.H — YouTube AI Chatbot Transcript",
        f"Chat: {row['title']}",
        f"Video: {row['video_title'] or 'N/A'}",
        f"Channel: {row['channel_name'] or 'N/A'}",
        f"URL: {row['youtube_url'] or 'N/A'}",
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


@youtube_chatbot_bp.route("/message/<int:message_id>/feedback", methods=["POST"])
def api_message_feedback(message_id):
    data = request.get_json(force=True, silent=True) or {}
    feedback = data.get("type", "none")
    if feedback not in ("like", "dislike", "none"):
        return jsonify({"success": False, "error": "Invalid feedback type."}), 400
    set_message_feedback_row(message_id, feedback)
    return jsonify({"success": True})


def _stream_answer_response(thread_id: str, question: str, save_user_message: bool):
    """Shared SSE generator for /ask and /regenerate."""
    if thread_id not in _web_sessions:
        def err_gen():
            yield f"data: {json.dumps({'error': 'No video is loaded for this chat yet.'})}\n\n"
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
                final = process_web_query(thread_id, question, stream=True, on_token=on_token)
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

        answer = state["text"].strip() or NOT_IN_VIDEO
        msg_id = add_message_row(thread_id, "assistant", answer)
        touch_thread(thread_id)
        _sync_langgraph_memory(thread_id, question, answer)
        yield f"data: {json.dumps({'done': True, 'message_id': msg_id, 'answer': answer})}\n\n"

    return generate()


@youtube_chatbot_bp.route("/ask", methods=["POST"])
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


@youtube_chatbot_bp.route("/regenerate", methods=["POST"])
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


def register_youtube_chatbot(app) -> None:
    """Wire this feature's API into the main Flask app.

    youtube_chatbot.py deliberately does not import app.py (to avoid
    touching any other feature/file), so add these two lines once in
    app.py, near the other feature imports:

        import youtube_chatbot
        youtube_chatbot.register_youtube_chatbot(app)
    """
    init_youtube_chatbot_db()
    app.register_blueprint(youtube_chatbot_bp)


# Always make sure the database folder exists, even if the Flask app
# never calls register_youtube_chatbot() (e.g. CLI-only usage).
init_youtube_chatbot_db()


def main():
    print("=== S.N.E.T.C.H YouTube AI Chatbot ===")
    print("Capabilities: summarize, key points, quiz, timestamps, facts, blog, flashcards,")
    print("compare videos, translate, fact-check, and 30+ more. Type 'help' for examples.\n")

    while True:
        url = input("YouTube URL (or Enter for default test video): ").strip()
        if not url:
            url = "https://www.youtube.com/watch?v=j9HpxDCn35U"
        if url.lower() in ("exit", "quit"):
            return

        result = load_youtube_video(f"load {url}")
        print(f"\n{result}\n")

        video_id = _extract_video_id(url)
        if not video_id or video_id not in _sessions:
            continue

        print("Ask anything (streaming). Commands: 'new' | 'exit' | 'help'\n")

        while True:
            question = input("You: ").strip()
            if not question:
                continue
            if question.lower() in ("exit", "quit"):
                print("Bye!")
                return
            if question.lower() == "new":
                break
            if question.lower() == "help":
                print(
                    "Examples:\n"
                    "  summarize the video\n"
                    "  main topic / key points / generate quiz\n"
                    "  what happened at 8:45\n"
                    "  transcript from 5:00 to 10:00\n"
                    "  where is Yakub mentioned\n"
                    "  list tools and resources mentioned\n"
                    "  translate to Hindi\n"
                    "  compare https://youtu.be/A vs https://youtu.be/B\n"
                    "  fact check the main claims\n"
                )
                continue

            print("Bot: ", end="", flush=True)
            tokens = []

            def on_token(t):
                print(t, end="", flush=True)
                tokens.append(t)

            try:
                ask_youtube_video_langgraph(
                    video_id, question, stream=True, on_token=on_token,
                )
            except Exception as e:
                print(str(e), end="")
            print("\n")


if __name__ == "__main__":
    main()