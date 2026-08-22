

"""
wikipidea.py — S.N.E.T.C.H Wikipedia AI Assistant (backend)

Exposes a single high-level entry point used by app.py's
/api/wikipedia/search route:

    ask_wikipidia(query) -> dict

The dict always has a "status" key, one of:
    "ok"          -> full structured answer (see build_answer)
    "empty"       -> the query was blank
    "not_found"   -> no article matched the query
    "ambiguous"   -> the query matches multiple possible articles
    "error"       -> network / backend failure

No third-party Wikipedia libraries are required — only `requests`
(already a project dependency), talking directly to Wikipedia's public
REST + Action APIs.
"""

import re
import datetime
import urllib.parse

import requests

WIKI_ACTION_API = "https://en.wikipedia.org/w/api.php"
WIKI_REST_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/"
WIKI_ARTICLE_BASE = "https://en.wikipedia.org/wiki/"

_HEADERS = {
    "User-Agent": "SNETCH-WikipediaAI/1.0 (https://github.com/snetch; contact: snetch@example.com)"
}
_TIMEOUT = 8


# ────────────────────────────────────────────────────────────────────────────
#  LOW-LEVEL HTTP HELPERS
# ────────────────────────────────────────────────────────────────────────────

def _get_json(url, params=None):
    resp = requests.get(url, params=params, headers=_HEADERS, timeout=_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def _get_json_raw(url):
    resp = requests.get(url, headers=_HEADERS, timeout=_TIMEOUT)
    return resp


# ────────────────────────────────────────────────────────────────────────────
#  SEARCH RESOLUTION
# ────────────────────────────────────────────────────────────────────────────

def _search_candidates(query, limit=6):
    """Return a list of candidate article titles for a free-text query."""
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "srlimit": limit,
        "format": "json",
    }
    data = _get_json(WIKI_ACTION_API, params)
    hits = data.get("query", {}).get("search", [])
    return [h["title"] for h in hits]


def _extracts_and_links(title):
    """Fetch plain-text extract + a handful of related links + thumbnail
    in one Action API call."""
    params = {
        "action": "query",
        "prop": "extracts|pageimages|links|info",
        "explaintext": 1,
        "exsectionformat": "plain",
        "piprop": "thumbnail",
        "pithumbsize": 400,
        "pllimit": 15,
        "plnamespace": 0,
        "inprop": "url",
        "titles": title,
        "redirects": 1,
        "format": "json",
    }
    data = _get_json(WIKI_ACTION_API, params)
    pages = data.get("query", {}).get("pages", {})
    if not pages:
        return None
    page = next(iter(pages.values()))
    if "missing" in page:
        return None
    return page


# ────────────────────────────────────────────────────────────────────────────
#  ANSWER BUILDING
# ────────────────────────────────────────────────────────────────────────────

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])")


def _split_sentences(text, limit=None):
    text = text.strip()
    if not text:
        return []
    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s.strip()]
    return sentences[:limit] if limit else sentences


def _build_key_facts(extract, max_facts=5):
    sentences = _split_sentences(extract, limit=max_facts + 1)
    # Skip the very first sentence (it's usually the summary lede) when we
    # have enough material, so key facts feel distinct from the summary.
    facts = sentences[1:max_facts + 1] if len(sentences) > 1 else sentences
    return facts


def _build_paragraphs(extract, max_paragraphs=3, max_chars=1600):
    raw_paragraphs = [p.strip() for p in extract.split("\n") if p.strip()]
    detailed = raw_paragraphs[1:max_paragraphs + 1] if len(raw_paragraphs) > 1 else raw_paragraphs
    joined = "\n\n".join(detailed)
    if len(joined) > max_chars:
        joined = joined[:max_chars].rsplit(" ", 1)[0] + "…"
    return joined


def build_answer(title, page):
    extract = page.get("extract", "") or ""
    paragraphs = [p.strip() for p in extract.split("\n") if p.strip()]
    summary = paragraphs[0] if paragraphs else ""

    thumbnail = None
    if page.get("thumbnail"):
        thumbnail = page["thumbnail"].get("source")

    links = page.get("links", []) or []
    related = [l["title"] for l in links if l.get("ns", 0) == 0][:8]

    canonical_url = page.get("fullurl") or (WIKI_ARTICLE_BASE + urllib.parse.quote(title.replace(" ", "_")))

    return {
        "status": "ok",
        "title": page.get("title", title),
        "summary": summary,
        "detailed": _build_paragraphs(extract),
        "key_facts": _build_key_facts(extract),
        "related_topics": related,
        "references": [
            {"label": "Wikipedia — " + page.get("title", title), "url": canonical_url}
        ],
        "thumbnail": thumbnail,
        "page_url": canonical_url,
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
    }


# ────────────────────────────────────────────────────────────────────────────
#  PUBLIC ENTRY POINT
# ────────────────────────────────────────────────────────────────────────────

def ask_wikipidia(query):
    """Main entry point: resolve `query` to a Wikipedia article and return a
    structured, ready-to-render answer (or a well-defined error state)."""
    query = (query or "").strip()
    if not query:
        return {"status": "empty", "message": "Please type or say a question first."}

    try:
        # 1) Try the REST summary endpoint directly (fast path — handles
        #    exact / close title matches and redirects automatically).
        direct_title = query
        resp = _get_json_raw(WIKI_REST_SUMMARY + urllib.parse.quote(direct_title.replace(" ", "_")))

        page_type = None
        rest_json = None
        if resp.status_code == 200:
            rest_json = resp.json()
            page_type = rest_json.get("type")

        if resp.status_code == 200 and page_type not in ("disambiguation",):
            resolved_title = rest_json.get("title", direct_title)
            page = _extracts_and_links(resolved_title)
            if page:
                return build_answer(resolved_title, page)

        # 2) Direct lookup failed, was ambiguous, or returned no usable
        #    extract — fall back to full-text search.
        candidates = _search_candidates(query)
        if not candidates:
            return {"status": "not_found", "query": query}

        if page_type == "disambiguation" or len(candidates) > 1:
            top_title = candidates[0]
            page = _extracts_and_links(top_title)
            # Only surface an "ambiguous" state if the top result itself
            # is genuinely unclear (a real disambiguation page) — otherwise
            # just answer with the best match, like a good assistant would.
            if page_type == "disambiguation":
                return {
                    "status": "ambiguous",
                    "query": query,
                    "options": candidates,
                }
            if page:
                return build_answer(top_title, page)

        best_title = candidates[0]
        page = _extracts_and_links(best_title)
        if not page:
            return {"status": "not_found", "query": query}
        return build_answer(best_title, page)

    except requests.exceptions.Timeout:
        return {"status": "error", "message": "The connection to Wikipedia timed out. Please try again."}
    except requests.exceptions.RequestException:
        return {"status": "error", "message": "A network error occurred while reaching Wikipedia."}
    except Exception:
        return {"status": "error", "message": "Something went wrong while processing that request."}


# ────────────────────────────────────────────────────────────────────────────
#  CLI (kept for parity with the original script)
# ────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    result = ask_wikipidia(input("Enter search query: "))
    print(result)



























