"""
Real World Information AI — SerpAPI powered (no LLM required)
================================================================
Fetches real-world / current information via SerpAPI and formats it into a
rich, well-structured Markdown answer (headings, bullet lists, key points,
related facts, tables, conclusion) that the frontend renders in a premium
ChatGPT-like chat UI.

Public API used by app.py:
    get_ai_answer(query: str) -> dict
        {
            "success": True/False,
            "query": "<original question>",
            "answer_markdown": "<markdown string>",
            "timestamp": "<ISO timestamp>",
            "error": "<only present when success is False>"
        }
"""

import os
import datetime
import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

SERP_API_KEY = os.getenv("SERP_API_KEY", "")
REQUEST_TIMEOUT = 15


# ══════════════════════════════════════════════════════════════════
#  SERPAPI SEARCH
# ══════════════════════════════════════════════════════════════════

def search_google(query):
    """Hit SerpAPI's Google Search endpoint. Returns dict, or {'error': ...}."""
    if not SERP_API_KEY:
        return {"error": "Search is not configured. Missing SERP_API_KEY."}

    params = {"q": query, "api_key": SERP_API_KEY, "gl": "in", "hl": "en"}
    try:
        r = requests.get("https://serpapi.com/search", params=params, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return r.json()
    except requests.exceptions.Timeout:
        return {"error": "The search request timed out. Please try again."}
    except requests.exceptions.ConnectionError:
        return {"error": "Network error while reaching the search service."}
    except Exception as e:
        return {"error": f"Search error: {e}"}


# ══════════════════════════════════════════════════════════════════
#  MARKDOWN RESPONSE BUILDER
# ══════════════════════════════════════════════════════════════════

def _clean(text):
    return (text or "").strip()


def _title_for(query, kg):
    if kg.get("title"):
        return kg["title"]
    return query.strip().rstrip("?").strip().title()


def _build_key_points(kg, ab):
    points = []
    if ab.get("answer"):
        points.append(_clean(ab["answer"]))
    if kg.get("description"):
        points.append(_clean(kg["description"]))
    # knowledge graph attributes make excellent "key point" bullets
    for k, v in kg.items():
        if k in ("title", "description", "thumbnail", "image", "kgmid", "type", "source"):
            continue
        if isinstance(v, str) and v.strip():
            points.append(f"**{k.replace('_', ' ').title()}:** {v.strip()}")
        if len(points) >= 6:
            break
    return points[:6]


def _build_table(kg):
    """Build a markdown table from simple scalar knowledge-graph attributes."""
    rows = []
    for k, v in kg.items():
        if k in ("title", "description", "thumbnail", "image", "kgmid", "type", "source"):
            continue
        if isinstance(v, str) and v.strip() and len(v) < 120:
            rows.append((k.replace("_", " ").title(), v.strip()))
    if len(rows) < 2:
        return ""
    lines = ["| Attribute | Detail |", "|---|---|"]
    for label, value in rows[:8]:
        value = value.replace("|", "/")
        lines.append(f"| {label} | {value} |")
    return "\n".join(lines)


def _build_related_facts(data):
    facts = []
    for item in data.get("related_questions", [])[:5]:
        q = _clean(item.get("question"))
        a = _clean(item.get("snippet"))
        if q and a:
            facts.append(f"**{q}** — {a}")
        elif q:
            facts.append(q)
    return facts


def _build_top_results(data):
    results = []
    for item in data.get("organic_results", [])[:5]:
        title = _clean(item.get("title"))
        snippet = _clean(item.get("snippet"))
        link = _clean(item.get("link"))
        if title and snippet:
            if link:
                results.append(f"[{title}]({link}) — {snippet}")
            else:
                results.append(f"**{title}** — {snippet}")
        elif snippet:
            results.append(snippet)
    return results


def _build_conclusion(query, kg, ab, organic):
    if ab.get("answer"):
        return f"In short, regarding **{query}** — {ab['answer']}"
    if kg.get("description"):
        return f"In summary, {kg['description']}"
    if organic and organic[0].get("snippet"):
        return f"Based on available sources, {organic[0]['snippet']}"
    return "This is a general overview based on the most relevant information found."


def build_markdown_answer(query, data):
    """Compose a full, richly formatted markdown answer from SerpAPI results."""
    ab = data.get("answer_box", {}) or {}
    kg = data.get("knowledge_graph", {}) or {}
    organic = data.get("organic_results", []) or []

    title = _title_for(query, kg)
    parts = [f"## {title}"]

    # --- Overview paragraph ---
    overview = ""
    if ab.get("answer"):
        overview = _clean(ab["answer"])
    elif ab.get("snippet"):
        overview = _clean(ab["snippet"])
    elif kg.get("description"):
        overview = _clean(kg["description"])
    elif organic and organic[0].get("snippet"):
        overview = _clean(organic[0]["snippet"])

    if overview:
        parts.append(overview)
    else:
        parts.append(
            "I couldn't find a direct answer for this, but here's the most "
            "relevant information available."
        )

    # --- Key Points ---
    key_points = _build_key_points(kg, ab)
    if key_points:
        parts.append("### Key Points")
        parts.append("\n".join(f"- {p}" for p in key_points))

    # --- Table (if structured attributes exist, e.g. country/entity facts) ---
    table = _build_table(kg)
    if table:
        parts.append("### Quick Facts")
        parts.append(table)

    # --- Related Facts ---
    related = _build_related_facts(data)
    if related:
        parts.append("### Related Facts")
        parts.append("\n".join(f"- {r}" for r in related))
    elif organic:
        top = _build_top_results(data)
        if top:
            parts.append("### Related Facts")
            parts.append("\n".join(f"- {r}" for r in top))

    # --- Important Note (only when data is thin) ---
    if not overview and not key_points and not related:
        parts.append(
            "> **Note:** Live search results were limited for this query. "
            "Try rephrasing your question for a more precise answer."
        )

    # --- Conclusion ---
    parts.append("### Conclusion")
    parts.append(_build_conclusion(query, kg, ab, organic))

    return "\n\n".join(parts)


# ══════════════════════════════════════════════════════════════════
#  PUBLIC ENTRYPOINT
# ══════════════════════════════════════════════════════════════════

def get_ai_answer(query):
    """Main entrypoint used by the Flask route. Always returns a dict."""
    query = _clean(query)
    timestamp = datetime.datetime.now().isoformat()

    if not query:
        return {
            "success": False,
            "error": "Please enter a question before submitting.",
            "query": query,
            "timestamp": timestamp,
        }

    data = search_google(query)

    if "error" in data:
        return {
            "success": False,
            "error": data["error"],
            "query": query,
            "timestamp": timestamp,
        }

    try:
        markdown = build_markdown_answer(query, data)
    except Exception as e:
        return {
            "success": False,
            "error": f"Something went wrong while formatting the answer: {e}",
            "query": query,
            "timestamp": timestamp,
        }

    if not markdown or not markdown.strip():
        return {
            "success": False,
            "error": "No response available for this question. Please try rephrasing it.",
            "query": query,
            "timestamp": timestamp,
        }

    return {
        "success": True,
        "query": query,
        "answer_markdown": markdown,
        "timestamp": timestamp,
    }


# Backwards-compatible simple text version (kept for CLI / legacy use)
def get_answer(query):
    result = get_ai_answer(query)
    if result["success"]:
        return result["answer_markdown"]
    return result.get("error", "Sorry, couldn't find an answer.")


def main():
    print("Real World Information AI (SerpAPI). Type 'exit' to quit.\n")
    while True:
        q = input("You: ").strip()
        if q.lower() in ("exit", "quit"):
            break
        if not q:
            continue
        print("Bot:\n", get_answer(q), "\n")


if __name__ == "__main__":
    main()