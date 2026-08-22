"""
Entertainment Chatbot - TMDB Only (No LLM)
-------------------------------------------
Comprehensive entertainment chatbot using only the TMDB API.
Supports movies, TV shows, actors, directors, trending, recommendations,
comparisons, follow-up questions, watch providers, trailers, and more.

Setup:
    pip install requests
    Store your TMDB API key in a .env file:
        TMDB_API_KEY = "your_key_here"
    Get a free key at: https://www.themoviedb.org/settings/api
"""

import os, re, requests

# ── Load .env ─────────────────────────────────────────────────────────────
try:
    from dotenv import load_dotenv; load_dotenv()
except ImportError:
    _ep = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.isfile(_ep):
        with open(_ep) as _f:
            for _l in _f:
                _l = _l.strip()
                if _l and not _l.startswith("#") and "=" in _l:
                    _k, _, _v = _l.partition("=")
                    os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

TMDB_API_KEY = os.getenv("TMDB_API_KEY", "")
if not TMDB_API_KEY:
    raise RuntimeError("TMDB_API_KEY not set. Get one at https://www.themoviedb.org/settings/api")

BASE = "https://api.themoviedb.org/3"
IMG = "https://image.tmdb.org/t/p/w500"
HDR = {"User-Agent": "Mozilla/5.0"}

# ── Constants ─────────────────────────────────────────────────────────────
MOVIE_GENRES = {
    "action":28,"adventure":12,"animation":16,"comedy":35,"crime":80,
    "documentary":99,"drama":18,"family":10751,"fantasy":14,"history":36,
    "historical":36,"horror":27,"music":10402,"musical":10402,"mystery":9648,
    "romance":10749,"romantic":10749,"sci-fi":878,"science fiction":878,
    "scifi":878,"thriller":53,"war":10752,"western":37,
}
TV_GENRES = {
    "action":10759,"adventure":10759,"animation":16,"comedy":35,"crime":80,
    "documentary":99,"drama":18,"family":10751,"kids":10762,"mystery":9648,
    "reality":10764,"sci-fi":10765,"science fiction":10765,"war":10768,"western":37,
}
LANG_MAP = {
    "hindi":"hi","bollywood":"hi","english":"en","hollywood":"en",
    "tamil":"ta","kollywood":"ta","telugu":"te","tollywood":"te",
    "kannada":"kn","sandalwood":"kn","malayalam":"ml","mollywood":"ml",
    "marathi":"mr","bengali":"bn","punjabi":"pa",
    "korean":"ko","k-drama":"ko","japanese":"ja","anime":"ja",
    "chinese":"zh","mandarin":"zh","spanish":"es","french":"fr",
    "german":"de","italian":"it","portuguese":"pt","russian":"ru",
    "arabic":"ar","thai":"th","turkish":"tr",
}
COUNTRY_MAP = {
    "indian":"IN","india":"IN","american":"US","america":"US","usa":"US",
    "korean":"KR","korea":"KR","south korean":"KR",
    "japanese":"JP","japan":"JP","chinese":"CN","china":"CN",
    "french":"FR","france":"FR","italian":"IT","italy":"IT",
    "german":"DE","germany":"DE","british":"GB","uk":"GB",
    "spanish":"ES","spain":"ES","australian":"AU","australia":"AU",
    "canadian":"CA","canada":"CA","russian":"RU","russia":"RU",
    "turkish":"TR","turkey":"TR","thai":"TH","thailand":"TH",
    "mexican":"MX","mexico":"MX","brazilian":"BR","brazil":"BR",
}
COMPANY_MAP = {
    "marvel":420,"marvel studios":420,"dc":128064,"dc studios":128064,
    "pixar":3,"disney":2,"walt disney":2,"warner bros":174,"warner brothers":174,
    "universal":33,"universal pictures":33,"paramount":4,"sony":34,
    "columbia":5,"20th century fox":25,"lionsgate":1632,"a24":41077,
    "netflix":213,"amazon studios":20580,"hbo":3268,"dreamworks":7,
    "studio ghibli":10342,"yash raj":9201,"yrf":9201,
    "dharma":8269,"dharma productions":8269,
}
ENT_KW = {
    "movie","film","series","show","tv","actor","actress","director","cast",
    "rating","release","genre","plot","trending","tranding","recommend","suggest","similar",
    "bollywood","hollywood","tollywood","kollywood","tamil","telugu","kannada",
    "malayalam","hindi","watch","trailer","season","episode","web","anime",
    "documentary","thriller","comedy","horror","action","romance","drama",
    "biography","born","birthday","filmography","poster","popular","upcoming",
    "collection","budget","revenue","ott","stream","netflix","amazon","disney",
    "crew","overview","summary","celebrity","compare","search","find","imdb",
    "teaser","video","backdrop","produced","wrote","screenplay","music",
    "composer","cinematograph","now playing","airing","top rated","starred",
}

# ── Context for follow-ups ────────────────────────────────────────────────
ctx = {"id":None, "title":None, "type":None, "data":None, "choices":None, "ctype":None}

def set_ctx(data, dtype):
    ctx["data"], ctx["type"], ctx["id"] = data, dtype, data.get("id")
    ctx["title"] = data.get("title") or data.get("name")
    ctx["accessed_this_turn"] = True

# ── Core API call ─────────────────────────────────────────────────────────
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def api(endpoint, params=None):
    p = {"api_key": TMDB_API_KEY}
    if params: p.update(params)
    
    bases = [BASE, "https://api.tmdb.org/3"]
    r = None
    last_err = None
    
    for b in bases:
        try:
            r = requests.get(f"{b}/{endpoint}", params=p, headers=HDR, timeout=7, verify=False)
            break
        except requests.exceptions.RequestException as e:
            last_err = e
            continue
            
    if r is None:
        print(f"\n⚠️  No internet connection or TMDB is blocked. (Details: {last_err})")
        return None
        
    try:
        if r.status_code == 401: print("\n⚠️  Invalid API key."); return None
        if r.status_code == 429: print("\n⚠️  Rate limit. Wait and retry."); return None
        if r.status_code == 404: return None
        r.raise_for_status(); return r.json()
    except Exception as e:
        print(f"\n⚠️  Error: {e}")
        return None

# ── Search functions ──────────────────────────────────────────────────────
def search_movie(q):
    d = api("search/movie", {"query":q,"language":"en-US"}); return d.get("results",[]) if d else []
def search_tv(q):
    d = api("search/tv", {"query":q,"language":"en-US"}); return d.get("results",[]) if d else []
def search_person(q):
    d = api("search/person", {"query":q,"language":"en-US"}); return d.get("results",[]) if d else []
def search_multi(q):
    d = api("search/multi", {"query":q,"language":"en-US"}); return d.get("results",[]) if d else []
def search_collection(q):
    d = api("search/collection", {"query":q,"language":"en-US"}); return d.get("results",[]) if d else []
def search_company(q):
    d = api("search/company", {"query":q}); return d.get("results",[]) if d else []

# ── Detail functions (append everything for efficiency) ───────────────────
def movie_detail(mid):
    return api(f"movie/{mid}", {"language":"en-US",
        "append_to_response":"credits,videos,images,keywords,watch/providers,external_ids,recommendations"})
def tv_detail(tid):
    return api(f"tv/{tid}", {"language":"en-US",
        "append_to_response":"credits,videos,images,keywords,watch/providers,external_ids,recommendations"})
def person_detail(pid):
    return api(f"person/{pid}", {"language":"en-US",
        "append_to_response":"movie_credits,tv_credits,images,external_ids"})
def collection_detail(cid):
    return api(f"collection/{cid}", {"language":"en-US"})

# ── List functions ────────────────────────────────────────────────────────
def trending(mtype="movie", window="week"):
    d = api(f"trending/{mtype}/{window}", {"language":"en-US"}); return (d.get("results",[]) if d else [])[:12]
def popular_movies():
    d = api("movie/popular", {"language":"en-US"}); return (d.get("results",[]) if d else [])[:10]
def top_rated_movies():
    d = api("movie/top_rated", {"language":"en-US"}); return (d.get("results",[]) if d else [])[:10]
def now_playing():
    d = api("movie/now_playing", {"language":"en-US"}); return (d.get("results",[]) if d else [])[:10]
def upcoming_movies():
    d = api("movie/upcoming", {"language":"en-US"}); return (d.get("results",[]) if d else [])[:10]
def popular_tv():
    d = api("tv/popular", {"language":"en-US"}); return (d.get("results",[]) if d else [])[:10]
def top_rated_tv():
    d = api("tv/top_rated", {"language":"en-US"}); return (d.get("results",[]) if d else [])[:10]
def airing_today():
    d = api("tv/airing_today", {"language":"en-US"}); return (d.get("results",[]) if d else [])[:10]
def on_the_air():
    d = api("tv/on_the_air", {"language":"en-US"}); return (d.get("results",[]) if d else [])[:10]

# ── Discover functions ────────────────────────────────────────────────────
def disc_movie(**kw):
    p = {"language":"en-US","sort_by":"popularity.desc"}; p.update(kw)
    d = api("discover/movie", p); return (d.get("results",[]) if d else [])[:10]
def disc_tv(**kw):
    p = {"language":"en-US","sort_by":"popularity.desc"}; p.update(kw)
    d = api("discover/tv", p); return (d.get("results",[]) if d else [])[:10]


# ══════════════════════════════════════════════════════════════════════════
# DISPLAY FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════

def show_movie_full(m):
    t = m.get("title","?"); rd = m.get("release_date","N/A")
    r = round(m.get("vote_average",0),1); vc = m.get("vote_count",0)
    rt = m.get("runtime") or "N/A"; ov = m.get("overview") or "No overview."
    gs = ", ".join(g["name"] for g in m.get("genres",[])) or "N/A"
    lg = m.get("original_language","").upper()
    tl = m.get("tagline",""); pop = round(m.get("popularity",0),1)
    sp = ", ".join(l.get("english_name",l.get("name","")) for l in m.get("spoken_languages",[])) or "N/A"
    co = ", ".join(c.get("name","") for c in m.get("production_companies",[])) or "N/A"
    pc = ", ".join(c.get("name","") for c in m.get("production_countries",[])) or "N/A"
    cast = m.get("credits",{}).get("cast",[])[:5]
    cs = ", ".join(f'{c["name"]} as {c.get("character","?")}' for c in cast) or "N/A"
    crew = m.get("credits",{}).get("crew",[])
    dirs = ", ".join(c["name"] for c in crew if c.get("job")=="Director") or "N/A"
    bud = m.get("budget",0); rev = m.get("revenue",0)
    hp = m.get("homepage") or "N/A"
    print(f'\n🎬  {t} ({rd[:4] if rd!="N/A" else "N/A"})')
    if tl: print(f'   "{tl}"')
    print(f"   ⭐ Rating: {r}/10 ({vc} votes) | Popularity: {pop}")
    print(f"   📅 Release: {rd}  |  ⏱️ Runtime: {rt} min")
    print(f"   🌐 Language: {lg} | Spoken: {sp}")
    print(f"   🎭 Genres: {gs}")
    print(f"   🎬 Director: {dirs}")
    print(f"   👥 Cast: {cs}")
    if bud>0: print(f"   💰 Budget: ${bud:,}")
    if rev>0: print(f"   💵 Revenue: ${rev:,}")
    print(f"   🏭 Production: {co}")
    print(f"   🌍 Countries: {pc}")
    print(f"   🔞 Adult: {'Yes' if m.get('adult') else 'No'}")
    if hp!="N/A": print(f"   🔗 Homepage: {hp}")
    print(f"   📖 Plot: {ov}")

def show_tv_full(s):
    t = s.get("name","?"); fa = s.get("first_air_date","N/A")
    la = s.get("last_air_date","N/A"); st = s.get("status","N/A")
    r = round(s.get("vote_average",0),1); vc = s.get("vote_count",0)
    pop = round(s.get("popularity",0),1)
    sn = s.get("number_of_seasons","N/A"); ep = s.get("number_of_episodes","N/A")
    ov = s.get("overview") or "No overview."; tl = s.get("tagline","")
    gs = ", ".join(g["name"] for g in s.get("genres",[])) or "N/A"
    lg = s.get("original_language","").upper()
    ert = s.get("episode_run_time",[]); rt = f"{ert[0]} min" if ert else "N/A"
    sp = ", ".join(l.get("english_name",l.get("name","")) for l in s.get("spoken_languages",[])) or "N/A"
    nw = ", ".join(n.get("name","") for n in s.get("networks",[])) or "N/A"
    co = ", ".join(c.get("name","") for c in s.get("production_companies",[])) or "N/A"
    hp = s.get("homepage") or "N/A"
    cast = s.get("credits",{}).get("cast",[])[:5]
    cs = ", ".join(f'{c["name"]} as {c.get("character","?")}' for c in cast) or "N/A"
    cb = ", ".join(c.get("name","") for c in s.get("created_by",[])) or "N/A"
    print(f'\n📺  {t} ({fa[:4] if fa!="N/A" else "N/A"})')
    if tl: print(f'   "{tl}"')
    print(f"   ⭐ Rating: {r}/10 ({vc} votes) | Popularity: {pop}")
    print(f"   📅 First: {fa} | Last: {la}  |  📊 Status: {st}")
    print(f"   🔢 Seasons: {sn} | Episodes: {ep} | ⏱️ Ep Runtime: {rt}")
    print(f"   🌐 Language: {lg} | Spoken: {sp}")
    print(f"   🎭 Genres: {gs}")
    print(f"   ✍️ Created By: {cb}")
    print(f"   👥 Cast: {cs}")
    print(f"   📡 Networks: {nw} | 🏭 Production: {co}")
    if hp!="N/A": print(f"   🔗 Homepage: {hp}")
    print(f"   📖 Plot: {ov}")

def show_person_full(p):
    nm = p.get("name","?"); bd = p.get("birthday") or "N/A"
    dd = p.get("deathday"); pl = p.get("place_of_birth") or "N/A"
    bio = p.get("biography") or "No biography."; dept = p.get("known_for_department","N/A")
    pop = round(p.get("popularity",0),1); hp = p.get("homepage") or "N/A"
    gd = {0:"N/A",1:"Female",2:"Male",3:"Non-binary"}.get(p.get("gender",0),"N/A")
    sb = ". ".join(bio.split(". ")[:4])
    if len(bio.split(". "))>4: sb += "..."
    mc = sorted(p.get("movie_credits",{}).get("cast",[]), key=lambda x:x.get("popularity",0), reverse=True)[:5]
    ms = ", ".join(m.get("title","") for m in mc) or "N/A"
    tc = sorted(p.get("tv_credits",{}).get("cast",[]), key=lambda x:x.get("popularity",0), reverse=True)[:5]
    ts = ", ".join(t.get("name","") for t in tc) or "N/A"
    dc = [c for c in p.get("movie_credits",{}).get("crew",[]) if c.get("job")=="Director"]
    dc.sort(key=lambda x:x.get("popularity",0), reverse=True)
    ds = ", ".join(m.get("title","") for m in dc[:5]) or "N/A"
    print(f"\n🧑  {nm}")
    print(f"   🎂 Born: {bd} | 📍 {pl}")
    if dd: print(f"   🕊️  Died: {dd}")
    print(f"   👤 Gender: {gd} | Popularity: {pop}")
    print(f"   🎬 Known For: {dept}")
    print(f"   🎥 Top Movies: {ms}")
    print(f"   📺 Top TV Shows: {ts}")
    if dept=="Directing" or dc: print(f"   🎬 Directed: {ds}")
    if hp!="N/A": print(f"   🔗 {hp}")
    print(f"   📖 Bio: {sb}")

LAST_ITEMS = []  # module-level: last list of TMDB items shown (used to build image cards for the web UI)

def show_mlist(items):
    if not items: print("  No results found."); return
    LAST_ITEMS[:] = [dict(x, _kind="movie") for x in items]
    for i,m in enumerate(items,1):
        t=m.get("title","?"); d=(m.get("release_date") or "")[:4]
        r=round(m.get("vote_average",0),1); l=m.get("original_language","").upper()
        print(f"  {i}. {t} ({d}) — ⭐ {r}/10 [{l}]")

def show_tlist(items):
    if not items: print("  No results found."); return
    LAST_ITEMS[:] = [dict(x, _kind="tv") for x in items]
    for i,s in enumerate(items,1):
        t=s.get("name","?"); d=(s.get("first_air_date") or "")[:4]
        r=round(s.get("vote_average",0),1); l=s.get("original_language","").upper()
        print(f"  {i}. {t} ({d}) — ⭐ {r}/10 [{l}]")

def show_plist(items):
    if not items: print("  No results found."); return
    LAST_ITEMS[:] = [dict(x, _kind="person") for x in items]
    for i,p in enumerate(items,1):
        n=p.get("name","?"); d=p.get("known_for_department","")
        kf=", ".join(k.get("title") or k.get("name","") for k in p.get("known_for",[])[:3])
        print(f"  {i}. {n} ({d}) — {kf}")

def show_multi(items):
    if not items: print("  No results found."); return
    LAST_ITEMS[:] = [dict(x, _kind=x.get("media_type","multi")) for x in items[:5]]
    for i,x in enumerate(items[:5],1):
        mt=x.get("media_type","")
        if mt=="movie":
            print(f'  {i}. 🎬 {x.get("title","?")} ({(x.get("release_date") or "")[:4]}) — ⭐ {round(x.get("vote_average",0),1)}/10')
        elif mt=="tv":
            print(f'  {i}. 📺 {x.get("name","?")} ({(x.get("first_air_date") or "")[:4]}) — ⭐ {round(x.get("vote_average",0),1)}/10')
        elif mt=="person":
            print(f'  {i}. 🧑 {x.get("name","?")} ({x.get("known_for_department","")})')


# ══════════════════════════════════════════════════════════════════════════
# SUB-INFO DISPLAY (specific queries: rating, cast, director, etc.)
# ══════════════════════════════════════════════════════════════════════════

def _t(d): return d.get("title") or d.get("name","?")

def si_rating(d,dt):
    print(f'\n⭐ {_t(d)} — Rating: {round(d.get("vote_average",0),1)}/10 ({d.get("vote_count",0)} votes)')
def si_popularity(d,dt):
    print(f'\n📊 {_t(d)} — Popularity: {round(d.get("popularity",0),1)}')
def si_cast(d,dt):
    cl=d.get("credits",{}).get("cast",[])[:15]
    if not cl: print(f"\n  No cast info for {_t(d)}."); return
    print(f"\n👥 Cast of {_t(d)}:")
    for i,c in enumerate(cl,1): print(f'  {i}. {c["name"]} as {c.get("character","?")}')
def si_director(d,dt):
    crew=d.get("credits",{}).get("crew",[])
    dirs=[c["name"] for c in crew if c.get("job")=="Director"]
    if dt=="tv" and not dirs: dirs=[c.get("name","") for c in d.get("created_by",[])]
    print(f'\n🎬 {_t(d)} — Director: {", ".join(dirs) if dirs else "N/A"}')
def si_producer(d,dt):
    ps=[c["name"] for c in d.get("credits",{}).get("crew",[]) if "Producer" in c.get("job","")]
    print(f'\n🎬 {_t(d)} — Producers: {", ".join(ps[:5]) if ps else "N/A"}')
def si_writer(d,dt):
    ws=[f'{c["name"]} ({c.get("job","Writer")})' for c in d.get("credits",{}).get("crew",[]) if c.get("department")=="Writing"]
    print(f'\n✍️  {_t(d)} — Writers: {", ".join(ws[:5]) if ws else "N/A"}')
def si_music(d,dt):
    ms=[c["name"] for c in d.get("credits",{}).get("crew",[]) if c.get("job") in ("Original Music Composer","Music","Music Director")]
    print(f'\n🎵 {_t(d)} — Music: {", ".join(ms) if ms else "N/A"}')
def si_cinematographer(d,dt):
    cs=[c["name"] for c in d.get("credits",{}).get("crew",[]) if c.get("job") in ("Director of Photography","Cinematography")]
    print(f'\n📷 {_t(d)} — Cinematographer: {", ".join(cs) if cs else "N/A"}')
def si_editor(d,dt):
    es=[c["name"] for c in d.get("credits",{}).get("crew",[]) if c.get("job")=="Editor"]
    print(f'\n✂️  {_t(d)} — Editor: {", ".join(es) if es else "N/A"}')
def si_crew(d,dt):
    crew=d.get("credits",{}).get("crew",[])
    if not crew: print(f"\n  No crew info for {_t(d)}."); return
    depts={}
    for c in crew:
        dp=c.get("department","Other")
        depts.setdefault(dp,[]).append(f'{c["name"]} ({c.get("job","?")})')
    print(f"\n🎬 Crew of {_t(d)}:")
    for dp,ms in sorted(depts.items()):
        print(f"\n  [{dp}]")
        for m in ms[:5]: print(f"    • {m}")
def si_runtime(d,dt):
    if dt=="movie": print(f'\n⏱️  {_t(d)} — Runtime: {d.get("runtime") or "N/A"} minutes')
    else:
        ert=d.get("episode_run_time",[]); print(f'\n⏱️  {_t(d)} — Episode Runtime: {f"{ert[0]} min" if ert else "N/A"}')
def si_release(d,dt):
    if dt=="movie": print(f'\n📅 {_t(d)} — Release Date: {d.get("release_date") or "N/A"}')
    else: print(f'\n📅 {_t(d)} — First: {d.get("first_air_date") or "N/A"} | Last: {d.get("last_air_date") or "N/A"}')
def si_budget(d,dt):
    if dt!="movie": print("\n  Budget info is only for movies."); return
    b=d.get("budget",0); print(f'\n💰 {_t(d)} — Budget: {"${:,}".format(b) if b>0 else "N/A"}')
def si_revenue(d,dt):
    if dt!="movie": print("\n  Revenue info is only for movies."); return
    r=d.get("revenue",0); print(f'\n💵 {_t(d)} — Revenue: {"${:,}".format(r) if r>0 else "N/A"}')
def si_languages(d,dt):
    sp=", ".join(l.get("english_name",l.get("name","")) for l in d.get("spoken_languages",[])) or "N/A"
    print(f'\n🌐 {_t(d)} — Original: {d.get("original_language","").upper()} | Available: {sp}')
def si_genres(d,dt):
    print(f'\n🎭 {_t(d)} — Genres: {", ".join(g["name"] for g in d.get("genres",[])) or "N/A"}')
def si_adult(d,dt):
    print(f'\n🔞 {_t(d)} — Adult: {"Yes" if d.get("adult") else "No"}')
def si_homepage(d,dt):
    print(f'\n🔗 {_t(d)} — Homepage: {d.get("homepage") or "N/A"}')
def si_overview(d,dt):
    print(f'\n📖 {_t(d)} — Plot:\n   {d.get("overview") or "No overview available."}')
def si_imdb(d,dt):
    ext=d.get("external_ids",{}); iid=ext.get("imdb_id") or d.get("imdb_id") or "N/A"
    print(f'\n🆔 {_t(d)} — IMDb: {iid}')
    if iid!="N/A": print(f"   🔗 https://www.imdb.com/title/{iid}/")
def si_extids(d,dt):
    ext=d.get("external_ids",{})
    if not ext: print(f"\n  No external IDs for {_t(d)}."); return
    print(f"\n🆔 External IDs for {_t(d)}:")
    for k,v in ext.items():
        if v and k!="id": print(f"   • {k}: {v}")
def si_keywords(d,dt):
    kd=d.get("keywords",{}); kws=kd.get("keywords") or kd.get("results",[])
    if not kws: print(f"\n  No keywords for {_t(d)}."); return
    print(f'\n🏷️  Keywords: {", ".join(k["name"] for k in kws[:15])}')
def si_poster(d,dt):
    pp=d.get("poster_path")
    if pp: print(f"\n🖼️  {_t(d)} — Poster:\n   {IMG}{pp}")
    else: print(f"\n  No poster for {_t(d)}.")
def si_backdrop(d,dt):
    bp=d.get("backdrop_path")
    if bp: print(f"\n🌅 {_t(d)} — Backdrop:\n   {IMG}{bp}")
    else: print(f"\n  No backdrop for {_t(d)}.")
def si_images(d,dt):
    imgs=d.get("images",{}); ps=imgs.get("posters",[])[:3]; bs=imgs.get("backdrops",[])[:3]; ls=imgs.get("logos",[])[:2]
    print(f"\n🖼️  Images for {_t(d)}:")
    if ps:
        print("  📌 Posters:")
        for i in ps: print(f"     {IMG}{i['file_path']}")
    if bs:
        print("  🌅 Backdrops:")
        for i in bs: print(f"     {IMG}{i['file_path']}")
    if ls:
        print("  🏷️ Logos:")
        for i in ls: print(f"     {IMG}{i['file_path']}")
    if not ps and not bs and not ls: print("  No images available.")
def si_trailer(d,dt):
    vs=d.get("videos",{}).get("results",[]); tr=None
    for v in vs:
        if v.get("type")=="Trailer" and v.get("official"): tr=v; break
    if not tr:
        for v in vs:
            if v.get("type")=="Trailer": tr=v; break
    if not tr:
        for v in vs:
            if v.get("type")=="Teaser": tr=v; break
    if not tr and vs: tr=vs[0]
    if tr:
        url=f'https://www.youtube.com/watch?v={tr["key"]}' if tr.get("site")=="YouTube" else tr.get("key","")
        print(f'\n🎬 {_t(d)} — {tr.get("name","Trailer")}:\n   {url}')
    else: print(f"\n  No trailer for {_t(d)}.")
def si_videos(d,dt):
    vs=d.get("videos",{}).get("results",[])
    if not vs: print(f"\n  No videos for {_t(d)}."); return
    print(f"\n🎬 Videos for {_t(d)}:")
    for v in vs[:8]:
        url=f'https://www.youtube.com/watch?v={v["key"]}' if v.get("site")=="YouTube" else v.get("key","")
        print(f'  🎥 [{v.get("type","Video")}] {v.get("name","")}\n     {url}')
def si_watch(d,dt):
    wp=d.get("watch/providers",{}).get("results",{})
    regions=[]
    if "IN" in wp: regions.append(("India 🇮🇳",wp["IN"]))
    if "US" in wp: regions.append(("USA 🇺🇸",wp["US"]))
    if not regions:
        for c,pd in list(wp.items())[:2]: regions.append((c,pd))
    if not regions: print(f"\n  No streaming info for {_t(d)}."); return
    print(f"\n📺 Where to watch {_t(d)}:")
    for rn,pd in regions:
        print(f"\n  [{rn}]")
        if pd.get("flatrate"): print(f'    🔄 Stream: {", ".join(p["provider_name"] for p in pd["flatrate"])}')
        if pd.get("rent"): print(f'    💳 Rent: {", ".join(p["provider_name"] for p in pd["rent"])}')
        if pd.get("buy"): print(f'    🛒 Buy: {", ".join(p["provider_name"] for p in pd["buy"])}')
        if pd.get("link"): print(f"    🔗 {pd['link']}")
def si_recs(d,dt):
    recs=d.get("recommendations",{}).get("results",[])[:8]
    if not recs: print(f"\n  No recommendations for {_t(d)}."); return
    print(f"\n🎯 Recommended based on {_t(d)}:")
    (show_mlist if dt=="movie" else show_tlist)(recs)
def si_seasons(d,dt):
    if dt!="tv": print("\n  Season info is only for TV shows."); return
    sl=d.get("seasons",[])
    print(f'\n🔢 {_t(d)} — {d.get("number_of_seasons","?")} Season(s):')
    for s in sl:
        sname = s.get("name") or f"Season {s.get('season_number', '?')}"
        print(f'   • {sname}: {s.get("episode_count","?")} eps (aired {s.get("air_date") or "TBA"})')
def si_episodes(d,dt):
    if dt!="tv": print("\n  Episode info is only for TV shows."); return
    print(f'\n🔢 {_t(d)} — {d.get("number_of_episodes","?")} Episode(s) across {d.get("number_of_seasons","?")} Season(s)')
def si_status(d,dt):
    print(f'\n📊 {_t(d)} — Status: {d.get("status","N/A")}')
def si_prodco(d,dt):
    cs=d.get("production_companies",[])
    if not cs: print(f"\n  No production company info for {_t(d)}."); return
    print(f"\n🏭 Production Companies for {_t(d)}:")
    for c in cs: print(f'   • {c["name"]} [{c.get("origin_country","?")}]')
def si_person_movies(p):
    mc=sorted(p.get("movie_credits",{}).get("cast",[]), key=lambda x:x.get("popularity",0), reverse=True)
    if not mc: print(f'\n  No movie credits for {p.get("name","?")}.'); return
    print(f'\n🎥 Movies of {p.get("name","?")} (top {min(len(mc),15)}):')
    for i,m in enumerate(mc[:15],1): print(f'  {i}. {m.get("title","?")} ({(m.get("release_date") or "")[:4]}) as {m.get("character","?")}')
def si_person_tv(p):
    tc=sorted(p.get("tv_credits",{}).get("cast",[]), key=lambda x:x.get("popularity",0), reverse=True)
    if not tc: print(f'\n  No TV credits for {p.get("name","?")}.'); return
    print(f'\n📺 TV Shows of {p.get("name","?")} (top {min(len(tc),15)}):')
    for i,s in enumerate(tc[:15],1): print(f'  {i}. {s.get("name","?")} ({(s.get("first_air_date") or "")[:4]}) as {s.get("character","?")}')
def si_person_imgs(p):
    imgs=p.get("images",{}).get("profiles",[])[:3]; pp=p.get("profile_path")
    print(f'\n🖼️  Images of {p.get("name","?")}:')
    if pp: print(f"   📷 Profile: {IMG}{pp}")
    for i in imgs: print(f"   📷 {IMG}{i['file_path']}")
    if not pp and not imgs: print("   No images available.")

# Sub-intent dispatch table
SI_MAP = {
    "rating":si_rating,"popularity":si_popularity,"cast":si_cast,
    "director":si_director,"producer":si_producer,"writer":si_writer,
    "music":si_music,"cinematographer":si_cinematographer,"editor":si_editor,
    "crew":si_crew,"runtime":si_runtime,"release_date":si_release,
    "budget":si_budget,"revenue":si_revenue,"languages":si_languages,
    "genres":si_genres,"adult":si_adult,"homepage":si_homepage,
    "overview":si_overview,"imdb_id":si_imdb,"external_ids":si_extids,
    "keywords":si_keywords,"poster":si_poster,"backdrop":si_backdrop,
    "images":si_images,"trailer":si_trailer,"videos":si_videos,
    "watch_providers":si_watch,"recommendations":si_recs,
    "seasons":si_seasons,"episodes":si_episodes,"status":si_status,
    "production_companies":si_prodco,
}

def dispatch_sub(data, dtype, sub):
    if dtype == "person":
        if sub in ("movies","filmography"): si_person_movies(data)
        elif sub == "tv_shows": si_person_tv(data)
        elif sub in ("poster","images"): si_person_imgs(data)
        elif sub == "external_ids": si_extids(data, dtype)
        else: show_person_full(data)
        return
    if sub == "full":
        (show_movie_full if dtype=="movie" else show_tv_full)(data)
    elif sub in SI_MAP:
        SI_MAP[sub](data, dtype)
    else:
        (show_movie_full if dtype=="movie" else show_tv_full)(data)


# ══════════════════════════════════════════════════════════════════════════
# COMPARISON
# ══════════════════════════════════════════════════════════════════════════

def do_compare(text):
    m = re.search(r'compare\s+(.+?)\s+(?:and|vs|with|&)\s+(.+)', text, re.I)
    if not m: print("\n  Use: compare Movie1 and Movie2"); return
    n1, n2 = m.group(1).strip(), m.group(2).strip()
    d1=d2=None; t1=t2="movie"
    r1=search_movie(n1)
    if r1: d1=movie_detail(r1[0]["id"])
    else:
        r1=search_tv(n1)
        if r1: d1=tv_detail(r1[0]["id"]); t1="tv"
    r2=search_movie(n2)
    if r2: d2=movie_detail(r2[0]["id"])
    else:
        r2=search_tv(n2)
        if r2: d2=tv_detail(r2[0]["id"]); t2="tv"
    if not d1: print(f"\n  Couldn't find '{n1}'."); return
    if not d2: print(f"\n  Couldn't find '{n2}'."); return
    a=_t(d1); b=_t(d2); w=max(len(a),len(b),20)
    ra=round(d1.get("vote_average",0),1); rb=round(d2.get("vote_average",0),1)
    va=d1.get("vote_count",0); vb=d2.get("vote_count",0)
    pa=round(d1.get("popularity",0),1); pb=round(d2.get("popularity",0),1)
    da=d1.get("release_date") or d1.get("first_air_date") or "N/A"
    db=d2.get("release_date") or d2.get("first_air_date") or "N/A"
    ga=", ".join(g["name"] for g in d1.get("genres",[])); gb=", ".join(g["name"] for g in d2.get("genres",[]))
    la=d1.get("original_language","?").upper(); lb=d2.get("original_language","?").upper()
    rta=str(d1.get("runtime") or "N/A"); rtb=str(d2.get("runtime") or "N/A")
    print(f"\n{'='*60}\n  ⚔️  COMPARISON\n{'='*60}")
    print(f"  {'Attribute':<18} {a:<{w}} {b:<{w}}")
    print(f"  {'-'*18} {'-'*w} {'-'*w}")
    print(f"  {'Rating':<18} {'⭐ '+str(ra)+'/10':<{w}} {'⭐ '+str(rb)+'/10':<{w}}")
    print(f"  {'Votes':<18} {str(va):<{w}} {str(vb):<{w}}")
    print(f"  {'Popularity':<18} {str(pa):<{w}} {str(pb):<{w}}")
    print(f"  {'Release':<18} {da:<{w}} {db:<{w}}")
    print(f"  {'Runtime':<18} {rta+' min':<{w}} {rtb+' min':<{w}}")
    print(f"  {'Language':<18} {la:<{w}} {lb:<{w}}")
    print(f"  {'Genres':<18} {ga:<{w}} {gb:<{w}}")
    if t1=="movie" and t2=="movie":
        ba=d1.get("budget",0); bb=d2.get("budget",0)
        ea=d1.get("revenue",0); eb=d2.get("revenue",0)
        print(f"  {'Budget':<18} {'${:,}'.format(ba) if ba else 'N/A':<{w}} {'${:,}'.format(bb) if bb else 'N/A':<{w}}")
        print(f"  {'Revenue':<18} {'${:,}'.format(ea) if ea else 'N/A':<{w}} {'${:,}'.format(eb) if eb else 'N/A':<{w}}")
    print(f"{'='*60}")
    if ra>rb: print(f"  🏆 {a} has a higher rating!")
    elif rb>ra: print(f"  🏆 {b} has a higher rating!")
    else: print("  🤝 Both have the same rating!")


# ══════════════════════════════════════════════════════════════════════════
# INTENT DETECTION
# ══════════════════════════════════════════════════════════════════════════

FOLLOWUP_RE = re.compile(r'\b(it|its|this|that|the movie|the film|the show|the series|this movie|this film|this show|this series|that movie|that show)\b', re.I)

SHORTQ = ["rating","cast","director","producer","writer","music","composer",
    "trailer","poster","images","plot","overview","summary","budget","revenue",
    "box office","runtime","duration","release date","languages","genres","adult",
    "homepage","imdb","keywords","watch","stream","ott","recommendations","similar",
    "seasons","episodes","status","crew","videos","backdrop","cinematograph",
    "editor","production company","who directed","who produced","who wrote","who composed"]

def is_followup(t):
    if FOLLOWUP_RE.search(t): return True
    for kw in SHORTQ:
        if t.startswith(kw) or t==kw: return True
    if re.match(r"^(show|what'?s?|get|display)\s+(the\s+)?(rating|cast|crew|trailer|poster|plot|budget|revenue|status)", t):
        return True
    return False

def detect_sub(t):
    checks = [
        (["imdb rating"],"rating"),
        (["imdb id","imdb"],"imdb_id"), (["external id"],"external_ids"),
        (["keyword"],"keywords"),
        (["box office","collection of","revenue","earning","gross"],"revenue"),
        (["budget","cost"],"budget"),
        (["cinematograph"],"cinematographer"), (["editor","edited","who edited"],"editor"),
        (["composer","composed","music","soundtrack","who composed"],"music"),
        (["screenplay","writer","written","who wrote","wrote"],"writer"),
        (["producer","produced","who produced"],"producer"),
        (["director","directed","who directed"],"director"),
        (["crew"],"crew"),
        (["cast","who acted","who starred","who played","acted in","character"],"cast"),
        (["rating","rated","rate","score"],"rating"),
        (["popularity score","popularity"],"popularity"),
        (["runtime","duration","how long","length"],"runtime"),
        (["release","when was","when did"],"release_date"),
        (["language","available in","dubbed"],"languages"),
        (["genre","type of movie","category"],"genres"),
        (["adult","age rating","18+","for adults"],"adult"),
        (["homepage","website","official page"],"homepage"),
        (["overview","plot","story","storyline","summary","synopsis"],"overview"),
        (["where can i watch","watch","stream","ott","netflix","amazon prime","disney+","platform","available on","can i rent","can i buy"],"watch_providers"),
        (["recommend","suggest","similar"],"recommendations"),
        (["trailer","official trailer"],"trailer"),
        (["teaser","clip","featurette","behind the scene","behind-the-scene","video"],"videos"),
        (["backdrop"],"backdrop"), (["logo"],"images"),
        (["poster","image","photo","picture"],"poster"),
        (["how many season","season"],"seasons"), (["how many episode","episode"],"episodes"),
        (["status","finished","ended","is it over","completed","cancelled"],"status"),
        (["production company","produced by","which company"],"production_companies"),
    ]
    for kws, sub in checks:
        if any(w in t for w in kws): return sub
    return "full"

FILLERS = {"what","is","the","of","tell","me","about","show","give","find","search","for","please",
    "can","you","who","when","where","how","does","did","was","are","were","a","an","some","any",
    "my","i","want","to","know","get","information","info","details","detail","explain","everything","all","full","do"}
INTENT_W = {"movie","film","series","show","tv","web","actor","actress","director","cast","rating",
    "release","date","genre","plot","overview","summary","storyline","runtime","budget","revenue","box",
    "office","language","watch","stream","ott","trailer","poster","image","backdrop","video","teaser",
    "clip","keyword","imdb","external","id","crew","producer","writer","music","composer",
    "cinematographer","editor","recommend","suggest","similar","season","episode","status","adult",
    "homepage","website","production","company","profile","biography","bio","birthday","born",
    "filmography","movies","films","shows","played","acted","starred","available","on","platform",
    "popularity","score","official","main","best","latest","trending","tranding","popular","upcoming",
    "highest","most","voted","top","rated","currently","airing"}
INTENT_W.update(w.lower() for w in MOVIE_GENRES.keys())
INTENT_W.update(w.lower() for w in TV_GENRES.keys())
INTENT_W.update(w.lower() for w in LANG_MAP.keys())
INTENT_W.update(w.lower() for w in COUNTRY_MAP.keys())
INTENT_W.update({"drama", "dramas", "show", "shows", "film", "films", "series", "movies"})

def extract_name(text):
    cleaned = re.sub(r'[?!.,;:\'"]+', '', text)
    words = cleaned.split()
    result = [w for w in words if w.lower() not in FILLERS and w.lower() not in INTENT_W]
    name = " ".join(result).strip()
    if not name:
        result = [w for w in words if w.lower() not in FILLERS]
        name = " ".join(result).strip()
    return name

def has_title(text):
    n = extract_name(text)
    if not n or len(n)<2: return False
    if n.lower() in MOVIE_GENRES or n.lower() in LANG_MAP or n.lower() in COUNTRY_MAP: return False
    return True

def match_genre(t):
    for gn,gi in MOVIE_GENRES.items():
        if re.search(r'\b'+re.escape(gn)+r'\b', t): return (gn,gi)
    return None

def match_lang(t):
    for ln,lc in LANG_MAP.items():
        if re.search(r'\b'+re.escape(ln)+r'\b', t): return (ln,lc)
    return None

def match_country(t):
    for cn,cc in COUNTRY_MAP.items():
        if re.search(r'\b'+re.escape(cn)+r'\b', t): return (cn,cc)
    return None

def match_company(t):
    for cn,ci in COMPANY_MAP.items():
        if cn in t: return (cn,ci)
    return None

def is_ent_related(t):
    words = set(t.lower().split())
    if words & ENT_KW: return True
    for kw in ["web series","box office","top rated","now playing","south indian"]:
        if kw in t.lower(): return True
    return False


# ══════════════════════════════════════════════════════════════════════════
# HANDLER FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════

def handle_selected(sel, ctype):
    if ctype in ("movie","multi") and sel.get("media_type","movie")!="tv" and sel.get("media_type","movie")!="person":
        d = movie_detail(sel["id"])
        if d: set_ctx(d,"movie"); show_movie_full(d)
    elif ctype=="tv" or sel.get("media_type")=="tv":
        d = tv_detail(sel["id"])
        if d: set_ctx(d,"tv"); show_tv_full(d)
    elif ctype=="person" or sel.get("media_type")=="person":
        d = person_detail(sel["id"])
        if d: set_ctx(d,"person"); show_person_full(d)
    else: print("\nSorry, I couldn't find information about that.")

def handle_entity(name, sub):
    results = search_multi(name)
    if not results:
        print(f"\nSorry, I couldn't find information about '{name}'.")
        return
    # Prefer TV for TV-related sub-intents
    if sub in ("seasons","episodes","status"):
        tv_r = [r for r in results if r.get("media_type")=="tv"]
        if tv_r: results = tv_r
    top = results[0]; mtype = top.get("media_type","movie")
    # Ambiguous: show choices for generic queries
    same = [r for r in results if r.get("media_type")==mtype]
    if len(same)>1 and sub=="full":
        print(f"\n  I found multiple matches for '{name}':")
        choices = same[:5]
        for i,x in enumerate(choices,1):
            if mtype=="movie": print(f'  {i}. 🎬 {x.get("title","?")} ({(x.get("release_date") or "")[:4]})')
            elif mtype=="tv": print(f'  {i}. 📺 {x.get("name","?")} ({(x.get("first_air_date") or "")[:4]})')
            elif mtype=="person": print(f'  {i}. 🧑 {x.get("name","?")} ({x.get("known_for_department","")})')
        print("\n  Enter a number to select, or ask a new question.")
        ctx["choices"]=choices; ctx["ctype"]=mtype
        return
    # Get details
    if mtype=="movie":
        d=movie_detail(top["id"])
        if d: set_ctx(d,"movie"); dispatch_sub(d,"movie",sub)
        else: print(f"\nSorry, I couldn't find information about '{name}'.")
    elif mtype=="tv":
        d=tv_detail(top["id"])
        if d: set_ctx(d,"tv"); dispatch_sub(d,"tv",sub)
        else: print(f"\nSorry, I couldn't find information about '{name}'.")
    elif mtype=="person":
        d=person_detail(top["id"])
        if d: set_ctx(d,"person"); dispatch_sub(d,"person",sub)
        else: print(f"\nSorry, I couldn't find information about '{name}'.")

def handle_trending(t):
    for kw,lc in LANG_MAP.items():
        if kw in t:
            if any(w in t for w in ["series","show","tv","web"]):
                print(f"\n🔥 Popular {kw.title()} TV Shows:"); show_tlist(disc_tv(with_original_language=lc))
            else:
                print(f"\n🔥 Popular {kw.title()} Movies:"); show_mlist(disc_movie(with_original_language=lc))
            return
    if "south" in t and "indian" in t: handle_south(t); return
    tw = "day" if "today" in t else "week"
    if any(w in t for w in ["celeb","people","person","actor","actress"]):
        print(f"\n🔥 Trending Celebrities:"); show_plist(trending("person",tw)); return
    if any(w in t for w in ["series","show","tv","web"]):
        print(f"\n🔥 Trending TV Shows:"); show_tlist(trending("tv",tw)); return
    if any(w in t for w in ["movie","film"]):
        print(f"\n🔥 Trending Movies:"); show_mlist(trending("movie",tw)); return
    print(f"\n🔥 Trending This {'Day' if tw=='day' else 'Week'}:")
    print("\n  🎬 Movies:"); show_mlist(trending("movie",tw)[:5])
    print("\n  📺 TV Shows:"); show_tlist(trending("tv",tw)[:5])

def handle_lists(t):
    if any(w in t for w in ["now playing","in theater","in cinema"]):
        print("\n🎬 Now Playing:"); show_mlist(now_playing()); return True
    if any(w in t for w in ["upcoming","coming soon"]):
        print("\n🎬 Upcoming Movies:"); show_mlist(upcoming_movies()); return True
    if "airing today" in t:
        print("\n📺 Airing Today:"); show_tlist(airing_today()); return True
    if any(w in t for w in ["currently airing","on the air","on air"]):
        print("\n📺 Currently Airing:"); show_tlist(on_the_air()); return True
    if any(w in t for w in ["top rated","top-rated","highest rated","highest-rated","best rated"]):
        if any(w in t for w in ["series","show","tv","web"]):
            print("\n📺 Top Rated TV Shows:"); show_tlist(top_rated_tv())
        else:
            print("\n🎬 Top Rated Movies:"); show_mlist(top_rated_movies())
        return True
    if re.search(r'\b(popular|most popular)\b',t) and "popularity" not in t:
        if any(w in t for w in ["series","show","tv","web"]):
            print("\n📺 Popular TV Shows:"); show_tlist(popular_tv())
        else:
            print("\n🎬 Popular Movies:"); show_mlist(popular_movies())
        return True
    if re.search(r'\blatest\b',t) and not match_lang(t):
        if any(w in t for w in ["series","show","tv","web"]):
            print("\n📺 Latest TV Shows:"); show_tlist(on_the_air())
        else:
            print("\n🎬 Latest Movies:"); show_mlist(now_playing())
        return True
    if "most voted" in t:
        if any(w in t for w in ["series","show","tv"]):
            print("\n📺 Most Voted TV Shows:"); show_tlist(top_rated_tv())
        else:
            print("\n🎬 Most Voted Movies:"); show_mlist(top_rated_movies())
        return True
    if "best" in t and any(w in t for w in ["series","show","web","drama","dramas"]) and not match_genre(t):
        print("\n📺 Best TV Shows:"); show_tlist(top_rated_tv()); return True
    if "best" in t and any(w in t for w in ["movie","film"]) and not match_genre(t) and not match_lang(t):
        print("\n🎬 Best Movies:"); show_mlist(top_rated_movies()); return True
    return False

def handle_year(t, year):
    if any(w in t for w in ["series","show","tv","web"]):
        print(f"\n📺 TV Shows from {year}:"); show_tlist(disc_tv(first_air_date_year=year))
    else:
        print(f"\n🎬 Movies from {year}:"); show_mlist(disc_movie(primary_release_year=year))

def handle_decade(t, decade):
    print(f"\n🎬 Movies from the {decade}s:")
    show_mlist(disc_movie(**{"primary_release_date.gte":f"{decade}-01-01",
        "primary_release_date.lte":f"{decade+9}-12-31","sort_by":"vote_average.desc","vote_count.gte":"100"}))

def handle_genre(t, gm):
    gn, gi = gm
    if any(w in t for w in ["series","show","tv","web"]):
        ti = TV_GENRES.get(gn, gi)
        print(f"\n📺 Best {gn.title()} TV Shows:"); show_tlist(disc_tv(with_genres=ti))
    else:
        print(f"\n🎬 Best {gn.title()} Movies:"); show_mlist(disc_movie(with_genres=gi))

def handle_lang(t, lm):
    ln, lc = lm
    if any(w in t for w in ["series","show","tv","web","drama","dramas"]):
        print(f"\n📺 Popular {ln.title()} TV Shows:"); show_tlist(disc_tv(with_original_language=lc))
    else:
        print(f"\n🎬 Popular {ln.title()} Movies:"); show_mlist(disc_movie(with_original_language=lc))

def handle_south(t):
    print("\n🎬 Popular South Indian Movies:")
    all_m = []
    for lc in ["ta","te","kn","ml"]: all_m.extend(disc_movie(with_original_language=lc)[:3])
    all_m.sort(key=lambda x:x.get("popularity",0), reverse=True)
    show_mlist(all_m[:10])

def handle_country(t, cm):
    cn, cc = cm
    if any(w in t for w in ["series","show","tv","web"]):
        print(f"\n📺 Popular {cn.title()} TV Shows:"); show_tlist(disc_tv(with_origin_country=cc))
    else:
        print(f"\n🎬 Popular {cn.title()} Movies:"); show_mlist(disc_movie(with_origin_country=cc))

def handle_company(cm):
    cn, ci = cm
    print(f"\n🏭 Movies by {cn.title()}:"); show_mlist(disc_movie(with_companies=ci))

def handle_collection(t):
    name = extract_name(t)
    if not name: name = re.sub(r'\b(show|all|movie|movies|collection|list)\b','',t,flags=re.I).strip()
    if not name: print("\n  Specify a collection name."); return
    rs = search_collection(name)
    if not rs:
        mr = search_movie(name)
        if mr:
            md = movie_detail(mr[0]["id"])
            if md and md.get("belongs_to_collection"):
                cd = collection_detail(md["belongs_to_collection"]["id"])
                if cd:
                    pts = sorted(cd.get("parts",[]), key=lambda x:x.get("release_date",""))
                    print(f'\n🎬 {cd.get("name","Collection")}:'); show_mlist(pts); return
        print(f"\nSorry, couldn't find collection for '{name}'."); return
    cd = collection_detail(rs[0]["id"])
    if cd:
        pts = sorted(cd.get("parts",[]), key=lambda x:x.get("release_date",""))
        print(f'\n🎬 {cd.get("name","Collection")}:'); show_mlist(pts)
    else: print("\nSorry, couldn't find that collection.")

def handle_recommend(t, orig):
    gm = match_genre(t)
    name = extract_name(orig)
    if gm and not name: handle_genre(t, gm); return
    if not name:
        if ctx["data"]: si_recs(ctx["data"], ctx["type"])
        else: print("\n  Specify a title. Example: 'recommend movies like Inception'")
        return
    if any(w in t for w in ["series","show","tv","web"]):
        rs = search_tv(name)
        if rs:
            d = tv_detail(rs[0]["id"])
            if d: set_ctx(d,"tv"); si_recs(d,"tv"); return
    rs = search_movie(name)
    if rs:
        d = movie_detail(rs[0]["id"])
        if d: set_ctx(d,"movie"); si_recs(d,"movie"); return
    print(f"\nSorry, couldn't find '{name}' for recommendations.")

def handle_person(name, t):
    rs = search_person(name)
    if not rs: print(f"\nSorry, couldn't find '{name}'."); return
    d = person_detail(rs[0]["id"])
    if not d: print(f"\nSorry, couldn't find '{name}'."); return
    set_ctx(d, "person")
    if any(w in t for w in ["movie","film","filmography"]): si_person_movies(d)
    elif any(w in t for w in ["tv","show","series"]): si_person_tv(d)
    elif any(w in t for w in ["birthday","born","birth"]):
        print(f'\n🎂 {d.get("name","?")} — Born: {d.get("birthday") or "N/A"} | Place: {d.get("place_of_birth") or "N/A"}')
    elif any(w in t for w in ["image","photo","picture","profile"]): si_person_imgs(d)
    else: show_person_full(d)

def handle_search(orig):
    q = re.sub(r'^(search|find)\s+','', orig, flags=re.I).strip()
    if not q: print("\n  Specify what to search."); return
    rs = search_multi(q)
    if not rs: print(f"\nSorry, couldn't find anything for '{q}'."); return
    print(f"\n🔍 Results for '{q}':"); choices = rs[:5]
    show_multi(choices)
    print("\n  Enter a number to see details, or ask a new question.")
    ctx["choices"]=choices; ctx["ctype"]="multi"


# ══════════════════════════════════════════════════════════════════════════
# MAIN QUERY PROCESSOR
# ══════════════════════════════════════════════════════════════════════════

def process(user_input):
    text = user_input.lower().strip()
    orig = user_input.strip()

    # ── Selection from pending choices ─────────────────────────
    if ctx.get("choices") and text.isdigit():
        idx = int(text)-1; choices = ctx["choices"]; ctype = ctx["ctype"] or "multi"
        if 0 <= idx < len(choices):
            ctx["choices"]=None; ctx["ctype"]=None
            handle_selected(choices[idx], ctype)
        else: print(f"\n  Enter 1-{len(choices)}.")
        return
    ctx["choices"]=None; ctx["ctype"]=None

    # ── Comparison ─────────────────────────────────────────────
    if re.search(r'\bcompare\b', text): do_compare(text); return

    # ── Follow-up ──────────────────────────────────────────────
    if is_followup(text) and ctx["data"]:
        sub = detect_sub(text)
        dispatch_sub(ctx["data"], ctx["type"], sub)
        return

    # Clear old context for completely new queries
    ctx["data"] = None
    ctx["type"] = None
    ctx["id"] = None
    ctx["title"] = None

    # ── Search / Find ──────────────────────────────────────────
    if re.match(r'^(search|find)\s+', text): handle_search(orig); return

    # ── Trending ───────────────────────────────────────────────
    if re.search(r'\b(trending|tranding)\b', text) or re.search(r"what'?s?\s+tr(e|a)nding", text):
        handle_trending(text); return

    # ── List queries (popular, top rated, etc.) ────────────────
    if handle_lists(text): return

    # ── Year / Decade ──────────────────────────────────────────
    ym = re.search(r'\b(1[89]\d{2}|20[0-2]\d|203\d)\b', text)
    dm = re.search(r'\b(1[89]\d0)s\b', text)
    if ym and any(w in text for w in ["movie","film","released","best","top"]): handle_year(text, ym.group(1)); return
    if dm and any(w in text for w in ["movie","film","from","best","top"]): handle_decade(text, int(dm.group(1))); return

    # ── Language/industry based (before genre to handle "best bollywood") ─
    lm = match_lang(text)
    if lm and any(w in text for w in ["movie","film","series","show","tv","web","drama","dramas"]) and not has_title(text):
        handle_lang(text, lm); return

    # ── Country based ──────────────────────────────────────────
    cm = match_country(text)
    if cm and any(w in text for w in ["movie","film","series","show","tv","web","drama","dramas"]) and not has_title(text):
        handle_country(text, cm); return

    # ── South Indian ───────────────────────────────────────────
    if "south indian" in text or ("south" in text and "indian" in text):
        if any(w in text for w in ["movie","film"]): handle_south(text); return

    # ── Genre discovery ────────────────────────────────────────
    gm = match_genre(text)
    if gm and not has_title(text): handle_genre(text, gm); return

    # ── Collection ─────────────────────────────────────────────
    if re.search(r'\bcollection\b', text) or re.search(r'\ball\s+\w+\s+movies\b', text):
        handle_collection(text); return

    # ── Production company ─────────────────────────────────────
    cpm = match_company(text)
    if cpm and any(w in text for w in ["movie","film","movies","films","by","produced"]): handle_company(cpm); return

    # ── Recommendations ────────────────────────────────────────
    if any(w in text for w in ["recommend","suggest","similar"]): handle_recommend(text, orig); return

    # ── "movies of X" / "tv shows of X" ───────────────────────
    mo = re.search(r'(?:movies?|films?)\s+(?:of|by|starring|with)\s+(.+)', text)
    if mo:
        handle_person(mo.group(1).strip(), "movies"); return
    to = re.search(r'(?:tv\s+shows?|series|shows?)\s+(?:of|by|starring|with)\s+(.+)', text)
    if to:
        handle_person(to.group(1).strip(), "tv shows"); return

    # ── Person queries ─────────────────────────────────────────
    if any(w in text for w in ["actor","actress","biography","bio","birthday","born","birthplace","filmography","who is"]):
        name = extract_name(orig)
        if name: handle_person(name, text)
        else: print("\n  Please specify a person's name.")
        return

    # ── "Is X on Netflix?" style ───────────────────────────────
    ism = re.search(r'is\s+(.+?)\s+(?:on|available on)\s+\w+', text)
    if ism:
        handle_entity(ism.group(1).strip(), "watch_providers"); return

    # ── Specific sub-intent with title ─────────────────────────
    sub = detect_sub(text)
    name = extract_name(orig)

    if name:
        if not is_ent_related(text):
            # Not clearly entertainment — try TMDB anyway
            rs = search_multi(name)
            if not rs:
                print("\nSorry, I can only answer entertainment-related questions.")
                return
        handle_entity(name, sub)
        return

    # ── Fallback ───────────────────────────────────────────────
    if not is_ent_related(text):
        print("\nSorry, I can only answer entertainment-related questions.")
    else:
        print("\nSorry, I couldn't understand your question. Try naming a movie, TV show, or person.")


# ══════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("  🎬  Entertainment Chatbot (Powered by TMDB)  🎬")
    print("=" * 60)
    print("\nAsk about movies, TV shows, actors, directors, ratings,")
    print("cast, crew, trailers, streaming, trending, and more!")
    print("I remember context — ask follow-ups like 'who directed it?'")
    print("Type 'exit' to quit.\n")

    while True:
        try:
            ui = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n\nGoodbye! 🎬"); break
        if not ui: continue
        if ui.lower() in ("exit","quit","bye","q"): print("\nGoodbye! 🎬"); break
        try:
            process(ui)
        except Exception as e:
            print(f"\n⚠️  Something went wrong: {e}")
        print()

if __name__ == "__main__":
    main()


# ══════════════════════════════════════════════════════════════════════════
# WEB BACKEND LAYER (used by app.py's /api/entertainment/* routes)
#
# Everything above this line is the original TMDB console engine, left
# intact. Everything below adapts it into a ChatGPT-style multi-chat web
# backend: persisted chats/messages (SQLite, mirrors askanything.py's
# storage pattern) + a formatter that turns the console engine's printed
# output into markdown text plus a list of premium image "cards" (posters,
# backdrops, profile photos) that the frontend renders.
# ══════════════════════════════════════════════════════════════════════════

import io
import json
import time as _time
import uuid
import sqlite3
import contextlib

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "db_storage", "entertainment_data.db")
DEFAULT_TITLE = "New Entertainment Chat"

# Per-chat conversation context, so follow-ups ("who directed it?") work
# correctly even when several chats exist. The console engine's functions
# all read/write the module-level `ctx` / `LAST_ITEMS` names, so we simply
# swap those names to the right chat's saved state before each call.
_SESSIONS = {}

def _fresh_ctx():
    return {"id": None, "title": None, "type": None, "data": None, "choices": None, "ctype": None}

def _session(chat_id):
    if chat_id not in _SESSIONS:
        _SESSIONS[chat_id] = {"ctx": _fresh_ctx(), "items": []}
    return _SESSIONS[chat_id]


# ── Database ──────────────────────────────────────────────────────────────

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
            cards TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL
        )
    """)
    conn.commit()
    conn.close()

def _chat_to_dict(row):
    return {
        "id": row["id"], "title": row["title"],
        "pinned": bool(row["pinned"]), "archived": bool(row["archived"]),
        "created_at": row["created_at"], "updated_at": row["updated_at"],
    }

def _msg_to_dict(row):
    try:
        cards = json.loads(row["cards"] or "[]")
    except Exception:
        cards = []
    return {
        "id": row["id"], "role": row["role"], "content": row["content"],
        "cards": cards, "created_at": row["created_at"],
    }

def create_chat(title=None):
    chat_id = uuid.uuid4().hex
    now = int(_time.time())
    conn = get_conn()
    conn.execute(
        "INSERT INTO chats (id,title,pinned,archived,created_at,updated_at) VALUES (?,?,0,0,?,?)",
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
            """SELECT DISTINCT c.* FROM chats c LEFT JOIN messages m ON m.chat_id=c.id
               WHERE c.archived=? AND (c.title LIKE ? OR m.content LIKE ?)
               ORDER BY c.pinned DESC, c.updated_at DESC""",
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
        conn.close(); return None
    msg_rows = conn.execute("SELECT * FROM messages WHERE chat_id=? ORDER BY id ASC", (chat_id,)).fetchall()
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
    if not title: return False
    conn = get_conn()
    cur = conn.execute("UPDATE chats SET title=?, updated_at=? WHERE id=?", (title, int(_time.time()), chat_id))
    conn.commit(); ok = cur.rowcount > 0; conn.close()
    return ok

def delete_chat(chat_id):
    conn = get_conn()
    conn.execute("DELETE FROM messages WHERE chat_id=?", (chat_id,))
    cur = conn.execute("DELETE FROM chats WHERE id=?", (chat_id,))
    conn.commit(); ok = cur.rowcount > 0; conn.close()
    _SESSIONS.pop(chat_id, None)
    return ok

def set_pinned(chat_id, pinned):
    conn = get_conn()
    cur = conn.execute("UPDATE chats SET pinned=? WHERE id=?", (1 if pinned else 0, chat_id))
    conn.commit(); ok = cur.rowcount > 0; conn.close()
    return ok

def set_archived(chat_id, archived):
    conn = get_conn()
    cur = conn.execute("UPDATE chats SET archived=? WHERE id=?", (1 if archived else 0, chat_id))
    conn.commit(); ok = cur.rowcount > 0; conn.close()
    return ok

def _touch_chat(chat_id):
    conn = get_conn()
    conn.execute("UPDATE chats SET updated_at=? WHERE id=?", (int(_time.time()), chat_id))
    conn.commit(); conn.close()

def _maybe_autotitle(chat_id, text):
    conn = get_conn()
    row = conn.execute("SELECT title FROM chats WHERE id=?", (chat_id,)).fetchone()
    if row and row["title"] == DEFAULT_TITLE:
        title = " ".join(text.strip().split())
        if len(title) > 48: title = title[:45].rstrip() + "..."
        conn.execute("UPDATE chats SET title=? WHERE id=?", (title or DEFAULT_TITLE, chat_id))
        conn.commit()
    conn.close()

def add_message(chat_id, role, content, cards=None):
    now = int(_time.time())
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO messages (chat_id,role,content,cards,created_at) VALUES (?,?,?,?,?)",
        (chat_id, role, content, json.dumps(cards or []), now),
    )
    conn.commit(); msg_id = cur.lastrowid; conn.close()
    return {"id": msg_id, "role": role, "content": content, "cards": cards or [], "created_at": now}

def get_messages(chat_id):
    conn = get_conn()
    rows = conn.execute("SELECT * FROM messages WHERE chat_id=? ORDER BY id ASC", (chat_id,)).fetchall()
    conn.close()
    return [_msg_to_dict(r) for r in rows]

def delete_last_assistant_message(chat_id):
    conn = get_conn()
    row = conn.execute(
        "SELECT id FROM messages WHERE chat_id=? AND role='assistant' ORDER BY id DESC LIMIT 1", (chat_id,)
    ).fetchone()
    if row:
        conn.execute("DELETE FROM messages WHERE id=?", (row["id"],)); conn.commit()
    conn.close()

def delete_last_user_message_text(chat_id):
    """Used by Regenerate: returns (and does not delete) the last user
    message text, so the same query can be re-run against TMDB."""
    conn = get_conn()
    row = conn.execute(
        "SELECT content FROM messages WHERE chat_id=? AND role='user' ORDER BY id DESC LIMIT 1", (chat_id,)
    ).fetchone()
    conn.close()
    return row["content"] if row else None

def export_chat_text(chat_id):
    chat = get_chat(chat_id)
    if not chat: return None
    lines = [f"S.N.E.T.C.H — {chat['title']}", "=" * 60, ""]
    for m in chat["messages"]:
        who = "You" if m["role"] == "user" else "S.N.E.T.C.H Entertainment"
        ts = _time.strftime("%Y-%m-%d %H:%M:%S", _time.localtime(m["created_at"]))
        lines.append(f"[{ts}] {who}:")
        lines.append(m["content"])
        lines.append("")
    return "\n".join(lines)


# ── Formatting: console text -> markdown, TMDB items -> image cards ────────

_HEADER_PREFIXES = (
    "🎬","📺","🧑","⭐","📊","🎭","💰","💵","🌐","🏭","🌍","🔞","🔗","📖","🆔",
    "🖼️","🌅","🎥","👥","✍️","📡","🔢","🎂","📍","🕊️","👤","🎵","📷","✂️",
    "⏱️","📅","🔥","🎯","⚔️","🏆","🤝","🔍","🏷️",
)

def _to_markdown(raw):
    lines = raw.replace("\r", "").strip("\n").split("\n")
    out = []
    for line in lines:
        s = line.strip()
        if not s:
            out.append(""); continue
        if s.startswith("•"):
            out.append("- " + s[1:].strip())
        elif re.match(r"^\d+\.\s", s):
            out.append(s)
        elif s.startswith(_HEADER_PREFIXES):
            out.append("**" + s + "**")
        elif s.startswith("="):
            continue
        else:
            out.append(s)
    text = "\n".join(out).strip()
    return text or "Sorry, I couldn't find anything for that."

def _img(path, size="w500"):
    return f"https://image.tmdb.org/t/p/{size}{path}" if path else None


def _hero_card(data, dtype):
    if not data: return None
    if dtype == "person":
        img = _img(data.get("profile_path"))
        if not img: return None
        return {
            "kind": "person", "image": img, "title": data.get("name","?"),
            "subtitle": data.get("known_for_department") or "",
            "meta": data.get("place_of_birth") or "",
        }
    img = _img(data.get("poster_path")) or _img(data.get("backdrop_path"), "w780")
    if not img: return None
    title = data.get("title") or data.get("name") or "?"
    date = (data.get("release_date") or data.get("first_air_date") or "")[:4]
    rating = round(data.get("vote_average", 0) or 0, 1)
    genres = ", ".join(g["name"] for g in data.get("genres", [])[:3])
    return {
        "kind": dtype, "image": img, "title": title,
        "subtitle": f"{date} · ⭐ {rating}/10" if date else f"⭐ {rating}/10",
        "meta": genres,
    }

def _grid_cards(items, limit=8):
    cards = []
    for x in (items or [])[:limit]:
        kind = x.get("_kind") or x.get("media_type") or "movie"
        if kind == "person":
            img = _img(x.get("profile_path"))
            title = x.get("name","?")
            subtitle = x.get("known_for_department") or ""
        else:
            img = _img(x.get("poster_path"))
            title = x.get("title") or x.get("name") or "?"
            date = (x.get("release_date") or x.get("first_air_date") or "")[:4]
            rating = round(x.get("vote_average", 0) or 0, 1)
            subtitle = f"{date} · ⭐ {rating}/10" if date else f"⭐ {rating}/10"
        if img:
            cards.append({"kind": kind, "image": img, "title": title, "subtitle": subtitle, "meta": ""})
    return cards

def _cast_cards(data, limit=6):
    cast = (data or {}).get("credits", {}).get("cast", [])[:limit]
    cards = []
    for c in cast:
        img = _img(c.get("profile_path"))
        if img:
            cards.append({"kind": "person", "image": img, "title": c.get("name","?"),
                          "subtitle": c.get("character","") , "meta": ""})
    return cards

def build_response(chat_id, user_text):
    """Runs the console engine's process() for one chat's isolated context,
    capturing its printed output, and returns {text, cards} for the web UI."""
    global ctx, LAST_ITEMS
    sess = _session(chat_id)
    ctx = sess["ctx"]
    LAST_ITEMS = sess["items"]
    
    # Clear grid items from previous turn so they don't incorrectly duplicate
    LAST_ITEMS.clear()

    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            process(user_text)
    except Exception as e:
        buf.write(f"\n⚠️ Something went wrong while looking that up: {e}")
    finally:
        sess["ctx"] = ctx
        sess["items"] = LAST_ITEMS

    raw = buf.getvalue()
    text = _to_markdown(raw)

    cards = []
    hero = _hero_card(ctx.get("data"), ctx.get("type"))
    if hero: cards.append(hero)
    cards.extend(_grid_cards(LAST_ITEMS, limit=8 if not hero else 6))
    if hero and ctx.get("type") in ("movie", "tv"):
        cards.extend(_cast_cards(ctx.get("data"), limit=4))
    # De-duplicate by image URL while preserving order
    seen = set(); unique = []
    for c in cards:
        if c["image"] not in seen:
            seen.add(c["image"]); unique.append(c)
    return {"text": text, "cards": unique[:12]}


def stream_reply(chat_id, user_text):
    """Generator consumed by a Flask streaming response in app.py. TMDB
    lookups aren't token-streamed by nature, so the full answer is computed
    first, then yielded progressively (word-by-word) for a smooth typing
    animation, followed by a hidden trailer line carrying the image cards
    as JSON so the frontend can render premium cards alongside the text."""
    add_message(chat_id, "user", user_text)
    _maybe_autotitle(chat_id, user_text)
    result = build_response(chat_id, user_text)
    text, cards = result["text"], result["cards"]

    words = text.split(" ")
    for i, w in enumerate(words):
        yield w + (" " if i < len(words) - 1 else "")

    add_message(chat_id, "assistant", text, cards)
    _touch_chat(chat_id)
    if cards:
        yield "\n\u0000CARDS\u0000" + json.dumps(cards)


def regenerate_reply(chat_id):
    """Generator: drops the last assistant reply and re-runs the same
    lookup, streaming a fresh answer the same way stream_reply() does."""
    last_user_text = delete_last_user_message_text(chat_id)
    delete_last_assistant_message(chat_id)
    if not last_user_text:
        yield "There's nothing to regenerate yet."
        return
    result = build_response(chat_id, last_user_text)
    text, cards = result["text"], result["cards"]

    words = text.split(" ")
    for i, w in enumerate(words):
        yield w + (" " if i < len(words) - 1 else "")

    add_message(chat_id, "assistant", text, cards)
    _touch_chat(chat_id)
    if cards:
        yield "\n\u0000CARDS\u0000" + json.dumps(cards)
        