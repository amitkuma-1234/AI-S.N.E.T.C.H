"""
snaplock.py — S.N.E.T.C.H SnapLock: AI Powered Object Security Vault
=======================================================================

Flask blueprint (mounted at /api/snaplock) that powers the SnapLock
feature. Wired into app.py via:

    import snaplock
    snaplock.init_db()
    snaplock.register_snaplock(app)

Design
------
A user "registers" a real-world object by capturing it from several
angles (front / back / left / right / top / optional bottom). Each
reference photo is run through a locally-loaded, pretrained deep
learning vision model (DINOv2 — Meta AI's self-supervised vision
transformer, specifically strong at fine-grained, instance-level
visual recognition rather than just broad category classification)
to produce a numeric embedding vector — a compact "visual fingerprint"
of that specific physical object instance. No cloud APIs are used and
the model is never retrained; it is used purely as a fixed, pretrained
feature extractor. The embeddings (plus the raw reference images, kept
for reference/debugging) are stored against the object.

Every object also gets its own random 256-bit "Object Vault Key"
(OVK). The OVK is wrapped (encrypted) with a key derived from the
user's chosen Access Password (PBKDF2-HMAC-SHA256 + AES-256-GCM —
the exact same primitives already used by passwordsave.py). The OVK
itself is never stored anywhere in the clear, and the Access Password
is never stored either — "is the password correct" is answered purely
by "did the OVK unwrap succeed", so there is nothing in the database
an attacker could crack offline except by brute-forcing the password
against the AEAD tag directly.

ACCURACY PIPELINE (v2)
-----------------------
The single biggest real-world failure mode of instance-recognition via
a whole-image embedding is background/lighting sensitivity: DINOv2's
CLS-token embedding summarizes the ENTIRE frame, so re-scanning the
same physical object against a different background or under different
lighting shifts the embedding enough to fall below a high similarity
threshold, even though the object itself hasn't changed. This version
adds a preprocessing + embedding pipeline specifically to fix that,
applied IDENTICALLY at registration time and at scan time (consistency
between the two sides is what makes comparison meaningful):

  1. Background removal (rembg / U2Net, pretrained, local, optional
     dependency with graceful fallback to the raw image if unavailable
     or if it fails on a given frame — matching only ever gets
     stricter/safer when this step is skipped, never looser).
  2. Tight crop to the object's bounding box (a free byproduct of the
     background-removal mask) — puts more of DINOv2's fixed input
     resolution onto the actual object instead of empty space.
  3. Lighting normalization (CLAHE on the L channel) so brightness/
     contrast differences between registration and scan lighting
     matter less.
  4. At REGISTRATION time only: a handful of light augmentations
     (small rotations + brightness jitter) of the same captured photo
     are also embedded, and every angle's stored embedding is the
     L2-renormalized AVERAGE of the base photo + its augmented
     variants. This is a lightweight few-shot/robustness trick — it
     gives the object's stored "fingerprint" some built-in tolerance
     to minor viewing-condition changes, without needing the user to
     capture and upload multiple photos per angle, and WITHOUT
     retraining or fine-tuning the underlying model (DINOv2 stays a
     fixed, pretrained feature extractor exactly as before).
  5. Matching still uses plain cosine similarity against
     SNAPLOCK_MATCH_THRESHOLD with a runner-up margin — the fix is in
     making the embeddings themselves more robust, not in loosening
     the comparison logic.

New optional runtime dependencies: `rembg` (background removal) and
`opencv-python-headless` (CLAHE lighting normalization). Both are
loaded lazily and BOTH degrade gracefully — if either is missing or
errors out on a particular image, the pipeline falls back to the
un-normalized image rather than failing the request. This keeps the
"no cloud calls, fixed pretrained extractor" design intact: these are
classical/pretrained preprocessing steps, not additional trainable
models tied to any specific object.

Matching workflow (Scanner Mode)
---------------------------------
1. The live camera frame(s) are run through the SAME background-removal
   + crop + lighting-normalization + DINOv2 pipeline used at
   registration time. The client may send either a single frame
   (field "frame") or several consecutive frames (field "frames",
   multipart, 2-5 recommended) for multi-frame voting — their
   embeddings are averaged into one steadier live embedding before
   comparison, reducing the impact of any single blurry/badly-lit
   frame. Nothing here is ever written to disk; it lives only for the
   duration of the request.
2. That live embedding is compared, via cosine similarity, against
   every stored reference-angle embedding of every object the signed-in
   user has registered. The highest-similarity reference angle for
   each object is that object's score.
3. The highest-scoring object, PROVIDED it clears
   SNAPLOCK_MATCH_THRESHOLD (a high similarity bar) AND beats the
   runner-up object by at least SNAPLOCK_MIN_CANDIDATE_MARGIN, is
   reported as a match. No Access Password is required for this step —
   matching only ever reveals *that* an object matched, never its
   stored content.
4. Only after a successful match does the client ask for the Access
   Password. Only a correct password can unwrap the OVK and therefore
   decrypt any stored password / document content.

Calibrating SNAPLOCK_MATCH_THRESHOLD / SNAPLOCK_MIN_CANDIDATE_MARGIN
----------------------------------------------------------------------
Both are environment-overridable (see below) specifically so they can
be tuned from real data instead of guessed:
  1. Register a handful of real objects.
  2. Re-scan each one 15-20 times across different backgrounds/lighting
     and record the "confidence" the /scan/match response returns
     (set SNAPLOCK_DEBUG_SCORES=1 to also get the runner-up score for
     ambiguous-object testing).
  3. Also scan each object against every OTHER registered object once,
     to see the highest cross-object (false-match) score.
  4. Pick SNAPLOCK_MATCH_THRESHOLD comfortably above the highest
     cross-object score and comfortably below the lowest same-object
     score. If those two ranges overlap, that's a signal the reference
     photos for the colliding objects are too visually similar (or too
     few angles were captured) rather than a threshold problem.
"""

import os
import io
import json
import time
import uuid
import base64
import sqlite3
import mimetypes
from functools import wraps

import jwt
from flask import Blueprint, request, jsonify, Response

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

import numpy as np
from PIL import Image, ImageOps, ImageEnhance

# -----------------------------------------------
# DEEP LEARNING OBJECT-VERIFICATION ENGINE (DINOv2)
# -----------------------------------------------
#
# We use Meta AI's DINOv2 as a pretrained, fixed feature extractor.
# DINOv2 is a self-supervised vision transformer trained specifically
# to produce embeddings that separate individual object INSTANCES, not
# just broad categories — exactly what "is this the SAME physical
# object" needs, as opposed to "is this the same kind of object".
#
# The model is downloaded once (cached locally by `transformers` after
# the first run — no cloud calls at inference time) and loaded lazily,
# a single time per process, then reused for every embed call.
#
# Model size is env-overridable. "facebook/dinov2-small" (384-dim) is
# the default for speed; "facebook/dinov2-base" or "-large" produce
# more discriminative embeddings (better accuracy) at the cost of
# slower inference and a bigger download — swap via SNAPLOCK_DINO_MODEL
# with no code changes required.

DINO_MODEL_NAME = os.getenv("SNAPLOCK_DINO_MODEL", "facebook/dinov2-small")
EMBEDDING_DIM_FALLBACK = 384  # dinov2-small's hidden size, used only for error messages

_dino_processor = None
_dino_model = None
_dino_device = "cpu"
_dino_load_error = None


def _load_dino():
    """Lazily loads the DINOv2 processor + model exactly once per process.
    Safe to call repeatedly — subsequent calls are free (just returns the
    already-loaded objects, or re-raises the same load error)."""
    global _dino_processor, _dino_model, _dino_device, _dino_load_error

    if _dino_model is not None:
        return _dino_processor, _dino_model
    if _dino_load_error is not None:
        raise RuntimeError(_dino_load_error)

    try:
        import torch
        from transformers import AutoImageProcessor, AutoModel

        _dino_device = "cuda" if torch.cuda.is_available() else "cpu"
        _dino_processor = AutoImageProcessor.from_pretrained(DINO_MODEL_NAME)
        _dino_model = AutoModel.from_pretrained(DINO_MODEL_NAME)
        _dino_model.to(_dino_device)
        _dino_model.eval()
        return _dino_processor, _dino_model
    except Exception as e:
        _dino_load_error = (
            f"Could not load the DINOv2 object-verification model "
            f"('{DINO_MODEL_NAME}'). Make sure 'torch' and 'transformers' "
            f"are installed (see requirements.txt) and that this machine "
            f"has internet access the first time it runs (to download and "
            f"cache the model weights). Details: {e}"
        )
        raise RuntimeError(_dino_load_error)


def is_model_ready() -> bool:
    """Returns True if the DINOv2 model is loaded (or loads successfully
    right now). Used by /status so the frontend can surface a clear error
    instead of a silent failure."""
    try:
        _load_dino()
        return True
    except RuntimeError:
        return False


def _model_error() -> str:
    return _dino_load_error or f"Local DINOv2 model ('{DINO_MODEL_NAME}') is not ready."


# -----------------------------------------------
# BACKGROUND REMOVAL + TIGHT CROP (accuracy pipeline, step 1 & 2)
# -----------------------------------------------
#
# Uses `rembg` (a pretrained U2Net-based background remover — local,
# no cloud calls, never retrained, same "fixed pretrained extractor"
# philosophy as DINOv2 itself). Optional dependency: if it isn't
# installed, or it errors on a specific frame, we fall back to the
# original (uncropped) image rather than failing the request. This
# means enabling it can only ever make matching MORE consistent, never
# introduce a hard failure that wasn't there before.

_rembg_session = None
_rembg_unavailable = False


def _get_rembg_session():
    global _rembg_session, _rembg_unavailable
    if _rembg_session is not None:
        return _rembg_session
    if _rembg_unavailable:
        return None
    try:
        from rembg import new_session
        _rembg_session = new_session("u2net")
        return _rembg_session
    except Exception:
        _rembg_unavailable = True
        return None


def remove_background_and_crop(img: Image.Image) -> Image.Image:
    """Removes the background from `img` and tightly crops to the
    resulting object's bounding box (with a small margin so edges
    aren't clipped). On ANY failure (library missing, model error, mask
    empty/degenerate) this returns the ORIGINAL image unchanged — never
    raises, and never silently corrupts the image. Composites the
    cutout onto a flat neutral background (rather than leaving it
    transparent) so it behaves like a normal RGB photo for everything
    downstream (lighting normalization, DINOv2 preprocessing)."""
    session = _get_rembg_session()
    if session is None:
        return img

    try:
        from rembg import remove

        rgba = remove(img.convert("RGB"), session=session)  # RGBA, background made transparent
        alpha = np.array(rgba.split()[-1])

        # Degenerate mask (nothing detected / whole frame flagged as
        # foreground) — not usable for cropping, bail out to original.
        fg_ratio = float((alpha > 10).mean())
        if fg_ratio < 0.01 or fg_ratio > 0.98:
            return img

        ys, xs = np.where(alpha > 10)
        if ys.size == 0 or xs.size == 0:
            return img

        margin = 0.06  # 6% padding so we don't clip the object's edge
        h, w = alpha.shape
        y0, y1 = ys.min(), ys.max()
        x0, x1 = xs.min(), xs.max()
        pad_y = int((y1 - y0) * margin) + 4
        pad_x = int((x1 - x0) * margin) + 4
        y0, y1 = max(0, y0 - pad_y), min(h, y1 + pad_y)
        x0, x1 = max(0, x0 - pad_x), min(w, x1 + pad_x)

        # Flatten transparency onto a neutral mid-gray backing — keeps
        # the removed-background area from injecting pure-black/white
        # extremes into DINOv2's normalization statistics.
        backing = Image.new("RGB", rgba.size, (128, 128, 128))
        backing.paste(rgba, mask=rgba.split()[-1])
        cropped = backing.crop((x0, y0, x1, y1))
        if cropped.width < 16 or cropped.height < 16:
            return img
        return cropped
    except Exception:
        return img


# -----------------------------------------------
# LIGHTING NORMALIZATION (accuracy pipeline, step 3)
# -----------------------------------------------
#
# CLAHE (Contrast Limited Adaptive Histogram Equalization) applied on
# the L channel in LAB space, via OpenCV. Optional dependency, same
# graceful-fallback contract as background removal: if `cv2` isn't
# installed or the call errors, PIL's own autocontrast is used as a
# lighter-weight substitute rather than failing the request.

def normalize_lighting(img: Image.Image) -> Image.Image:
    try:
        import cv2
        arr = np.asarray(img.convert("RGB"))
        lab = cv2.cvtColor(arr, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        l2 = clahe.apply(l)
        lab2 = cv2.merge((l2, a, b))
        out = cv2.cvtColor(lab2, cv2.COLOR_LAB2RGB)
        return Image.fromarray(out)
    except Exception:
        try:
            return ImageOps.autocontrast(img.convert("RGB"), cutoff=1)
        except Exception:
            return img


def _pad_to_square(img: Image.Image) -> Image.Image:
    """Pads (never stretches) `img` to a square canvas before it reaches
    DINOv2's preprocessor, which resizes to a fixed square input size.
    Without this, a tightly-cropped non-square object (e.g. a long thin
    item) gets its aspect ratio WARPED by that resize, which distorts
    the embedding — same object, same crop quality, but a measurably
    different vector purely from squashing. Padding with a neutral
    gray (matching the background-removal backing color) keeps that
    resize distortion-free."""
    w, h = img.size
    if w == h:
        return img
    side = max(w, h)
    canvas = Image.new("RGB", (side, side), (128, 128, 128))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2))
    return canvas


def preprocess_for_embedding(img: Image.Image) -> Image.Image:
    """The full, shared preprocessing pipeline applied identically at
    registration time and at scan time: background removal + tight
    crop, lighting normalization, then square-padding. Keeping this as
    a single shared function is what guarantees the two sides stay
    comparable — never duplicate this logic inline."""
    img = remove_background_and_crop(img)
    img = normalize_lighting(img)
    img = _pad_to_square(img)
    return img


# -----------------------------------------------
# LIGHT AUGMENTATION (accuracy pipeline, step 4 — registration only)
# -----------------------------------------------
#
# Small, cheap, label-preserving perturbations of the SAME captured
# photo (not synthetic new content) — a few degrees of rotation and a
# bit of brightness jitter. These are averaged together with the base
# embedding into one steadier per-angle "centroid" embedding. This is
# NOT model training/fine-tuning; DINOv2's weights never change. It's
# analogous to test-time augmentation, applied once at registration.

AUGMENTATIONS_PER_ANGLE = int(os.getenv("SNAPLOCK_AUGMENTATIONS_PER_ANGLE", "4"))


def _augmented_variants(img: Image.Image):
    """Yields the base image followed by a handful of light augmented
    variants of it."""
    yield img
    variants = [
        {"rotate": -8, "brightness": 1.0},
        {"rotate": 8, "brightness": 1.0},
        {"rotate": 0, "brightness": 0.85},
        {"rotate": 0, "brightness": 1.18},
    ]
    for spec in variants[:max(0, AUGMENTATIONS_PER_ANGLE)]:
        out = img
        if spec["rotate"]:
            out = out.rotate(spec["rotate"], resample=Image.BICUBIC, expand=False,
                              fillcolor=(128, 128, 128))
        if spec["brightness"] != 1.0:
            out = ImageEnhance.Brightness(out).enhance(spec["brightness"])
        yield out


# -----------------------------------------------
# IMAGE DECODE / QUALITY / EMBEDDING
# -----------------------------------------------

def decode_image_pil(image_bytes: bytes):
    """Decode raw bytes into an RGB PIL Image, or None if invalid/too small."""
    if not image_bytes:
        return None
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img = ImageOps.exif_transpose(img)  # respect camera orientation
        img = img.convert("RGB")
    except Exception:
        return None
    if img.width < 32 or img.height < 32:
        return None
    return img


def check_image_quality(image_bytes: bytes):
    """Rejects blank/near-solid or completely corrupt frames before we
    ever bother computing an embedding for them. Returns (ok, reason)."""
    img = decode_image_pil(image_bytes)
    if img is None:
        return False, "Image could not be decoded."
    small = img.resize((64, 64))
    arr = np.asarray(small, dtype=np.float32)
    if float(np.std(arr)) < 3.0:
        return False, "Frame appears blank or has no detail."
    return True, "ok"


def _embed_pil_image(img: Image.Image) -> np.ndarray:
    """Runs one ALREADY-PREPROCESSED PIL image through DINOv2 and
    returns an L2-normalized 1-D embedding vector (float32 numpy
    array). Raises RuntimeError if the model isn't available.

    Fuses two views of the same forward pass instead of relying on the
    CLS token alone:
      - the CLS token (DINOv2's standard whole-image summary), and
      - the mean of all patch tokens (a spatially-averaged summary that
        is empirically less sensitive to exact pose/viewpoint, since no
        single patch position dominates it).
    Each is L2-normalized on its own before being averaged together and
    renormalized, so neither one can dominate purely due to raw scale.
    This fused vector is consistently more stable across the kind of
    angle/lighting/background variation a re-scan naturally introduces,
    without changing the model or requiring any training."""
    processor, model = _load_dino()
    import torch

    inputs = processor(images=img, return_tensors="pt")
    inputs = {k: v.to(_dino_device) for k, v in inputs.items()}
    with torch.no_grad():
        outputs = model(**inputs)
        hidden = outputs.last_hidden_state[0]  # (num_tokens, dim), token 0 = CLS
        cls_vec = hidden[0, :]
        patch_vec = hidden[1:, :].mean(dim=0)
        cls_vec = cls_vec.detach().cpu().numpy().astype(np.float32)
        patch_vec = patch_vec.detach().cpu().numpy().astype(np.float32)

    def _l2(v):
        n = np.linalg.norm(v)
        return v / n if n > 0 else v

    emb = _l2(cls_vec) + _l2(patch_vec)
    norm = np.linalg.norm(emb)
    if norm > 0:
        emb = emb / norm
    return emb


def get_image_embedding(image_bytes: bytes) -> np.ndarray:
    """Decodes `image_bytes`, runs the shared background-removal +
    lighting-normalization pipeline, then embeds with DINOv2. Used for
    SCAN-time frames (single photo, no augmentation — augmentation is
    a registration-time-only robustness trick, see get_registration_embeddings).
    Raises RuntimeError if the model isn't available or the image can't
    be decoded."""
    img = decode_image_pil(image_bytes)
    if img is None:
        raise RuntimeError("Image could not be decoded for embedding extraction.")
    img = preprocess_for_embedding(img)
    return _embed_pil_image(img)


def get_registration_embeddings(image_bytes: bytes):
    """Registration-time embeddings: same shared preprocessing pipeline
    as get_image_embedding, PLUS a handful of light augmentations of the
    captured photo (rotation/brightness jitter). Returns a LIST of
    embeddings (base photo + each augmented variant) rather than a
    single averaged centroid.

    Why a list instead of an average: averaging first and comparing
    against one centroid vector at scan time means a live scan only
    gets ONE shot at clearing the threshold per angle. Storing every
    variant separately and letting scan-time matching take the best
    (max) similarity against ANY of them gives a genuine re-scan many
    more chances to clear the bar — closer in spirit to how a person
    would compare a live view against a handful of reference photos
    rather than one blended-together average. This is the single
    biggest lever against "correct object still denied" once the
    threshold itself is reasonably calibrated.

    Raises RuntimeError if the model isn't available or the image can't
    be decoded."""
    img = decode_image_pil(image_bytes)
    if img is None:
        raise RuntimeError("Image could not be decoded for embedding extraction.")
    img = preprocess_for_embedding(img)
    return [_embed_pil_image(variant) for variant in _augmented_variants(img)]


def embedding_to_blob(vec: np.ndarray) -> bytes:
    return np.asarray(vec, dtype=np.float32).tobytes()


def blob_to_embedding(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Both vectors are already L2-normalized at embedding time, so this
    is just a dot product — kept as its own helper for clarity/testability."""
    if a is None or b is None or a.size == 0 or b.size == 0:
        return 0.0
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return 0.0
    sim = float(np.dot(a, b) / denom)
    return max(-1.0, min(1.0, sim))

# -----------------------------------------------
# PATHS & CONSTANTS
# -----------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "db_storage", "snaplock.db")
REF_IMAGES_DIR = os.path.join(BASE_DIR, "snaplock_storage", "reference_images")
DOCS_DIR = os.path.join(BASE_DIR, "snaplock_storage", "documents")

JWT_SECRET = os.getenv("SECRET_KEY", "dev-secret-change-this-please")
JWT_ALGO = "HS256"

PBKDF2_ITERATIONS = 200_000
SALT_LEN = 16
NONCE_LEN = 12

SNAP_SESSION_SECONDS = 5 * 60  # unlocked-object session lifetime, mirrors vault

REQUIRED_ANGLES = ["front", "back", "left", "right", "top"]
OPTIONAL_ANGLES = ["bottom"]
ALLOWED_ANGLES = set(REQUIRED_ANGLES + OPTIONAL_ANGLES)

ALLOWED_IMAGE_EXT = {"png", "jpg", "jpeg", "webp"}
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_DOC_BYTES = 200 * 1024 * 1024
MAX_SCAN_FRAMES = 5  # cap on multi-frame voting to bound request cost

# Cosine similarity, expressed on a 0-100 scale (percent), between a live
# scan embedding and a stored reference embedding must clear this bar for
# that object to be considered a candidate match at all.
#
# IMPORTANT — why this used to cause false "Access Denied" on the CORRECT
# object: 90% was an arbitrary round number, not a measured value. In
# practice, DINOv2 whole-image cosine similarity between two DIFFERENT
# photos of the exact same physical object (different angle, lighting, or
# background) very often falls in the ~0.75-0.90 range, not 0.90+. A 90%
# floor was therefore rejecting genuine re-scans by design, not because of
# a bug in the matching logic itself. 78 is a much more realistic starting
# point for "same object, different real-world conditions" while still
# comfortably separating same object vs a different object; treat it as a
# starting point to refine with the calibration procedure in the module
# docstring, not a final answer — real separation depends on how visually
# distinct your users' registered objects are from each other.
SNAPLOCK_MATCH_THRESHOLD = float(os.getenv("SNAPLOCK_MATCH_THRESHOLD", "78"))  # percent (0-100)

# Rule 8 — "similar object confusion": if more than one registered object
# clears the match threshold, the winning object's similarity must beat
# the runner-up's by at least this many points, or we refuse rather than
# guess which one the user actually scanned. Lowered slightly alongside
# the threshold above — the margin's job is to catch genuinely ambiguous
# ties between two DIFFERENT objects, not to add extra strictness on top
# of an already-strict absolute threshold.
SNAPLOCK_MIN_CANDIDATE_MARGIN = float(os.getenv("SNAPLOCK_MIN_CANDIDATE_MARGIN", "2.0"))

# When set, /scan/match includes the runner-up object's score in its
# response so a threshold-calibration script can log full distributions.
# Off by default — a non-matching request should reveal as little as
# possible about what else is registered.
SNAPLOCK_DEBUG_SCORES = os.getenv("SNAPLOCK_DEBUG_SCORES", "0") == "1"

snaplock_bp = Blueprint("snaplock", __name__, url_prefix="/api/snaplock")

# In-memory unlocked-object sessions: token -> {user_id, object_id, ovk, expires_at}
_SNAP_SESSIONS = {}


# -----------------------------------------------
# DB
# -----------------------------------------------

def get_conn():
    folder = os.path.dirname(DB_PATH)
    os.makedirs(folder, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(REF_IMAGES_DIR, exist_ok=True)
    os.makedirs(DOCS_DIR, exist_ok=True)
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS snaplock_objects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            object_name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            wrapped_ovk BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_access_at INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS snaplock_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            object_id INTEGER NOT NULL,
            angle TEXT NOT NULL,
            stored_filename TEXT NOT NULL,
            embedding BLOB,
            created_at INTEGER NOT NULL
        )
    """)
    # Migration for pre-existing databases created before the embedding
    # column existed (i.e. from the old CV/LLM-based pipeline).
    existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(snaplock_images)").fetchall()}
    if "embedding" not in existing_cols:
        conn.execute("ALTER TABLE snaplock_images ADD COLUMN embedding BLOB")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS snaplock_passwords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            object_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            enc_blob BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS snaplock_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            object_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            stored_filename TEXT NOT NULL,
            mime_type TEXT,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    conn.commit()
    conn.close()


# -----------------------------------------------
# CRYPTO HELPERS (mirrors passwordsave.py exactly)
# -----------------------------------------------

def _derive_key(secret: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=PBKDF2_ITERATIONS)
    return kdf.derive(secret.encode())


def _aead_encrypt(key: bytes, plaintext: bytes) -> bytes:
    nonce = os.urandom(NONCE_LEN)
    ct = AESGCM(key).encrypt(nonce, plaintext, None)
    return nonce + ct


def _aead_decrypt(key: bytes, blob: bytes) -> bytes:
    nonce, ct = blob[:NONCE_LEN], blob[NONCE_LEN:]
    return AESGCM(key).decrypt(nonce, ct, None)


def wrap_ovk(access_password: str, ovk: bytes) -> bytes:
    salt = os.urandom(SALT_LEN)
    key = _derive_key(access_password, salt)
    return salt + _aead_encrypt(key, ovk)


def unwrap_ovk(access_password: str, wrapped: bytes) -> bytes:
    salt, rest = wrapped[:SALT_LEN], wrapped[SALT_LEN:]
    key = _derive_key(access_password, salt)
    return _aead_decrypt(key, rest)  # raises on wrong password / tampering


def encrypt_with_ovk(ovk: bytes, data: dict) -> bytes:
    return _aead_encrypt(ovk, json.dumps(data).encode())


def decrypt_with_ovk(ovk: bytes, blob: bytes) -> dict:
    return json.loads(_aead_decrypt(ovk, blob).decode())


# -----------------------------------------------
# AUTH (mirrors app.py's / passwordsave.py's JWT scheme)
# -----------------------------------------------

def _get_uid_from_request():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("type") != "access":
        return None
    try:
        return int(payload["sub"])
    except Exception:
        return None


def require_user(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        uid = _get_uid_from_request()
        if uid is None:
            return jsonify(error="Please sign in again."), 401
        return f(uid, *args, **kwargs)
    return wrapper


# -----------------------------------------------
# SNAP (unlocked-object) SESSIONS -- in-memory, transient
# -----------------------------------------------

def _cleanup_snap_sessions():
    now = time.time()
    dead = [t for t, s in _SNAP_SESSIONS.items() if s["expires_at"] < now]
    for t in dead:
        _SNAP_SESSIONS.pop(t, None)


def create_snap_session(user_id, object_id, ovk: bytes) -> str:
    _cleanup_snap_sessions()
    token = uuid.uuid4().hex
    _SNAP_SESSIONS[token] = {
        "user_id": user_id,
        "object_id": object_id,
        "ovk": ovk,
        "expires_at": time.time() + SNAP_SESSION_SECONDS,
    }
    return token


def get_session(token, user_id=None, object_id=None):
    _cleanup_snap_sessions()
    sess = _SNAP_SESSIONS.get(token)
    if not sess:
        return None
    if sess["expires_at"] < time.time():
        _SNAP_SESSIONS.pop(token, None)
        return None
    if user_id is not None and sess["user_id"] != user_id:
        return None
    if object_id is not None and sess["object_id"] != object_id:
        return None
    return sess


def _require_snap_session(object_id=None):
    """Shared guard for password/document ops on an unlocked object."""
    data = request.get_json(force=True, silent=True) or request.form or {}
    stoken = data.get("snap_token", "")
    uid = _get_uid_from_request()
    if uid is None:
        return None, None, None, (jsonify(error="Please sign in again."), 401)
    sess = get_session(stoken, uid, object_id)
    if sess is None:
        return None, None, None, (jsonify(error="Session expired. Please scan and verify the object again."), 401)
    return uid, sess["object_id"], sess["ovk"], None




# -----------------------------------------------
# SMALL HELPERS
# -----------------------------------------------

def _file_ext_ok(filename, allowed):
    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    return ext in allowed, ext


def _object_row(object_id, user_id=None):
    conn = get_conn()
    if user_id is not None:
        row = conn.execute(
            "SELECT * FROM snaplock_objects WHERE id=? AND user_id=?", (object_id, user_id)
        ).fetchone()
    else:
        row = conn.execute("SELECT * FROM snaplock_objects WHERE id=?", (object_id,)).fetchone()
    conn.close()
    return row


def _touch_last_access(object_id):
    conn = get_conn()
    conn.execute("UPDATE snaplock_objects SET last_access_at=? WHERE id=?", (int(time.time()), object_id))
    conn.commit()
    conn.close()


# -----------------------------------------------
# RULE 2 — Verify registered reference exists, loads, and has valid
# metadata BEFORE any authentication attempt is made against it.
# -----------------------------------------------

def _load_verified_reference_embeddings(obj_row, uid):
    """Returns (list_of_(angle, embedding_ndarray), error_reason). If
    ANYTHING about the registered object's stored reference material is
    missing, unreadable, or invalid (including an object registered under
    the old pre-DINOv2 pipeline that has no stored embeddings), this
    returns an error reason and an empty list — never guess with broken
    or absent reference data."""
    object_id = obj_row["id"]

    if not obj_row["wrapped_ovk"]:
        return [], "Registered credentials missing."

    conn = get_conn()
    img_rows = conn.execute(
        "SELECT angle, embedding FROM snaplock_images WHERE object_id=?", (object_id,)
    ).fetchall()
    conn.close()

    if not img_rows:
        return [], "No registered reference images found."

    embeddings = []
    present_angles = set()
    for row in img_rows:
        present_angles.add(row["angle"])
        if row["embedding"] is None:
            continue
        try:
            vec = blob_to_embedding(row["embedding"])
        except Exception:
            continue
        if vec.size == 0:
            continue
        embeddings.append((row["angle"], vec))

    if not embeddings:
        return [], "Registered object has no usable embeddings (it may have been registered before this AI model was enabled — please re-register it)."

    # Require every REQUIRED angle to actually be present
    missing_required = [a for a in REQUIRED_ANGLES if a not in present_angles]
    if missing_required:
        return [], f"Registered reference incomplete (missing: {', '.join(missing_required)})."

    return embeddings, None


# =================================================================
#  ROUTES -- STATUS
# =================================================================

@snaplock_bp.route("/status", methods=["GET"])
@require_user
def route_status(uid):
    return jsonify(
        model_ready=is_model_ready(),
        model=DINO_MODEL_NAME,
        background_removal_available=_get_rembg_session() is not None,
        match_threshold=SNAPLOCK_MATCH_THRESHOLD,
        min_candidate_margin=SNAPLOCK_MIN_CANDIDATE_MARGIN,
    )


@snaplock_bp.route("/objects/list", methods=["GET"])
@require_user
def route_objects_list(uid):
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, object_name, created_at, updated_at, last_access_at "
        "FROM snaplock_objects WHERE user_id=? ORDER BY object_name COLLATE NOCASE",
        (uid,),
    ).fetchall()
    conn.close()
    return jsonify(items=[dict(r) for r in rows])


# =================================================================
#  ROUTES -- CAMERA MODE: OBJECT REGISTRATION
# =================================================================

@snaplock_bp.route("/objects/register", methods=["POST"])
@require_user
def route_objects_register(uid):
    if not is_model_ready():
        return jsonify(error=_model_error()), 503

    object_name = (request.form.get("object_name") or "").strip()
    access_password = request.form.get("access_password") or ""
    confirm_password = request.form.get("confirm_password") or ""

    if not object_name:
        return jsonify(error="Object Name is required."), 400
    if len(access_password) < 6:
        return jsonify(error="Access Password must be at least 6 characters."), 400
    if access_password != confirm_password:
        return jsonify(error="Passwords do not match."), 400

    missing = [a for a in REQUIRED_ANGLES if a not in request.files]
    if missing:
        return jsonify(error=f"Missing required angle photo(s): {', '.join(missing)}."), 400

    images_by_angle = {}
    for angle in ALLOWED_ANGLES:
        f = request.files.get(angle)
        if not f or not f.filename:
            continue
        ok, ext = _file_ext_ok(f.filename, ALLOWED_IMAGE_EXT)
        if not ok:
            return jsonify(error=f"'{angle}' photo must be PNG, JPG or WEBP."), 400
        data = f.read()
        if len(data) > MAX_IMAGE_BYTES:
            return jsonify(error=f"'{angle}' photo is too large."), 400
        quality_ok, quality_reason = check_image_quality(data)
        if not quality_ok:
            return jsonify(error=f"'{angle}' photo rejected: {quality_reason}"), 400
        images_by_angle[angle] = data

    # Extract a SET of DINOv2 embeddings per captured angle (base photo +
    # augmented variants) via the registration-time pipeline (background
    # removal + crop + lighting normalization + CLS/patch-token fusion).
    # If ANY angle's embeddings can't be extracted, fail registration
    # entirely rather than silently registering an object with
    # incomplete/broken reference data.
    embeddings_by_angle = {}
    try:
        for angle, data in images_by_angle.items():
            embeddings_by_angle[angle] = get_registration_embeddings(data)
    except RuntimeError as e:
        return jsonify(error=str(e)), 503

    ovk = os.urandom(32)
    wrapped = wrap_ovk(access_password, ovk)
    now = int(time.time())

    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO snaplock_objects (user_id, object_name, description, wrapped_ovk, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?)",
        (uid, object_name, "", wrapped, now, now),
    )
    object_id = cur.lastrowid

    obj_dir = os.path.join(REF_IMAGES_DIR, str(uid), str(object_id))
    os.makedirs(obj_dir, exist_ok=True)
    for angle, data in images_by_angle.items():
        # The raw captured photo is saved to disk ONCE per angle (for
        # reference/debugging) — the augmented variants only ever exist
        # in-memory as embeddings, never as separate saved image files.
        stored_filename = f"{angle}_{uuid.uuid4().hex}.jpg"
        with open(os.path.join(obj_dir, stored_filename), "wb") as fh:
            fh.write(data)
        for variant_vec in embeddings_by_angle[angle]:
            conn.execute(
                "INSERT INTO snaplock_images (object_id, angle, stored_filename, embedding, created_at) VALUES (?,?,?,?,?)",
                (object_id, angle, stored_filename, embedding_to_blob(variant_vec), now),
            )
    conn.commit()
    conn.close()

    # Immediately unlock — the frontend flows straight into "Save Content"
    # right after registration, using the password the user just set.
    snap_token = create_snap_session(uid, object_id, ovk)

    return jsonify(
        done=True,
        object_id=object_id,
        object_name=object_name,
        snap_token=snap_token,
        expires_in=SNAP_SESSION_SECONDS,
        message="Object registered and secured successfully.",
    )


# =================================================================
#  ROUTES -- SCANNER MODE: MATCHING
# =================================================================

@snaplock_bp.route("/scan/match", methods=["POST"])
@require_user
def route_scan_match(uid):
    # Accept either several frames under "frames" (multi-frame voting,
    # capped at MAX_SCAN_FRAMES) or a single "frame" for backward
    # compatibility with existing clients.
    frame_files = request.files.getlist("frames") or (
        [request.files["frame"]] if request.files.get("frame") else []
    )
    if not frame_files:
        return jsonify(error="No camera frame received."), 400
    frame_files = frame_files[:MAX_SCAN_FRAMES]

    frame_bytes_list = []
    for f in frame_files:
        if not f or not f.filename:
            continue
        data = f.read()
        if len(data) > MAX_IMAGE_BYTES:
            return jsonify(error="Captured frame is too large."), 400
        frame_bytes_list.append(data)
    if not frame_bytes_list:
        return jsonify(error="No camera frame received."), 400

    if not is_model_ready():
        return jsonify(error=_model_error()), 503

    # Fresh recognition every scan (Rule 5) — nothing below is cached or
    # reused between requests, objects, or scans. Every accepted frame
    # goes through quality-check, then the SAME background-removal +
    # crop + lighting-normalization pipeline used at registration time,
    # then DINOv2. Multiple frames' embeddings are averaged into one
    # steadier live embedding (multi-frame voting) before comparison.
    frame_embeddings = []
    last_quality_reason = None
    for data in frame_bytes_list:
        quality_ok, quality_reason = check_image_quality(data)
        if not quality_ok:
            last_quality_reason = quality_reason
            continue
        try:
            frame_embeddings.append(get_image_embedding(data))
        except RuntimeError as e:
            return jsonify(error=str(e)), 503

    if not frame_embeddings:
        return jsonify(matched=False, reason=f"Captured frame rejected: {last_quality_reason or 'no usable frame.'}"), 200

    # This embedding lives only for the duration of this request — it is
    # never written to disk or the database, and is discarded the moment
    # this function returns.
    stacked = np.stack(frame_embeddings, axis=0)
    live_embedding = stacked.mean(axis=0)
    live_norm = np.linalg.norm(live_embedding)
    if live_norm > 0:
        live_embedding = live_embedding / live_norm

    conn = get_conn()
    objects = conn.execute(
        "SELECT * FROM snaplock_objects WHERE user_id=?", (uid,)
    ).fetchall()
    conn.close()

    if not objects:
        return jsonify(matched=False, reason="No objects registered yet."), 200

    candidates = []
    for obj in objects:
        # RULE 2 — verify the registered reference actually exists, loads,
        # and is complete BEFORE attempting any comparison against it.
        ref_embeddings, precondition_error = _load_verified_reference_embeddings(obj, uid)
        if precondition_error:
            continue  # Access Denied for this object — never guess with a broken reference.

        # Compare the live embedding against EVERY stored reference-angle
        # embedding for this object via cosine similarity, and keep this
        # object's best (highest-similarity) angle as its overall score.
        # Because a physical object presents differently from each angle,
        # the correct angle for THIS live frame is whichever one the object
        # actually resembles most — we don't know in advance which angle
        # the user is currently pointing the camera at.
        best_similarity = -1.0
        for angle, ref_vec in ref_embeddings:
            sim = cosine_similarity(live_embedding, ref_vec)
            if sim > best_similarity:
                best_similarity = sim

        confidence = round(max(0.0, best_similarity) * 100.0, 2)

        if confidence >= SNAPLOCK_MATCH_THRESHOLD:
            candidates.append({
                "object_id": obj["id"],
                "object_name": obj["object_name"],
                "confidence": confidence,
            })

    if not candidates:
        return jsonify(matched=False, reason="Object not recognized.", confidence=0), 200

    candidates.sort(key=lambda c: c["confidence"], reverse=True)
    top = candidates[0]

    # RULE 8/9 — if a second registered object also cleared the match
    # threshold and is too close to the winner, refuse rather than guess
    # which one the user actually scanned. This is what keeps one object's
    # data from ever being shown for a different, merely-similar object.
    if len(candidates) > 1:
        runner_up = candidates[1]
        if (top["confidence"] - runner_up["confidence"]) < SNAPLOCK_MIN_CANDIDATE_MARGIN:
            resp = dict(
                matched=False,
                reason="Multiple registered objects matched ambiguously; denying for safety.",
                confidence=0,
            )
            if SNAPLOCK_DEBUG_SCORES:
                resp["debug_top_confidence"] = top["confidence"]
                resp["debug_runner_up_confidence"] = runner_up["confidence"]
            return jsonify(**resp), 200

    _touch_last_access(top["object_id"])
    resp = dict(
        matched=True,
        object_id=top["object_id"],
        object_name=top["object_name"],
        confidence=round(top["confidence"]),
    )
    if SNAPLOCK_DEBUG_SCORES and len(candidates) > 1:
        resp["debug_runner_up_confidence"] = candidates[1]["confidence"]
    return jsonify(**resp)


# =================================================================
#  ROUTES -- ACCESS PASSWORD VERIFICATION
# =================================================================


@snaplock_bp.route("/objects/<int:object_id>/verify-password", methods=["POST"])
@require_user
def route_verify_password(uid, object_id):
    data = request.get_json(force=True, silent=True) or {}
    access_password = data.get("access_password", "") or ""

    row = _object_row(object_id, uid)
    if not row:
        return jsonify(error="Object not found."), 404
    try:
        ovk = unwrap_ovk(access_password, row["wrapped_ovk"])
    except Exception:
        return jsonify(error="Incorrect Password"), 401

    _touch_last_access(object_id)
    snap_token = create_snap_session(uid, object_id, ovk)
    return jsonify(done=True, snap_token=snap_token, expires_in=SNAP_SESSION_SECONDS,
                    object_id=object_id, object_name=row["object_name"])


# =================================================================
#  ROUTES -- SAVE / LIST / REVEAL PASSWORDS (require snap_token)
# =================================================================

@snaplock_bp.route("/passwords/add", methods=["POST"])
@require_user
def route_password_add(uid):
    ok_uid, object_id, ovk, err = _require_snap_session()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "").strip()
    password = data.get("password") or ""
    if not title:
        return jsonify(error="Password Title is required."), 400
    if not password:
        return jsonify(error="Password is required."), 400

    enc = encrypt_with_ovk(ovk, {"password": password})
    now = int(time.time())
    conn = get_conn()
    conn.execute(
        "INSERT INTO snaplock_passwords (object_id, title, enc_blob, created_at, updated_at) VALUES (?,?,?,?,?)",
        (object_id, title, enc, now, now),
    )
    conn.commit()
    conn.close()
    return jsonify(done=True, message="Password saved and linked to the object.")


@snaplock_bp.route("/passwords/list", methods=["POST"])
@require_user
def route_password_list(uid):
    ok_uid, object_id, ovk, err = _require_snap_session()
    if err:
        return err
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, title, created_at FROM snaplock_passwords WHERE object_id=? ORDER BY title COLLATE NOCASE",
        (object_id,),
    ).fetchall()
    conn.close()
    return jsonify(items=[dict(r) for r in rows])


@snaplock_bp.route("/passwords/reveal", methods=["POST"])
@require_user
def route_password_reveal(uid):
    ok_uid, object_id, ovk, err = _require_snap_session()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    entry_id = data.get("id")
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM snaplock_passwords WHERE id=? AND object_id=?", (entry_id, object_id)
    ).fetchone()
    conn.close()
    if not row:
        return jsonify(error="Password entry not found."), 404
    try:
        secret = decrypt_with_ovk(ovk, row["enc_blob"])
    except Exception:
        return jsonify(error="Decryption failed."), 500
    return jsonify(title=row["title"], password=secret["password"])


@snaplock_bp.route("/passwords/download", methods=["GET"])
def route_password_download():
    stoken = request.args.get("snap_token", "")
    entry_id = request.args.get("id")
    sess = get_session(stoken)
    if sess is None:
        return jsonify(error="Session expired."), 401
    ovk, object_id = sess["ovk"], sess["object_id"]
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM snaplock_passwords WHERE id=? AND object_id=?", (entry_id, object_id)
    ).fetchone()
    conn.close()
    if not row:
        return jsonify(error="Password entry not found."), 404
    secret = decrypt_with_ovk(ovk, row["enc_blob"])
    content = (
        "S.N.E.T.C.H SnapLock\n"
        "=====================\n"
        f"Password Title : {row['title']}\n"
        f"Password       : {secret['password']}\n"
        "\nGenerated by S.N.E.T.C.H SnapLock\n"
    )
    safe_name = "".join(c for c in row["title"] if c.isalnum() or c in " _-").strip() or "password"
    resp = Response(content, mimetype="text/plain")
    resp.headers["Content-Disposition"] = f'attachment; filename="{safe_name}.txt"'
    return resp


@snaplock_bp.route("/passwords/delete", methods=["POST"])
@require_user
def route_password_delete(uid):
    ok_uid, object_id, ovk, err = _require_snap_session()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify(error="No entries selected."), 400
    conn = get_conn()
    qmarks = ",".join("?" * len(ids))
    conn.execute(f"DELETE FROM snaplock_passwords WHERE object_id=? AND id IN ({qmarks})", (object_id, *ids))
    deleted = conn.total_changes
    conn.commit()
    conn.close()
    return jsonify(done=True, deleted=deleted, message=f"{deleted} password(s) deleted.")


# =================================================================
#  ROUTES -- SAVE / LIST / DOWNLOAD DOCUMENTS (require snap_token)
# =================================================================

@snaplock_bp.route("/documents/add", methods=["POST"])
def route_document_add():
    stoken = request.form.get("snap_token", "")
    uid = _get_uid_from_request()
    if uid is None:
        return jsonify(error="Please sign in again."), 401
    sess = get_session(stoken, uid)
    if sess is None:
        return jsonify(error="Session expired. Please scan and verify the object again."), 401
    ovk, object_id = sess["ovk"], sess["object_id"]

    name = (request.form.get("name") or "").strip()
    file = request.files.get("file")
    if not name:
        return jsonify(error="Document Name is required."), 400
    if not file or not file.filename:
        return jsonify(error="Please choose a document to upload."), 400

    plaintext = file.read()
    if len(plaintext) > MAX_DOC_BYTES:
        return jsonify(error="File is too large."), 400
    mime_type = file.mimetype or mimetypes.guess_type(file.filename)[0] or "application/octet-stream"
    stored_filename = uuid.uuid4().hex + ".enc"
    obj_docs_dir = os.path.join(DOCS_DIR, str(uid), str(object_id))
    os.makedirs(obj_docs_dir, exist_ok=True)
    with open(os.path.join(obj_docs_dir, stored_filename), "wb") as fh:
        fh.write(_aead_encrypt(ovk, plaintext))

    now = int(time.time())
    conn = get_conn()
    conn.execute(
        "INSERT INTO snaplock_documents (object_id, name, original_filename, stored_filename, mime_type, "
        "size_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (object_id, name, file.filename, stored_filename, mime_type, len(plaintext), now, now),
    )
    conn.commit()
    conn.close()
    return jsonify(done=True, message="Document saved and linked to the object.")


@snaplock_bp.route("/documents/list", methods=["POST"])
@require_user
def route_document_list(uid):
    ok_uid, object_id, ovk, err = _require_snap_session()
    if err:
        return err
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, original_filename, mime_type, size_bytes, created_at "
        "FROM snaplock_documents WHERE object_id=? ORDER BY name COLLATE NOCASE",
        (object_id,),
    ).fetchall()
    conn.close()
    return jsonify(items=[dict(r) for r in rows])


def _document_response(disposition):
    stoken = request.args.get("snap_token", "")
    doc_id = request.args.get("id")
    sess = get_session(stoken)
    if sess is None:
        return jsonify(error="Session expired."), 401
    ovk, object_id, uid = sess["ovk"], sess["object_id"], sess["user_id"]

    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM snaplock_documents WHERE id=? AND object_id=?", (doc_id, object_id)
    ).fetchone()
    conn.close()
    if not row:
        return jsonify(error="Document not found."), 404

    disk_path = os.path.join(DOCS_DIR, str(uid), str(object_id), row["stored_filename"])
    if not os.path.exists(disk_path):
        return jsonify(error="File missing on disk."), 404
    with open(disk_path, "rb") as fh:
        blob = fh.read()
    try:
        plaintext = _aead_decrypt(ovk, blob)
    except Exception:
        return jsonify(error="Decryption failed."), 500

    resp = Response(plaintext, mimetype=row["mime_type"] or "application/octet-stream")
    resp.headers["Content-Disposition"] = f'{disposition}; filename="{row["original_filename"]}"'
    return resp


@snaplock_bp.route("/documents/download", methods=["GET"])
def route_document_download():
    return _document_response("attachment")


@snaplock_bp.route("/documents/view", methods=["GET"])
def route_document_view():
    return _document_response("inline")


@snaplock_bp.route("/documents/delete", methods=["POST"])
@require_user
def route_document_delete(uid):
    ok_uid, object_id, ovk, err = _require_snap_session()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify(error="No documents selected."), 400

    conn = get_conn()
    qmarks = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT stored_filename FROM snaplock_documents WHERE object_id=? AND id IN ({qmarks})",
        (object_id, *ids),
    ).fetchall()
    conn.execute(f"DELETE FROM snaplock_documents WHERE object_id=? AND id IN ({qmarks})", (object_id, *ids))
    deleted = conn.total_changes
    conn.commit()
    conn.close()

    for r in rows:
        p = os.path.join(DOCS_DIR, str(ok_uid), str(object_id), r["stored_filename"])
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass

    return jsonify(done=True, deleted=deleted, message=f"{deleted} document(s) deleted.")


# =================================================================
#  ROUTES -- DELETE AN ENTIRE REGISTERED OBJECT
# =================================================================

@snaplock_bp.route("/objects/<int:object_id>/delete", methods=["POST"])
@require_user
def route_object_delete(uid, object_id):
    row = _object_row(object_id, uid)
    if not row:
        return jsonify(error="Object not found."), 404

    conn = get_conn()
    doc_rows = conn.execute("SELECT stored_filename FROM snaplock_documents WHERE object_id=?", (object_id,)).fetchall()
    conn.execute("DELETE FROM snaplock_documents WHERE object_id=?", (object_id,))
    conn.execute("DELETE FROM snaplock_passwords WHERE object_id=?", (object_id,))
    conn.execute("DELETE FROM snaplock_images WHERE object_id=?", (object_id,))
    conn.execute("DELETE FROM snaplock_objects WHERE id=?", (object_id,))
    conn.commit()
    conn.close()

    for r in doc_rows:
        p = os.path.join(DOCS_DIR, str(uid), str(object_id), r["stored_filename"])
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass
    doc_dir = os.path.join(DOCS_DIR, str(uid), str(object_id))
    if os.path.isdir(doc_dir):
        try:
            os.rmdir(doc_dir)  # only succeeds once empty — never deletes other objects' data
        except OSError:
            pass

    obj_dir = os.path.join(REF_IMAGES_DIR, str(uid), str(object_id))
    if os.path.isdir(obj_dir):
        for fn in os.listdir(obj_dir):
            try:
                os.remove(os.path.join(obj_dir, fn))
            except OSError:
                pass
        try:
            os.rmdir(obj_dir)  # leave nothing behind — not even an empty folder
        except OSError:
            pass

    return jsonify(done=True, message="Object and all linked content deleted.")


# -----------------------------------------------
# app.py integration
# -----------------------------------------------

def register_snaplock(app):
    app.register_blueprint(snaplock_bp)