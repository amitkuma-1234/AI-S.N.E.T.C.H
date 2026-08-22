# ============================================================
#  imagecreater.py — S.N.E.T.C.H Image Creator (backend)
# ============================================================
#  Downloads REAL images from the web (DuckDuckGo Image Search) for
#  whatever the user searches for — a person, an animal, a place,
#  an object, anything — and manages per-batch storage on disk so
#  the frontend can show, download, or delete each image
#  individually.
#
#  Every "New Image Generator" click starts a brand-new batch.
#  Images live in generated_images/<batch_id>/image_<n>.<ext> until
#  the user deletes them or the batch is cleared. Nothing is ever
#  written to the user's Downloads folder automatically — files
#  only leave this folder when the user clicks Download / Download
#  All (handled by the browser via a Flask attachment response).
#
#  IMAGE SOURCE + QUALITY PIPELINE
#  --------------------------------
#  Search results come from DuckDuckGo Image Search across 50+ query
#  variations per subject (solo/front-view/trusted-site/reference
#  phrasing). Every candidate is then run through a multi-layer
#  filter before it's ever saved: banned-keyword check, size/ratio
#  validity, perceptual-hash de-dup, a YOLOv8 "alone in frame" check
#  (reject group/multi-object shots), and a CLIP AI verification
#  (real photo, solo subject, front/side view — reject cartoons,
#  group shots, and back-view photos). YOLOv8 and CLIP are optional,
#  lazily-loaded local models — if their packages aren't installed
#  the corresponding layer is skipped rather than breaking search.
# ============================================================

import io
import os
import re
import uuid
import time
import random
import zipfile
import threading
import urllib.parse

import requests
import numpy as np
from PIL import Image
from duckduckgo_search import DDGS


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GENERATED_ROOT = os.path.join(BASE_DIR, "generated_images")
os.makedirs(GENERATED_ROOT, exist_ok=True)

BATCH_ID_RE = re.compile(r"^[a-f0-9]{16,32}$")
FILENAME_RE = re.compile(r"^image_\d{1,6}\.(jpg|jpeg|png|webp|gif|bmp)$", re.IGNORECASE)

# This is a server-side SANITY ceiling to keep one batch from being
# able to hammer the network / disk forever — it is NOT a UI limit.
# The user can type any number in the "Number of Images" box; if it
# happens to exceed this, the actual run is capped here.
MAX_IMAGES_PER_BATCH = 300

SEARCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/114.0.0.0 Safari/537.36"
    )
}
DOWNLOAD_TIMEOUT = 12
SEARCH_TIMEOUT = 12

# How many candidate URLs to try to collect per search, relative to
# how many images the user actually wants — extra headroom lets us
# skip broken links / duplicates without going back to DuckDuckGo.
CANDIDATE_MULTIPLIER = 4
MIN_CANDIDATES = 40
MAX_CANDIDATES = 600

# ------------------------------------------------------------------
# QUALITY-FILTER SETTINGS
# ------------------------------------------------------------------
# BANNED KEYWORDS — URL + Title filter. Non-photographic content
# (cartoon/clipart/etc.), multi-subject shots (group/crowd/family),
# and backside/rear-view shots are all rejected — only a clean, solo,
# front/side-facing real photo of the subject should get through.
BANNED_KEYWORDS = [
    "cartoon", "drawing", "illustration", "clipart", "vector",
    "animated", "anime", "logo", "icon", "painting",
    "sketch", "wallpaper", "toy", "costume", "mask", "doll",
    "tattoo", "poster", "banner",
    "minecraft", "pokemon", "fortnite", "roblox", "game",
    "emoji", "sticker", "gif", "png", "svg", "transparent",

    # Group/crowd/multi-subject filter — sirf SOLO subject chahiye
    "group", "crowd", "family", "team", "friends", "duo", "trio",
    "couple", "pair", "wedding", "meeting", "audience", "fans",
    "cast", "squad", "together", "reunion", "gathering",
    "with wife", "with husband", "with kids", "with children",
    "vs", "versus", "and other", "and friends", "and family",

    # Back/rear view filter — sirf front/side view chahiye
    "back view", "rear view", "backside", "from behind",
    "back of head", "turned away", "walking away",
]

# Trusted domains — inse image aayi toh pakki sahi hogi
TRUSTED_DOMAINS = [
    "nationalgeographic.com", "natgeotraveller", "natgeo",
    "wikipedia.org", "wikimedia.org",
    "worldwildlife.org", "wwf.org",
    "britannica.com",
    "animals.sandiegozoo.org", "sandiegozoo",
    "iucnredlist.org",
    "flickr.com",
    "unsplash.com",
    "pexels.com",
    "pixabay.com",
    "audubon.org",
    "arkive.org",
    "nhm.ac.uk",         # Natural History Museum
    "smithsonianmag.com",
    "bbc.co.uk/nature",
    "dw.com",
    "wildlife.org",
    "animaldiversity.org",
    "inaturalist.org",
    "zooniverse.org",
    "allaboutbirds.org",
    "reptile-database.org",
    "fishbase.org",
    "marinespecies.org",
]

# Reject anything too small/thin to be a real photo result.
MIN_IMAGE_DIM = 150
MAX_ASPECT_RATIO = 5.0
MIN_ASPECT_RATIO = 0.20

# Perceptual-hash near-duplicate detection (per batch) — catches the
# same photo re-served at a different size/crop/compression from a
# different URL, not just byte-identical repeats.
DHASH_SIZE = 10
DHASH_DUPLICATE_THRESHOLD = 6

# CLIP "is this actually a real photo" margin — real_score has to beat
# fake_score by this much, not just edge it out, before we accept.
CLIP_REAL_MARGIN = 0.15

# YOLOv8 "alone in frame" detector settings — har object confidence
# >= isse tabhi count hoga; box kam se kam itne % image area cover
# kare tabhi "prominent" maana jayega.
YOLO_CONF_THRESHOLD = 0.40
PROMINENT_AREA_FRACTION = 0.045


# ------------------------------------------------------------------
# BATCH / FILE MANAGEMENT
# ------------------------------------------------------------------

def new_batch_id():
    return uuid.uuid4().hex[:20]


def is_valid_batch_id(batch_id):
    return bool(batch_id) and bool(BATCH_ID_RE.match(batch_id))


def is_valid_filename(filename):
    return bool(filename) and bool(FILENAME_RE.match(filename))


def batch_dir(batch_id):
    """Return the folder for a batch. Refuses to build a path that
    escapes GENERATED_ROOT, even if batch_id looks suspicious."""
    if not is_valid_batch_id(batch_id):
        raise ValueError("Invalid batch id")
    root = os.path.abspath(GENERATED_ROOT)
    path = os.path.abspath(os.path.join(root, batch_id))
    if not path.startswith(root + os.sep):
        raise ValueError("Invalid batch id")
    return path


def start_new_batch():
    """Create a brand-new, empty batch folder and return its id."""
    batch_id = new_batch_id()
    os.makedirs(batch_dir(batch_id), exist_ok=True)
    return batch_id


def clear_batch(batch_id):
    """Completely remove a batch folder (used on reset / New Image
    Generator, and safe to call on an id that no longer exists)."""
    if not is_valid_batch_id(batch_id):
        return
    try:
        path = batch_dir(batch_id)
    except ValueError:
        return
    if os.path.isdir(path):
        for name in os.listdir(path):
            try:
                os.remove(os.path.join(path, name))
            except OSError:
                pass
        try:
            os.rmdir(path)
        except OSError:
            pass
    _SEARCH_CACHE.pop(batch_id, None)
    _HASH_CACHE.pop(batch_id, None)


def list_batch_images(batch_id):
    path = batch_dir(batch_id)
    if not os.path.isdir(path):
        return []
    files = [f for f in os.listdir(path) if is_valid_filename(f)]
    files.sort(key=lambda f: int(re.search(r"\d+", f).group()))
    return files


def delete_image(batch_id, filename):
    if not is_valid_filename(filename):
        raise ValueError("Invalid filename")
    path = os.path.join(batch_dir(batch_id), filename)
    if os.path.isfile(path):
        os.remove(path)
        return True
    return False


def sanitize_filename_part(text):
    """Turn a search term into a safe filename fragment — spaces
    become underscores, anything else unsafe for a filename is
    stripped. Falls back to a generic label if nothing is left."""
    text = (text or "").strip()
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"[^A-Za-z0-9_\-]", "", text)
    return text or "SNETCH_Image"


def get_batch_query(batch_id):
    """Return the search term currently cached for this batch, or
    None if nothing has been searched yet."""
    with _CACHE_LOCK:
        cache = _SEARCH_CACHE.get(batch_id)
        return cache["query"] if cache else None


def download_filename(batch_id, filename):
    """Build a user-friendly download name from the batch's search
    term, e.g. image_3.jpg + query "Samantha Ruth Prabhu" becomes
    Samantha_Ruth_Prabhu_3.jpg. Falls back to the stored filename
    (prefixed) if anything looks unexpected."""
    match = re.match(r"^image_(\d+)\.(\w+)$", filename, re.IGNORECASE)
    if not match:
        return filename
    index, ext = match.group(1), match.group(2)
    base = sanitize_filename_part(get_batch_query(batch_id))
    return f"{base}_{index}.{ext}"


def zip_batch(batch_id, folder_label=None):
    """Zip every remaining image in the batch into one in-memory
    archive, nested under a single folder — so unzipping it drops a
    tidy folder straight into the user's Downloads. Both the folder
    and each image inside it are named after the search term."""
    files = list_batch_images(batch_id)
    path = batch_dir(batch_id)
    label = folder_label or sanitize_filename_part(get_batch_query(batch_id))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.write(os.path.join(path, f), arcname=f"{label}/{download_filename(batch_id, f)}")
    buffer.seek(0)
    return buffer


# ------------------------------------------------------------------
# QUALITY FILTERS — keyword/domain/size checks (cheap, run first) and
# perceptual-hash de-dup (run once we actually have image bytes).
# Adapted from a standalone dataset-downloader script's filtering
# pipeline, trimmed down for a generic "search anything" image tool:
# we keep the "reject non-photographic junk" and "reject duplicates"
# layers, but drop that script's solo-subject/front-view-only checks
# since those don't make sense for a "Sunset" or "Cyberpunk city"
# search — only for narrow subject-training use cases.
# ------------------------------------------------------------------

def is_url_clean(url, title=""):
    """Reject results whose URL or title flags them as cartoons,
    clipart, logos, etc. rather than real photographs."""
    combined = (url + " " + title).lower()
    return not any(kw in combined for kw in BANNED_KEYWORDS)


def is_trusted_domain(url):
    url_lower = url.lower()
    return any(domain in url_lower for domain in TRUSTED_DOMAINS)


def is_image_valid(img):
    """Reject images too small or too extreme an aspect ratio to be
    a normal photo (icons, thin banner strips, etc.)."""
    w, h = img.size
    if w < MIN_IMAGE_DIM or h < MIN_IMAGE_DIM:
        return False
    ratio = w / h
    return MIN_ASPECT_RATIO <= ratio <= MAX_ASPECT_RATIO


def dhash(img, hash_size=DHASH_SIZE):
    """Perceptual hash — a compact 'visual fingerprint' of the image.
    Unlike an exact byte/MD5 match, this still catches the same photo
    re-served at a different size/crop/compression from another URL."""
    small = img.convert("L").resize((hash_size + 1, hash_size), Image.LANCZOS)
    pixels = list(small.getdata())
    bits = []
    for row in range(hash_size):
        row_start = row * (hash_size + 1)
        for col in range(hash_size):
            bits.append(pixels[row_start + col] > pixels[row_start + col + 1])
    value = 0
    for bit in bits:
        value = (value << 1) | (1 if bit else 0)
    return value


def hamming_distance(hash1, hash2):
    return bin(hash1 ^ hash2).count("1")


def is_near_duplicate(new_hash, seen_hashes, threshold=DHASH_DUPLICATE_THRESHOLD):
    return any(hamming_distance(new_hash, h) <= threshold for h in seen_hashes)


# ------------------------------------------------------------------
# ENTITY DETECTOR — YOLOv8 (FREE, most powerful local option)
# Ye sirf face nahi — HAR PROMINENT OBJECT/PERSON count karta hai
# (side-face, angle, animal, object — sab kuch). Agar subject ke
# alawa koi bhi doosra prominent insaan/object frame mein hai —
# REJECT. Lazily loaded exactly once per process (same pattern as
# DINOv2 in snaplock.py) — if `ultralytics` isn't installed, falls
# back to a Haar Cascade face-count check; if that's unavailable too,
# this layer is skipped entirely (fail open) rather than breaking
# image search.
# ------------------------------------------------------------------

_yolo_model = None
_yolo_load_error = None
_face_cascade = None
_face_cascade_load_error = None


def _load_yolo():
    global _yolo_model, _yolo_load_error

    if _yolo_model is not None:
        return _yolo_model
    if _yolo_load_error is not None:
        raise RuntimeError(_yolo_load_error)

    try:
        from ultralytics import YOLO
        from model_loader import ensure_model
        yolo_path = ensure_model(
            os.path.join(BASE_DIR, "models", "yolov8n.pt"),
            "1Ob_T3wIQTLYjkWIQpLrZL7p2jMJTsRgu",
        )
        _yolo_model = YOLO(yolo_path)
        return _yolo_model
    except Exception as e:
        _yolo_load_error = str(e)
        raise RuntimeError(_yolo_load_error)


def _load_face_cascade():
    global _face_cascade, _face_cascade_load_error

    if _face_cascade is not None:
        return _face_cascade
    if _face_cascade_load_error is not None:
        raise RuntimeError(_face_cascade_load_error)

    try:
        import cv2
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        if cascade.empty():
            raise Exception("Cascade file load nahi hua")
        _face_cascade = cascade
        return _face_cascade
    except Exception as e:
        _face_cascade_load_error = str(e)
        raise RuntimeError(_face_cascade_load_error)


def _count_faces_fallback(img):
    try:
        import cv2
        cascade = _load_face_cascade()
        cv_img = np.array(img)
        cv_img = cv2.cvtColor(cv_img, cv2.COLOR_RGB2BGR)
        gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        faces = cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=6, minSize=(40, 40)
        )
        return len(faces)
    except Exception:
        return -1


def is_alone_in_frame(img):
    """
    TRUE = subject akela hai frame mein (koi doosra prominent
           insaan/object nahi hai — SAVE karo)
    FALSE = frame mein 2+ prominent entities hain (group/merge — REJECT karo)

    YOLOv8 available hai toh: har object/person count karta hai, jo
    bhi box PROMINENT_AREA_FRACTION se bada hai aur confidence
    threshold se upar hai, uska count leta hai. Person class ke liye
    extra strict: 2+ log dikhe (chahe chote bhi ho) toh turant reject.
    """
    try:
        yolo_model = _load_yolo()
        w, h = img.size
        img_area = w * h

        results = yolo_model.predict(
            source=np.array(img),
            conf=YOLO_CONF_THRESHOLD,
            verbose=False
        )

        boxes = results[0].boxes
        if boxes is None or len(boxes) == 0:
            return True  # kuch detect nahi hua, safe hai

        person_count = 0
        prominent_count = 0

        for box in boxes:
            cls_id = int(box.cls[0])
            cls_name = yolo_model.names.get(cls_id, "")
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            box_area = max(0, (x2 - x1)) * max(0, (y2 - y1))
            area_fraction = box_area / img_area if img_area > 0 else 0

            if cls_name == "person":
                person_count += 1
            if area_fraction >= PROMINENT_AREA_FRACTION:
                prominent_count += 1

        # 2+ log dikhe (chote bhi) — turant reject
        if person_count >= 2:
            return False
        # Koi bhi 2+ prominent (bada) object/entity frame mein — reject
        if prominent_count >= 2:
            return False
        return True

    except (ImportError, RuntimeError):
        # YOLOv8 not available — fall back to a basic face count.
        num_faces = _count_faces_fallback(img)
        if num_faces >= 2:
            return False
        return True
    except Exception:
        return True  # error pe assume valid (fail-safe)


# ------------------------------------------------------------------
# CLIP — free, local "is this actually a real photo" verifier.
# Lazily loaded exactly once per process (same pattern as DINOv2 in
# snaplock.py); if transformers/torch aren't available or the model
# fails to load, we fail OPEN (skip this layer) instead of breaking
# image search entirely. Weights are cached locally after first run.
# ------------------------------------------------------------------

_clip_model = None
_clip_processor = None
_clip_load_error = None


def _load_clip():
    global _clip_model, _clip_processor, _clip_load_error

    if _clip_model is not None:
        return _clip_processor, _clip_model
    if _clip_load_error is not None:
        raise RuntimeError(_clip_load_error)

    try:
        from transformers import CLIPProcessor, CLIPModel
        _clip_model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
        _clip_processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
        _clip_model.eval()
        return _clip_processor, _clip_model
    except Exception as e:
        _clip_load_error = str(e)
        raise RuntimeError(_clip_load_error)


def clip_verify(img, query):
    """
    CLIP se check karo ki image mein wo subject hai — REAL photo,
    cartoon/illustration/drawing NAHI. Margin-based strict check:
    sirf "thoda zyada" real-score hone se pass nahi hoga, clear
    margin se real hona chahiye. Phir SOLO vs group/crowd, aur
    FRONT/SIDE vs BACKSIDE/rear view bhi check karta hai.
    Returns True (accept) whenever CLIP isn't available or errors
    out — this is a bonus layer, not a hard gate.
    """
    try:
        import torch
        processor, model = _load_clip()
    except (ImportError, RuntimeError):
        return True

    try:
        a = (_clean_query(query) or query).lower()

        # Pehla check: sahi subject hai ya nahi (cartoon/logo/ad/text nahi)
        labels = [
            f"a real photograph of a {a}",           # sahi
            f"a high resolution real photo of {a}",  # sahi
            f"a cartoon character of {a}",            # galat
            "an illustration or digital drawing",     # galat
            "a vector art or clipart image",          # galat
            "a hand drawn sketch",                    # galat
            "a logo or icon",                         # galat
            "an advertisement or product label",      # galat
            "text or a document",                     # galat
            "a painting or artwork",                  # galat
        ]

        thumb = img.copy()
        thumb.thumbnail((224, 224))

        inputs = processor(text=labels, images=thumb, return_tensors="pt", padding=True)
        with torch.no_grad():
            outputs = model(**inputs)
            probs = outputs.logits_per_image.softmax(dim=1)[0]

        real_score = (probs[0] + probs[1]).item()
        fake_score = sum(probs[2:]).item()

        # STRICT MARGIN — sirf thoda zyada real hone se pass nahi hoga
        if real_score < fake_score + CLIP_REAL_MARGIN:
            return False

        # Doosra check: SOLO hai ya group/crowd hai
        solo_labels = [
            f"a photo of only one {a} alone, nothing else",     # sahi (solo)
            f"a single {a} by itself",                            # sahi (solo)
            "a group or crowd with multiple people",              # galat (group)
            "multiple people or objects together in a photo",     # galat (group)
        ]

        inputs2 = processor(text=solo_labels, images=thumb, return_tensors="pt", padding=True)
        with torch.no_grad():
            outputs2 = model(**inputs2)
            probs2 = outputs2.logits_per_image.softmax(dim=1)[0]

        solo_score = (probs2[0] + probs2[1]).item()
        group_score = (probs2[2] + probs2[3]).item()

        # Solo score zyada hona chahiye, warna reject (group/crowd photo)
        if solo_score <= group_score:
            return False

        # Teesra check: FRONT/SIDE view hai ya BACKSIDE/rear view hai
        view_labels = [
            f"a clear front view of {a}",                                     # sahi
            f"a side profile view of {a}",                                     # sahi
            f"the back or rear view of {a} facing away from camera",           # galat
            "only the back of the head or body, face not visible",             # galat
        ]

        inputs3 = processor(text=view_labels, images=thumb, return_tensors="pt", padding=True)
        with torch.no_grad():
            outputs3 = model(**inputs3)
            probs3 = outputs3.logits_per_image.softmax(dim=1)[0]

        front_score = (probs3[0] + probs3[1]).item()
        back_score = (probs3[2] + probs3[3]).item()

        # Back-view clearly zyada confident hai toh reject karo
        # (thoda buffer rakha hai taaki borderline cases over-reject na ho)
        if back_score > front_score + 0.10:
            return False

        return True
    except Exception:
        return True  # any inference hiccup — fail open, don't block the search


# ------------------------------------------------------------------
# DUCKDUCKGO IMAGE SEARCH — finds real, original image URLs
# ------------------------------------------------------------------

# Per-batch cache of {"query", "candidates": [{"url","title"}...], "cursor": int}.
# In-memory only — a server restart just means the next /generate
# call re-searches, which is harmless.
_SEARCH_CACHE = {}
_CACHE_LOCK = threading.Lock()

# Per-batch list of perceptual hashes (dhash ints) already saved, used
# to reject near-duplicates. Cleared alongside _SEARCH_CACHE.
_HASH_CACHE = {}


def _get_hash_cache(batch_id):
    return _HASH_CACHE.setdefault(batch_id, [])


def _clean_query(raw_query):
    q = (raw_query or "").strip().lower()
    for junk in ("image of", "images of", "photo of", "photos of",
                 "picture of", "pictures of", "download", "image",
                 "images", "photo", "photos", "picture", "pictures"):
        q = q.replace(junk, "")
    q = " ".join(q.split())
    return q or (raw_query or "").strip()


def _reorder_trusted_first(candidates):
    """Trusted-domain results (Wikipedia, Unsplash, NatGeo, ...) go
    first — they're reliably real photographs, not watermarked/edited
    reposts — everything else keeps its original relative order
    (shuffled, same as the source script)."""
    trusted = [c for c in candidates if is_trusted_domain(c["url"])]
    untrusted = [c for c in candidates if not is_trusted_domain(c["url"])]
    random.shuffle(untrusted)
    return trusted + untrusted


# =============================================
# 50+ VERY SPECIFIC QUERIES — generic, kisi bhi subject ke liye
# =============================================

def build_all_queries(subject):
    a = subject.replace("_", " ")
    return [
        # Solo/alone focused queries — sirf isi subject ki akeli photo, koi doosra insaan/object nahi
        f"{a} solo photo alone -group -crowd -family -team -friends",
        f"{a} single portrait alone -group -crowd -multiple people",
        f"{a} individual photo alone -group -family -team",
        f"{a} standing alone photo -crowd -group -others",
        f"{a} solo shot -group -crowd -family -friends -team",

        # Front-view focused queries — backside/rear view exclude
        f"{a} front view face photo -back view -rear -from behind",
        f"{a} clear face photo -backside -rear view -turned away",
        f"{a} looking at camera photo -back view -rear -behind",

        # Negative keyword queries
        f"{a} real photo -cartoon -drawing -clipart -illustration -group -crowd",
        f"{a} high quality photography -cartoon -illustration -group -crowd",
        f"{a} closeup real photo -cartoon -illustration -drawing -group",
        f"{a} in natural setting -drawing -art -cartoon -group -crowd",
        f"{a} high resolution photo -cartoon -clipart -group -crowd",
        f"{a} real photography -cartoon -group -crowd",
        f"{a} portrait photo -cartoon -clipart -group -crowd",

        # Trusted site specific queries
        f"{a} site:wikipedia.org",
        f"{a} site:wikimedia.org",
        f"{a} site:nationalgeographic.com",
        f"{a} site:unsplash.com",
        f"{a} site:pexels.com",
        f"{a} site:pixabay.com",
        f"{a} site:inaturalist.org",
        f"{a} site:flickr.com",
        f"{a} site:britannica.com",
        f"{a} site:sandiegozoo.org",
        f"{a} site:smithsonianmag.com",
        f"{a} site:allaboutbirds.org",
        f"{a} site:arkive.org",

        # Very specific reference/science queries
        f"{a} identification photo",
        f"{a} documentary photo",
        f"{a} encyclopedia image",
        f"{a} reference photo",
        f"{a} detailed photo",
        f"{a} field guide photo",
        f"{a} scientific photo",
        f"{a} classification photo",

        # Action / context specific
        f"{a} in action photo",
        f"{a} up close photo",
        f"{a} outdoor photo",
        f"{a} resting photo",
        f"{a} moving photo",
        f"{a} in water photo",
        f"{a} in air photo",
        f"{a} in motion photo",
        f"{a} activity photo",
        f"{a} interaction photo",
        f"{a} with others photo",
        f"{a} group photo",
        f"{a} at night photo",
        f"{a} in rain photo",

        # Detail specific
        f"{a} face closeup photo",
        f"{a} details closeup",
        f"{a} texture closeup",
        f"{a} parts closeup photo",
        f"{a} side view photo",
        f"{a} front view photo",

        # Location specific
        f"{a} africa photo",
        f"{a} asia photo",
        f"{a} amazon photo",
        f"{a} australia photo",
        f"{a} india photo",
        f"{a} outdoors photo",
        f"{a} nature photo",
        f"{a} arctic photo",
        f"{a} ocean sea photo",
        f"{a} river lake photo",
    ]


def _search_ddgs_candidates(query, wanted_count):
    """Walk build_all_queries(query) round-robin, pulling image
    results from DuckDuckGo (DDGS) for each query variation, until
    we've collected `target` de-duplicated candidates or run out of
    query variations to try. Returns a list of {"url", "title"}
    dicts, trusted domains ordered first.
    """
    clean = _clean_query(query)
    target = max(MIN_CANDIDATES, min(MAX_CANDIDATES, wanted_count * CANDIDATE_MULTIPLIER))

    all_queries = build_all_queries(clean)
    candidates = []
    seen = set()

    query_index = 0
    empty_streak = 0
    max_attempts = len(all_queries) * 3

    while len(candidates) < target and query_index < max_attempts and empty_streak < 6:
        q = all_queries[query_index % len(all_queries)]
        use_type = (query_index <= len(all_queries) * 2)
        query_index += 1

        results = []
        for attempt in range(3):
            try:
                with DDGS() as ddgs:
                    kw = dict(max_results=200)
                    if use_type:
                        kw["type_image"] = "photo"
                    results = list(ddgs.images(q, **kw))
                if results:
                    break
            except Exception:
                time.sleep(3)

        if not results:
            empty_streak += 1
            continue
        empty_streak = 0

        for result in results:
            url = result.get("image", "")
            title = result.get("title", "")
            if not url or url in seen:
                continue
            seen.add(url)
            candidates.append({"url": url, "title": title})

        time.sleep(random.uniform(0.5, 1.5))

    return _reorder_trusted_first(candidates)


def _get_batch_cache(batch_id, query, wanted_count):
    with _CACHE_LOCK:
        cache = _SEARCH_CACHE.get(batch_id)
        if cache is None or cache["query"] != query:
            cache = {
                "query": query,
                "candidates": _search_ddgs_candidates(query, wanted_count),
                "cursor": 0,
            }
            _SEARCH_CACHE[batch_id] = cache
        elif len(cache["candidates"]) - cache["cursor"] < wanted_count:
            # Running low on candidates for a bigger request — top up.
            more = _search_ddgs_candidates(query, wanted_count * 2)
            existing = {c["url"] for c in cache["candidates"]}
            cache["candidates"].extend(c for c in more if c["url"] not in existing)
        return cache


def _ext_from_response(resp, fallback_url):
    content_type = resp.headers.get("Content-Type", "")
    if "image" in content_type:
        ext = content_type.split("/")[-1].split(";")[0].strip().lower()
        ext = "jpg" if ext == "jpeg" else ext
        if ext in ("jpg", "png", "webp", "gif", "bmp"):
            return ext
    # Fall back to the URL's own extension if the header was useless.
    path_ext = os.path.splitext(urllib.parse.urlparse(fallback_url).path)[1].lstrip(".").lower()
    path_ext = "jpg" if path_ext == "jpeg" else path_ext
    if path_ext in ("jpg", "png", "webp", "gif", "bmp"):
        return path_ext
    return "jpg"


def _download_one_candidate(url):
    """Attempt to download a single candidate URL. Returns
    (bytes, ext) on success, or None if the URL is broken / not a
    real image / times out — callers should just move on to the
    next candidate."""
    try:
        resp = requests.get(url, headers=SEARCH_HEADERS, timeout=DOWNLOAD_TIMEOUT, stream=True)
    except requests.RequestException:
        return None

    if resp.status_code != 200:
        return None

    content_type = resp.headers.get("Content-Type", "")
    if "image" not in content_type:
        return None

    try:
        content = resp.content
    except requests.RequestException:
        return None

    if not content or len(content) < 512:  # too small to be a real photo
        return None

    return content, _ext_from_response(resp, url)


class NoMoreImagesError(Exception):
    """Raised when the search has no more candidate URLs left to try
    for this query — i.e. we truly can't find another distinct image."""
    pass


def download_next_image(batch_id, query, index, wanted_count):
    """Get the next *real, original* searched image for `query` and
    return (image_bytes, ext). Walks the cached candidate list for
    this batch, running each candidate through the quality-filter
    chain — banned-keyword check, download, size/ratio validity,
    perceptual-hash de-dup, YOLOv8 alone-in-frame check, and a CLIP
    real/solo/front-view verification — skipping anything that fails
    until one succeeds or the candidate list is truly exhausted.
    """
    query = (query or "").strip()
    if not query:
        raise ValueError("Search term cannot be empty")
    if len(query) > 200:
        raise ValueError("Search term is too long (max 200 characters)")

    cache = _get_batch_cache(batch_id, query, wanted_count)
    hash_cache = _get_hash_cache(batch_id)

    while True:
        with _CACHE_LOCK:
            if cache["cursor"] >= len(cache["candidates"]):
                # Try one more top-up before giving up entirely.
                more = _search_ddgs_candidates(query, wanted_count * 2)
                existing = {c["url"] for c in cache["candidates"]}
                new_candidates = [c for c in more if c["url"] not in existing]
                if not new_candidates:
                    raise NoMoreImagesError(
                        f"Couldn't find any more images for \u201c{query}\u201d."
                    )
                cache["candidates"].extend(new_candidates)

            candidate = cache["candidates"][cache["cursor"]]
            cache["cursor"] += 1

        url, title = candidate["url"], candidate.get("title", "")

        # Layer 1: URL + title keyword filter (cheap, no network call)
        if not is_url_clean(url, title):
            continue

        # Layer 2: download
        result = _download_one_candidate(url)
        if result is None:
            continue
        content, ext = result

        # Layer 3: open + size/aspect-ratio validity
        try:
            img = Image.open(io.BytesIO(content)).convert("RGB")
        except Exception:
            continue
        if not is_image_valid(img):
            continue

        # Layer 4: perceptual-hash near-duplicate check (per batch)
        h = dhash(img)
        if is_near_duplicate(h, hash_cache):
            continue

        # Layer 5: ALONE-IN-FRAME check — YOLOv8 powered. Subject ke
        # alawa koi bhi doosra prominent insaan/object frame mein
        # nahi hona chahiye.
        if not is_alone_in_frame(img):
            continue

        # Layer 6: CLIP AI verify — real photo + solo + front/side view
        # (cartoon/illustration/group-shot/back-view sab reject)
        if not clip_verify(img, query):
            continue

        hash_cache.append(h)
        return content, ext
        # broken / invalid / duplicate / not-alone / non-photographic — loop again


def save_image(batch_id, index, image_bytes, ext="jpg"):
    ext = (ext or "jpg").lower()
    if ext not in ("jpg", "png", "webp", "gif", "bmp"):
        ext = "jpg"
    filename = f"image_{index}.{ext}"
    path = os.path.join(batch_dir(batch_id), filename)
    with open(path, "wb") as f:
        f.write(image_bytes)
    return filename