"""
askbygoogle.py — S.N.E.T.C.H Web AI Search (Google)

Exposes two functions used by app.py's /api/askbygoogle/search route:
  • optimize_query(raw)  — cleans filler words and returns a lean search query
  • get_google_url(query) — returns the full Google search URL for that query

The original CLI helper (bygoogle) is preserved unchanged.
"""

import re
from urllib.parse import quote_plus

# ── Filler words stripped before sending to Google ──────────────────────────

FILLER_WORDS = [
    r"\bwhat is the\b", r"\bwhat are the\b", r"\bwhat is\b", r"\bwhat are\b",
    r"\bwhere is the\b", r"\bwhere is\b", r"\bwhere are\b",
    r"\bhow to\b", r"\bhow do i\b", r"\bhow does\b",
    r"\bwho is the\b", r"\bwho is\b", r"\bwhen is\b",
    r"\btell me about\b", r"\bcan you tell me\b",
    r"\bplease find\b", r"\bfind me\b", r"\bsearch for\b",
    r"\bcan you search\b", r"\bsearch\b", r"\blook up\b",
    r"\bshow me\b", r"\bgive me\b", r"\bi want to know\b",
    r"\bi need to know\b", r"\bexplain to me\b", r"\bexplain\b",
]


def optimize_query(raw: str) -> str:
    """
    Strip filler words from the user's natural-language prompt and return a
    concise, Google-friendly search query.

    Examples
    --------
    "what is the best laptop under 80000"  ->  "best laptop under 80000"
    "tell me about quantum computing"       ->  "quantum computing"
    "latest ai news today"                 ->  "latest ai news today"   (no change needed)
    """
    cleaned = raw.strip()
    for pattern in FILLER_WORDS:
        cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
    # Collapse multiple spaces
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    # Fall back to original if stripping emptied the string
    return cleaned if cleaned else raw.strip()


def get_google_url(query: str) -> str:
    """Return a Google Search URL for the given (already-optimised) query."""
    return f"https://www.google.com/search?q={quote_plus(query)}"


# ── Legacy CLI helper (unchanged) ───────────────────────────────────────────

def clean_query(query: str) -> str:
    """Legacy: same as optimize_query — kept for CLI use."""
    return optimize_query(query)


def bygoogle(search: str) -> None:
    """CLI entry point — opens Google in the default browser."""
    import webbrowser
    optimized = optimize_query(search)
    print(f"Original query : {search}")
    print(f"Optimized query: {optimized}")
    print("Opening Google Search...")
    webbrowser.open(get_google_url(optimized))


if __name__ == "__main__":
    bygoogle("what is the best laptop under 80000")
