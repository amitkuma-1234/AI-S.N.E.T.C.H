"""
latestnews.py — S.N.E.T.C.H Latest News AI backend

Fetches live headlines from Google News RSS for either a general
"top headlines" feed or a user-specified topic/location/category, and
returns fully-structured article dictionaries ready to be rendered as
premium news cards on the frontend.

Root-cause fixes applied in this rewrite:
  * The previous implementation only ever `print()`-ed results to a
    terminal — there was no function that returned structured data, so
    the web frontend had nothing to call and nothing to render.
  * The previous implementation raised no distinguishable errors, so
    the frontend could never tell "no results" apart from "network
    down" apart from "bad query".
  * The previous implementation depended entirely on a local Ollama
    LLM call succeeding — if Ollama wasn't running, the feature
    produced zero output. Every article field is now built first from
    the raw RSS data (guaranteed to work), and the LLM is only used as
    an optional, time-boxed enhancement layered on top.

Public API used by app.py:
    get_latest_news(query: str, count: int = 8) -> dict
        {
            "label": str,            # e.g. "Latest News: India"
            "topic": str,            # e.g. "India" or "Top Headlines"
            "articles": [ {...}, ... ]
        }

    Exceptions (all subclass NewsError):
        InvalidQueryError, NewsNetworkError, NoNewsFoundError
"""

import concurrent.futures as cf
import hashlib
import json
import re
from datetime import datetime
import os
import feedparser
import requests
from bs4 import BeautifulSoup

try:
    from langchain_groq import ChatGroq
    _LLM_IMPORT_ERROR = None
except Exception as _e:  # pragma: no cover - optional dependency
    ChatGroq = None
    _LLM_IMPORT_ERROR = _e


# ============================================================
# CONSTANTS
# ============================================================

GENERAL_TRIGGERS = ("news", "latest news", "top news", "breaking news")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
}

TOP_HEADLINES_URL = "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en"
SEARCH_URL_TEMPLATE = "https://news.google.com/rss/search?q={q}&hl=en-IN&gl=IN&ceid=IN:en"

CATEGORY_KEYWORDS = {
    "Technology": ("tech", "technology", "software", "gadget", "startup", "app"),
    "Artificial Intelligence": ("ai", "artificial intelligence", "machine learning", "chatgpt", "llm"),
    "Sports": ("sport", "cricket", "football", "soccer", "olympic", "match", "tournament", "ipl"),
    "Business": ("business", "market", "stock", "economy", "finance", "trade", "company"),
    "Politics": ("politic", "election", "government", "parliament", "minister", "president"),
    "World": ("world", "international", "global"),
    "Science": ("science", "research", "space", "nasa", "isro", "study"),
    "Entertainment": ("entertainment", "movie", "film", "celebrity", "music", "bollywood", "hollywood"),
    "Health": ("health", "covid", "disease", "medical", "hospital", "vaccine"),
}

STOPWORDS = {"the", "a", "an", "and", "in", "on", "of", "for", "to", "at", "is", "as", "by", "with"}

_LLM_TIMEOUT_SECONDS = 10
_llm_model = None
_llm_available = ChatGroq is not None
_executor = cf.ThreadPoolExecutor(max_workers=2)


def _get_llm():
    """Lazily construct the Ollama client so import/connection issues
    never block module import or a request that doesn't need the LLM."""
    global _llm_model
    if not _llm_available:
        return None
    if _llm_model is None:
        _llm_model = ChatGroq(
            model="openai/gpt-oss-120b",
            api_key=os.getenv("GROQ_API_KEY"),
        )
    return _llm_model


# ============================================================
# EXCEPTIONS
# ============================================================

class NewsError(Exception):
    """Base class for all Latest News feature errors."""


class InvalidQueryError(NewsError):
    """Raised when the query has no usable alphanumeric content."""


class NewsNetworkError(NewsError):
    """Raised when the news source could not be reached."""


class NoNewsFoundError(NewsError):
    """Raised when the source returned zero matching articles."""


# ============================================================
# HELPERS
# ============================================================

def clean_title(title):
    if " - " in title:
        title = title.rsplit(" - ", 1)[0]
    return BeautifulSoup(title or "", "html.parser").get_text().strip()


def clean_html_text(raw):
    if not raw:
        return ""
    return BeautifulSoup(raw, "html.parser").get_text().strip()


def format_date(date_str):
    try:
        dt = datetime.strptime(date_str, "%a, %d %b %Y %H:%M:%S %Z")
        return dt.strftime("%d %b %Y, %I:%M %p")
    except Exception:
        return date_str or "Unknown date"


def to_iso(date_str):
    try:
        dt = datetime.strptime(date_str, "%a, %d %b %Y %H:%M:%S %Z")
        return dt.isoformat()
    except Exception:
        return None


def fetch_url(url, retries=2, timeout=12):
    last_error = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
            r.raise_for_status()
            return r.content
        except requests.exceptions.RequestException as e:
            last_error = e
    if last_error:
        print(f"[latestnews] network error: {last_error}")
    return None


def extract_topic(query):
    """Strip generic trigger phrases ('news', 'latest news', ...) from
    the raw query, leaving just the topic/location/category the user
    actually cares about. Returns '' for a purely generic request."""
    cleaned = query.strip()
    for trigger in sorted(GENERAL_TRIGGERS, key=len, reverse=True):
        cleaned = re.sub(rf"\b{re.escape(trigger)}\b", "", cleaned, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", cleaned).strip(" -:,.")


def has_alphanumeric(text):
    return bool(re.search(r"[A-Za-z0-9]", text or ""))


def smart_title(topic):
    """Title-case a topic while preserving short all-caps acronyms
    (AI, US, UK, ISRO...) instead of mangling them into 'Ai', 'Us'."""
    words = (topic or "").split()
    out = []
    for w in words:
        out.append(w if (w.isupper() and len(w) <= 5) else w.capitalize())
    return " ".join(out)


def detect_category(topic, title=""):
    haystack = f"{topic} {title}".lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(kw in haystack for kw in keywords):
            return category
    return "General"


def extract_keywords(text, max_n=4):
    """Pull out proper-noun-like phrases (capitalized word runs) from a
    headline, used as a non-fabricated basis for highlights/topics."""
    candidates = re.findall(r"[A-Z][a-zA-Z0-9&'.]*(?:\s+[A-Z][a-zA-Z0-9&'.]*)*", text or "")
    seen = []
    for c in candidates:
        c = c.strip()
        if len(c) > 2 and c.lower() not in STOPWORDS and c not in seen:
            seen.append(c)
    return seen[:max_n]


def build_fallback_fields(title, source, category, topic):
    keywords = extract_keywords(title)
    highlights = [f"Key mention: {k}" for k in keywords[:3]]
    if not highlights:
        highlights = [f"Reported by {source}", f"Filed under {category}"]
    related = [k for k in keywords[3:5]]
    if category != "General":
        related.append(category)
    if topic and smart_title(topic) not in related:
        related.append(smart_title(topic))
    # de-dupe while preserving order
    deduped = []
    for r in related:
        if r not in deduped:
            deduped.append(r)
    summary = clean_title(title)
    return summary, highlights[:3], deduped[:4]


def _call_llm_enrich(entries_meta, label):
    """entries_meta: list of dicts with headline/source/date/category.
    Returns a list of {summary, highlights, related_topics} of the same
    length, or raises on any failure (caller treats that as 'skip')."""
    model = _get_llm()
    if model is None:
        raise RuntimeError("LLM not available")

    items_text = "\n".join(
        f'{i+1}. Headline: "{e["headline"]}" | Source: {e["source"]} | '
        f'Date: {e["date"]} | Category: {e["category"]}'
        for i, e in enumerate(entries_meta)
    )

    prompt = f"""You are a news editor. For each numbered headline below, produce:
- "summary": one neutral sentence restating what the headline says (do not invent facts beyond it)
- "highlights": up to 3 short key-point phrases drawn directly from the headline
- "related_topics": up to 3 short topic keywords implied by the headline or category

Respond with ONLY a valid JSON array (no markdown fences, no commentary), with exactly
{len(entries_meta)} objects in the same order as the headlines, each shaped like:
{{"summary": "...", "highlights": ["...", "..."], "related_topics": ["...", "..."]}}

Topic context: {label}

Headlines:
{items_text}"""

    raw = model.invoke(prompt).content.strip()
    raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    data = json.loads(raw)
    if not isinstance(data, list) or len(data) != len(entries_meta):
        raise ValueError("LLM output shape mismatch")
    return data


def try_llm_enrich(entries_meta, label, timeout=_LLM_TIMEOUT_SECONDS):
    if not _llm_available:
        return None
    future = _executor.submit(_call_llm_enrich, entries_meta, label)
    try:
        return future.result(timeout=timeout)
    except Exception as e:
        print(f"[latestnews] LLM enrichment skipped: {e}")
        return None


# ============================================================
# CORE
# ============================================================

def get_latest_news(query, count=8):
    """Fetch and return structured news articles for the given query.

    Raises InvalidQueryError / NewsNetworkError / NoNewsFoundError on
    failure so the caller (Flask route) can produce a precise,
    user-friendly error response.
    """
    if query is None or not str(query).strip():
        raise InvalidQueryError("Please enter or speak a news topic to search.")

    query = str(query).strip()
    topic = extract_topic(query)

    if topic and not has_alphanumeric(topic):
        raise InvalidQueryError(f"'{query}' doesn't look like a valid search — try a topic, place, or category.")

    if topic:
        url = SEARCH_URL_TEMPLATE.format(q=requests.utils.quote(topic))
        label = f"Latest News: {smart_title(topic)}"
    else:
        url = TOP_HEADLINES_URL
        label = "Latest News"

    content = fetch_url(url)
    if content is None:
        raise NewsNetworkError("Couldn't reach the news service. Please check your connection and try again.")

    parsed = feedparser.parse(content)
    entries = parsed.entries[:count] if parsed and parsed.entries else []

    if not entries:
        raise NoNewsFoundError(f"No news found for '{query}'. Try a different topic, place, or spelling.")

    base_articles = []
    entries_meta = []
    for entry in entries:
        title = clean_title(getattr(entry, "title", "") or entry.get("title", ""))
        source = entry.get("source", {}).get("title", "Unknown Source") if hasattr(entry, "get") else "Unknown Source"
        published_raw = entry.get("published", "")
        link = entry.get("link", "")
        category = detect_category(topic, title)
        summary, highlights, related_topics = build_fallback_fields(title, source, category, topic)

        article = {
            "id": hashlib.md5((link or title).encode("utf-8")).hexdigest()[:12],
            "headline": title,
            "summary": summary,
            "source": source,
            "published_display": format_date(published_raw),
            "published_iso": to_iso(published_raw),
            "category": category,
            "highlights": highlights,
            "related_topics": related_topics,
            "link": link,
        }
        base_articles.append(article)
        entries_meta.append({
            "headline": title, "source": source,
            "date": article["published_display"], "category": category,
        })

    enrichment = try_llm_enrich(entries_meta, label)
    if enrichment:
        for article, extra in zip(base_articles, enrichment):
            try:
                if extra.get("summary"):
                    article["summary"] = str(extra["summary"]).strip()
                if extra.get("highlights"):
                    article["highlights"] = [str(h).strip() for h in extra["highlights"]][:3]
                if extra.get("related_topics"):
                    article["related_topics"] = [str(t).strip() for t in extra["related_topics"]][:4]
            except Exception:
                continue  # keep the reliable fallback fields for this article

    return {
        "label": label,
        "topic": smart_title(topic) if topic else "Top Headlines",
        "articles": base_articles,
    }


# ============================================================
# CLI (standalone testing)
# ============================================================

def main():
    print("\nNews Fetcher - type a topic/location, or 'quit'\n")
    while True:
        user_input = input("You: ").strip()
        if not user_input:
            continue
        if user_input.lower() in ("quit", "exit", "q"):
            print("\nBye!\n")
            break
        try:
            result = get_latest_news(user_input)
        except NewsError as e:
            print(f"\n⚠ {e}\n")
            continue
        print(f"\n{result['label']}\n")
        for i, a in enumerate(result["articles"], 1):
            print(f"{i}. {a['headline']}")
            print(f"   {a['source']} | {a['published_display']} | {a['category']}")
            print(f"   {a['summary']}")
            print(f"   Link: {a['link']}\n")


if __name__ == "__main__":
    main()