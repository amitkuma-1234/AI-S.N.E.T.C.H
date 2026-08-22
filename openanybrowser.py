"""
openanybrowser.py - "Open Browser" feature backend for S.N.E.T.C.H
================================================================
Given text typed or spoken by the user (e.g. "chrome", "open youtube",
"launch edge"), this module figures out whether the user wants to:

  1. Launch a web BROWSER installed on the machine, or
  2. Open a WEBSITE (in the default browser)

...and does it. It also handles fuzzy/ambiguous input by returning a
list of possible matches so the frontend can show a selection dialog.

Public API used by app.py:

    decide_match(query) -> dict
        {"status": "single",    "match": {...}}
        {"status": "multiple",  "matches": [{...}, ...]}
        {"status": "not_found", "message": "..."}

    launch(match) -> dict
        match = {"type": "browser"|"website", "name": ..., "target": ...}
        Returns: {"success": True/False, "message": "..."}

Everything else in this file is implementation detail.
"""

import os
import platform
import shutil
import subprocess
import urllib.request
import urllib.parse
import webbrowser

try:
    from rapidfuzz import fuzz
    FUZZY_OK = True
except ImportError:
    FUZZY_OK = False
    print("[INFO] rapidfuzz not installed. Run: pip install rapidfuzz")

IS_WINDOWS = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"
IS_LINUX = platform.system() == "Linux"


# ══════════════════════════════════════════════════════════════════════
#  KNOWN BROWSERS
#  "commands" lists the names/paths tried, in order, to launch the
#  browser on the current OS.
# ══════════════════════════════════════════════════════════════════════
BROWSER_CATALOG = [
    {
        "key": "chrome", "name": "Google Chrome",
        "aliases": ["chrome", "google chrome", "gchrome"],
        "windows": ["chrome"],
        "mac": ["Google Chrome"],
        "linux": ["google-chrome", "google-chrome-stable", "chromium-browser"],
    },
    {
        "key": "edge", "name": "Microsoft Edge",
        "aliases": ["edge", "microsoft edge", "msedge"],
        "windows": ["msedge"],
        "mac": ["Microsoft Edge"],
        "linux": ["microsoft-edge", "microsoft-edge-stable"],
    },
    {
        "key": "firefox", "name": "Mozilla Firefox",
        "aliases": ["firefox", "mozilla firefox", "mozilla"],
        "windows": ["firefox"],
        "mac": ["Firefox"],
        "linux": ["firefox"],
    },
    {
        "key": "brave", "name": "Brave",
        "aliases": ["brave", "brave browser"],
        "windows": ["brave"],
        "mac": ["Brave Browser"],
        "linux": ["brave-browser"],
    },
    {
        "key": "opera", "name": "Opera",
        "aliases": ["opera"],
        "windows": ["opera"],
        "mac": ["Opera"],
        "linux": ["opera"],
    },
    {
        "key": "opera_gx", "name": "Opera GX",
        "aliases": ["opera gx", "operagx"],
        "windows": ["operagx"],
        "mac": ["Opera GX"],
        "linux": ["opera-gx"],
    },
    {
        "key": "safari", "name": "Safari",
        "aliases": ["safari"],
        "windows": [],
        "mac": ["Safari"],
        "linux": [],
    },
    {
        "key": "chromium", "name": "Chromium",
        "aliases": ["chromium"],
        "windows": ["chromium"],
        "mac": ["Chromium"],
        "linux": ["chromium", "chromium-browser"],
    },
    {
        "key": "tor", "name": "Tor Browser",
        "aliases": ["tor", "tor browser"],
        "windows": ["tor browser"],
        "mac": ["Tor Browser"],
        "linux": ["torbrowser-launcher"],
    },
    {
        "key": "vivaldi", "name": "Vivaldi",
        "aliases": ["vivaldi"],
        "windows": ["vivaldi"],
        "mac": ["Vivaldi"],
        "linux": ["vivaldi-stable", "vivaldi"],
    },
    {
        "key": "arc", "name": "Arc Browser",
        "aliases": ["arc", "arc browser"],
        "windows": ["arc"],
        "mac": ["Arc"],
        "linux": [],
    },
    {
        "key": "ie", "name": "Internet Explorer",
        "aliases": ["internet explorer", "ie"],
        "windows": ["iexplore"],
        "mac": [],
        "linux": [],
    },
]

# ══════════════════════════════════════════════════════════════════════
#  KNOWN WEBSITES
# ══════════════════════════════════════════════════════════════════════
WEBSITE_CATALOG = [
    {"key": "youtube", "name": "YouTube", "aliases": ["youtube", "yt"], "url": "https://www.youtube.com"},
    {"key": "google", "name": "Google", "aliases": ["google", "google search"], "url": "https://www.google.com"},
    {"key": "chatgpt", "name": "ChatGPT", "aliases": ["chatgpt", "chat gpt", "openai chat"], "url": "https://chat.openai.com"},
    {"key": "github", "name": "GitHub", "aliases": ["github"], "url": "https://github.com"},
    {"key": "stackoverflow", "name": "Stack Overflow", "aliases": ["stack overflow", "stackoverflow"], "url": "https://stackoverflow.com"},
    {"key": "linkedin", "name": "LinkedIn", "aliases": ["linkedin"], "url": "https://www.linkedin.com"},
    {"key": "facebook", "name": "Facebook", "aliases": ["facebook", "fb"], "url": "https://www.facebook.com"},
    {"key": "instagram", "name": "Instagram", "aliases": ["instagram", "insta"], "url": "https://www.instagram.com"},
    {"key": "twitter", "name": "X (Twitter)", "aliases": ["twitter", "x"], "url": "https://twitter.com"},
    {"key": "gmail", "name": "Gmail", "aliases": ["gmail", "google mail"], "url": "https://mail.google.com"},
    {"key": "maps", "name": "Google Maps", "aliases": ["google maps", "maps"], "url": "https://maps.google.com"},
    {"key": "amazon", "name": "Amazon", "aliases": ["amazon"], "url": "https://www.amazon.com"},
    {"key": "flipkart", "name": "Flipkart", "aliases": ["flipkart"], "url": "https://www.flipkart.com"},
    {"key": "netflix", "name": "Netflix", "aliases": ["netflix"], "url": "https://www.netflix.com"},
    {"key": "wikipedia", "name": "Wikipedia", "aliases": ["wikipedia", "wiki"], "url": "https://www.wikipedia.org"},
    {"key": "reddit", "name": "Reddit", "aliases": ["reddit"], "url": "https://www.reddit.com"},
    {"key": "spotify", "name": "Spotify", "aliases": ["spotify"], "url": "https://www.spotify.com"},
    {"key": "discord", "name": "Discord", "aliases": ["discord"], "url": "https://discord.com"},
]

# Words that don't carry meaning about *what* to open.
_STOPWORDS = {
    "open", "visit", "go", "to", "launch", "start", "website", "site",
    "web", "the", "please", "a", "an", "browser", "app", "for", "me",
}


def clean_query(text):
    """Strip filler words like 'open', 'launch', 'please' from user input."""
    raw = (text or "").lower().strip()
    words = [w for w in raw.replace(".", " ").split() if w not in _STOPWORDS]
    cleaned = " ".join(words).strip()
    return cleaned or raw


def _score(query, candidates):
    """Highest fuzzy score between the query and a list of alias strings."""
    if not query:
        return 0
    if not FUZZY_OK:
        q = query.lower()
        best = 0
        for c in candidates:
            c_l = c.lower()
            if q == c_l:
                return 100
            if q in c_l or c_l in q:
                best = max(best, 70)
        return best

    q = query.lower().strip()

    # Very short input (1-2 chars) is only trustworthy as an exact alias
    # match ("x", "yt", "ie") — fuzzy scoring on such short strings
    # produces noisy false positives against unrelated longer words.
    if len(q) <= 2:
        return 100 if any(q == c.lower() for c in candidates) else 0

    best = 0
    for c in candidates:
        c_l = c.lower()
        if q == c_l:
            return 100
        best = max(best, fuzz.WRatio(q, c_l), fuzz.token_sort_ratio(q, c_l))
        # partial_ratio is only meaningful once the query has enough
        # characters — otherwise a short query "matches" almost every
        # candidate that happens to contain those letters.
        if len(q) >= 4:
            best = max(best, fuzz.partial_ratio(q, c_l) * 0.9)
    return best


# ══════════════════════════════════════════════════════════════════════
#  SMART MATCHING
# ══════════════════════════════════════════════════════════════════════
def search_catalog(raw_query, threshold=60, limit=6):
    """Return best matching browsers + websites for raw_query, ranked by
    score, each tagged with its type ("browser" or "website")."""
    cleaned = clean_query(raw_query)
    if not cleaned:
        return []

    scored = []

    for browser in BROWSER_CATALOG:
        score = max(_score(cleaned, browser["aliases"]), _score(raw_query.lower().strip(), browser["aliases"]))
        if score >= threshold:
            scored.append({
                "type": "browser",
                "name": browser["name"],
                "target": browser["key"],
                "url": None,
                "score": round(score, 1),
            })

    for site in WEBSITE_CATALOG:
        score = max(_score(cleaned, site["aliases"]), _score(raw_query.lower().strip(), site["aliases"]))
        if score >= threshold:
            scored.append({
                "type": "website",
                "name": site["name"],
                "target": site["url"],
                "url": site["url"],
                "score": round(score, 1),
            })

    # Dedupe, keep the best score per (type, name)
    best_by_key = {}
    for item in scored:
        key = (item["type"], item["name"].lower())
        if key not in best_by_key or item["score"] > best_by_key[key]["score"]:
            best_by_key[key] = item

    results = sorted(best_by_key.values(), key=lambda r: r["score"], reverse=True)
    return results[:limit]


def _guess_website(raw_query):
    """Fallback for names not in our curated catalog: try a direct
    name.com / name.in / name.org guess, then a lightweight DuckDuckGo
    lookup, exactly like the previous standalone script did."""
    cleaned = clean_query(raw_query)
    if not cleaned:
        return None

    slug = cleaned.replace(" ", "").replace("-", "")
    if not slug:
        return None

    for url in [
        f"https://www.{slug}.com",
        f"https://{slug}.com",
        f"https://www.{slug}.in",
        f"https://{slug}.in",
        f"https://www.{slug}.org",
    ]:
        try:
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
            res = urllib.request.urlopen(req, timeout=3)
            if res.status < 400:
                return {"name": cleaned.title(), "url": url}
        except Exception:
            continue

    try:
        import requests
        from bs4 import BeautifulSoup

        r = requests.post(
            "https://html.duckduckgo.com/html/",
            data={"q": f"{cleaned} official website", "b": ""},
            timeout=10,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0",
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": "https://duckduckgo.com/",
            },
        )
        soup = BeautifulSoup(r.text, "html.parser")
        for a in soup.select("a.result__a"):
            href = a.get("href", "")
            if "uddg=" in href:
                href = urllib.parse.unquote(href.split("uddg=")[-1].split("&")[0])
            if href.startswith("http"):
                return {"name": cleaned.title(), "url": href}
    except Exception as e:
        print(f"[openanybrowser] fallback search error: {e}")

    return None


def decide_match(raw_query):
    """High-level entry point used by /api/openanybrowser/search."""
    if not raw_query or not raw_query.strip():
        return {"status": "not_found", "message": "Please tell me which browser or website to open."}

    results = search_catalog(raw_query)

    if not results:
        guess = _guess_website(raw_query)
        if guess:
            return {
                "status": "single",
                "match": {"type": "website", "name": guess["name"], "target": guess["url"], "url": guess["url"]},
            }
        return {
            "status": "not_found",
            "message": "No matching browser or website was found. Please try another name.",
        }

    if len(results) == 1:
        return {"status": "single", "match": results[0]}

    top, second = results[0], results[1]
    # A perfect alias match (e.g. "gmail", "chrome") is decisive on its
    # own — don't let unrelated fuzzy noise from other entries turn it
    # into an ambiguous "multiple" result.
    if top["score"] >= 100:
        return {"status": "single", "match": top}
    if top["score"] >= 82 and (top["score"] - second["score"]) >= 15:
        return {"status": "single", "match": top}

    return {"status": "multiple", "matches": results}


# ══════════════════════════════════════════════════════════════════════
#  LAUNCH
# ══════════════════════════════════════════════════════════════════════
def _launch_browser(browser_key):
    entry = next((b for b in BROWSER_CATALOG if b["key"] == browser_key), None)
    if not entry:
        return {"success": False, "message": "Browser not found."}

    if IS_WINDOWS:
        candidates = entry["windows"]
        for cmd in candidates:
            try:
                os.startfile(cmd)  # noqa: Windows-only attribute
                return {"success": True, "message": f"{entry['name']} launched successfully."}
            except Exception:
                continue
        for cmd in candidates:
            try:
                subprocess.Popen(["cmd", "/c", "start", "", cmd], shell=False)
                return {"success": True, "message": f"{entry['name']} launched successfully."}
            except Exception:
                continue

    elif IS_MAC:
        for app_name in entry["mac"]:
            try:
                subprocess.Popen(["open", "-a", app_name])
                return {"success": True, "message": f"{entry['name']} launched successfully."}
            except Exception:
                continue

    elif IS_LINUX:
        for binary in entry["linux"]:
            if shutil.which(binary):
                try:
                    subprocess.Popen([binary])
                    return {"success": True, "message": f"{entry['name']} launched successfully."}
                except Exception:
                    continue

    return {
        "success": False,
        "message": f"{entry['name']} does not appear to be installed on this device.",
    }


def launch(match):
    """match = {"type": "browser"|"website", "name": ..., "target": ...}"""
    if not match or not match.get("type"):
        return {"success": False, "message": "Nothing to launch."}

    m_type = match["type"]
    target = match.get("target")
    name = match.get("name", "")

    if m_type == "website":
        if not target:
            return {"success": False, "message": "No website URL was provided."}
        try:
            webbrowser.open(target)
            return {"success": True, "message": f"{name} opened successfully."}
        except Exception as e:
            return {"success": False, "message": f"Could not open {name}: {e}"}

    if m_type == "browser":
        return _launch_browser(target)

    return {"success": False, "message": "Unknown launch type."}


if __name__ == "__main__":
    print(decide_match("open youtube"))
    print(decide_match("chrome"))
