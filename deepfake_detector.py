# ============================================================
# deepfake_detector.py — S.N.E.T.C.H Deepfake Detector
#
# Upload an image (or capture one live from the webcam) and get
# a "Real" vs "AI-generated / manipulated" verdict with a
# confidence score + short explanation.
#
# Two-tier detection:
#   1) Primary   -> pretrained HuggingFace image-classification
#                   model (downloaded + cached once, offline after).
#   2) Fallback  -> local heuristic (Error Level Analysis + noise
#                   statistics) used automatically if the model
#                   can't be downloaded/loaded (no internet, etc).
#
# Follows the same module pattern as the rest of S.N.E.T.C.H:
#   init_db()              -> creates this feature's own SQLite db
#   handle_*() functions   -> called directly from routes in app.py
#   g.current_user_id      -> used to scope history per logged-in user
# ============================================================

import os
import io
import uuid
import base64
import sqlite3
import datetime
import threading
import tempfile

from flask import request, jsonify, g
from PIL import Image, ImageChops
import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "db_storage", "deepfake_data.db")
UPLOAD_DIR = os.path.join(BASE_DIR, "db_storage", "deepfake_uploads")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)

MAX_IMAGE_BYTES = 12 * 1024 * 1024  # 12 MB
ALLOWED_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

MAX_VIDEO_BYTES = 80 * 1024 * 1024  # 80 MB
ALLOWED_VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi"}
VIDEO_SAMPLE_FRAMES = 6  # evenly-spaced frames analyzed per video

# HF model used when available. Swappable via env var if you prefer
# a different checkpoint later.
#
# IMPORTANT: the previous default here (dima806/deepfake_vs_real_image_detection)
# was trained ~3 years ago on an older GAN dataset. Its own model card warns
# of "concept drift" -- it was frequently calling modern, photorealistic
# Midjourney/SDXL/Flux images "real" with high confidence, because those
# generators didn't exist yet when it was trained. Switched default to a
# SigLIP2-based classifier fine-tuned specifically on modern generators
# (Midjourney, SDXL, DALL-E 3, etc). If you still see wrong verdicts on
# newer AI generators, try "prithivMLmods/Deepfake-Detect-Siglip2" or
# "Organika/sdxl-detector" instead via the DEEPFAKE_MODEL_ID env var.
# 2nd swap: the 3-class Siglip2 model's "Deepfake" head is trained for
# face-SWAP/forgery detection specifically, and was firing false-positives
# on heavily retouched studio/magazine photography (flawless skin + flat
# studio lighting reads as "deepfake-like" to that head even though the
# photo is 100% real). Organika/sdxl-detector is a simple binary
# AI-generated-vs-human classifier (no face-forgery semantics baked in) and
# is specifically tuned for photorealistic/non-artistic imagery, which
# matches this feature's actual use case much better.
# NOTE: this checkpoint is CC-BY-NC-3.0 licensed (non-commercial use only).
HF_MODEL_ID = os.getenv("DEEPFAKE_MODEL_ID", "Organika/sdxl-detector")


# ------------------------------------------------------------
# DB
# ------------------------------------------------------------
def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = _connect()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS deepfake_scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            source TEXT NOT NULL,            -- 'upload' | 'webcam'
            stored_filename TEXT,
            verdict TEXT NOT NULL,           -- 'real' | 'fake' | 'uncertain'
            confidence REAL NOT NULL,        -- 0..100
            method TEXT NOT NULL,            -- 'model' | 'heuristic'
            details TEXT,
            created_at TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()


def _log_scan(user_id, source, stored_filename, verdict, confidence, method, details):
    conn = _connect()
    conn.execute(
        """INSERT INTO deepfake_scans
           (user_id, source, stored_filename, verdict, confidence, method, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (user_id, source, stored_filename, verdict, confidence, method, details,
         datetime.datetime.utcnow().isoformat()),
    )
    conn.commit()
    row_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    conn.close()
    return row_id


# ------------------------------------------------------------
# MODEL (lazy-loaded, mirrors snaplock.py's DINOv2 loading style)
# ------------------------------------------------------------
_pipe = None
_pipe_lock = threading.Lock()
_pipe_load_failed = False


def _get_pipeline():
    """Lazily loads the HF image-classification pipeline once.
    Returns None (permanently, for this process) if it can't be loaded,
    so callers fall back to the heuristic detector instead of retrying
    a slow network call on every single request."""
    global _pipe, _pipe_load_failed
    if _pipe is not None or _pipe_load_failed:
        return _pipe
    with _pipe_lock:
        if _pipe is not None or _pipe_load_failed:
            return _pipe
        try:
            from transformers import pipeline
            # top_k=None forces the pipeline to always return the score for
            # EVERY class label (not just the single top prediction). Some
            # transformers versions default image-classification top_k to 1,
            # which silently broke the "fake vs real" label lookup below
            # (only one label came back, so the fake/real comparison logic
            # could never see both scores).
            _pipe = pipeline("image-classification", model=HF_MODEL_ID, top_k=None)
            id2label = getattr(getattr(_pipe, "model", None), "config", None)
            id2label = getattr(id2label, "id2label", {})
            print(f"[deepfake_detector] Model '{HF_MODEL_ID}' loaded OK. Labels: {id2label}")
        except Exception:
            import traceback
            print("[deepfake_detector] Model unavailable, using heuristic fallback. "
                  "Full error below (check internet access / model id / disk space):")
            traceback.print_exc()
            _pipe_load_failed = True
            _pipe = None
    return _pipe


# ------------------------------------------------------------
# HEURISTIC FALLBACK — Error Level Analysis + noise-consistency
# (No internet / no model needed. Not as strong as a trained
#  classifier, but flags common re-compression / splicing / GAN
#  artifacts reasonably well and is instant + fully offline.)
# ------------------------------------------------------------
def _heuristic_score(pil_img: Image.Image):
    # NOTE: this heuristic ONLY runs when the HF model above could not be
    # loaded (no internet on first run, model id typo, etc). Check your
    # server console for a "[deepfake_detector] Model unavailable" message —
    # if you're seeing that, THAT is almost always the real reason every
    # image (including obvious AI ones) was being called "real": the old
    # version of this heuristic was calibrated far too conservatively and
    # essentially never crossed the "fake" threshold on any input.
    img = pil_img.convert("RGB")

    # --- Error Level Analysis: re-save at fixed JPEG quality, diff ---
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    buf.seek(0)
    resaved = Image.open(buf)
    ela = ImageChops.difference(img, resaved)
    ela_arr = np.asarray(ela).astype(np.float32)
    ela_mean = float(ela_arr.mean())
    ela_std = float(ela_arr.std())

    # --- High-frequency noise consistency across quadrants ---
    gray = np.asarray(img.convert("L")).astype(np.float32)
    h, w = gray.shape
    mid_h, mid_w = h // 2, w // 2
    quads = [
        gray[:mid_h, :mid_w], gray[:mid_h, mid_w:],
        gray[mid_h:, :mid_w], gray[mid_h:, mid_w:],
    ]
    quad_noise_std = [float(np.std(q - np.mean(q))) for q in quads if q.size > 0]
    noise_variance_spread = float(np.std(quad_noise_std)) if quad_noise_std else 0.0

    # --- FFT high-frequency energy ratio ---
    # Real camera photos have sensor noise spread fairly evenly across all
    # frequencies. Most GAN/diffusion generators (upsampling layers) leave a
    # comparatively "too clean" high-frequency band or periodic grid
    # artifacts. This ratio tends to be a stronger/more stable signal than
    # ELA alone, especially for lossless PNG input (where ELA is almost
    # meaningless since there was no prior JPEG compression to detect).
    f = np.fft.fft2(gray)
    fshift = np.fft.fftshift(f)
    mag = np.abs(fshift)
    hh, ww = mag.shape
    cy, cx = hh // 2, ww // 2
    radius = min(hh, ww) // 6  # low-frequency circle radius
    yy, xx = np.ogrid[:hh, :ww]
    dist = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    low_mask = dist <= radius
    high_mask = ~low_mask
    low_energy = float(mag[low_mask].sum())
    high_energy = float(mag[high_mask].sum())
    high_freq_ratio = high_energy / (low_energy + high_energy + 1e-6)  # 0..1

    # --- Combine into a 0..100 "fake likelihood" score ---
    # Recalibrated thresholds (the previous denominators, e.g. ela_std/35,
    # were tuned so high that ordinary photos never produced a fake_score
    # above ~15-20, which meant the "fake" cutoff of 65 was essentially
    # unreachable and everything defaulted to "real" with high confidence).
    ela_score = min(100.0, (ela_std / 14.0) * 100.0)
    noise_score = min(100.0, (noise_variance_spread / 6.0) * 100.0)
    # Unusually LOW high-frequency ratio (too-smooth/synthetic texture) is
    # suspicious, so we score distance from a "normal photo" baseline (~0.35)
    # in either direction, weighted toward the too-smooth side.
    freq_deviation = 0.35 - high_freq_ratio
    freq_score = min(100.0, max(0.0, freq_deviation * 260.0))

    fake_likelihood = round(0.4 * ela_score + 0.25 * noise_score + 0.35 * freq_score, 1)
    fake_likelihood = max(0.0, min(100.0, fake_likelihood))

    details = (
        f"[heuristic-fallback] ELA std={ela_std:.2f}, ELA mean={ela_mean:.2f}, "
        f"noise-spread={noise_variance_spread:.2f}, high-freq ratio={high_freq_ratio:.3f}"
    )
    return fake_likelihood, details


# Any label containing one of these substrings is treated as the "REAL" class.
# Checked BEFORE the fake-keyword list below, because some checkpoints (e.g.
# dima806/deepfake_vs_real_image_detection -> {"AiArtData", "RealArt"}) have
# a "real" label that does NOT contain "ai"/"fake", while the FAKE label
# ("AiArtData") does contain the substring "ai" — so a naive single-pass
# "does this key contain a fake-ish word" scan can mis-fire on ambiguous
# labels. Resolving REAL vs FAKE explicitly, in a fixed priority order,
# removes that ambiguity.
_REAL_KEYWORDS = ("real", "authentic", "genuine", "human", "pristine")
_FAKE_KEYWORDS = ("fake", "deepfake", "synthetic", "generated", "gan", "spoof", "ai", "artificial")


def _classify_with_model(pil_img: Image.Image, pipe):
    results = pipe(pil_img)  # e.g. [{label:'Real',score:.9}, {label:'AI',score:.05}, {label:'Deepfake',score:.05}]
    if not results:
        raise ValueError("Model returned no predictions.")

    # Handles BOTH 2-class (Real/Fake) and 3-class (Real/AI/Deepfake -- e.g.
    # the current default model) checkpoints generically: every label that
    # matches a "fake-ish" keyword gets SUMMED together (not overwritten),
    # so a 3-class model that splits its probability mass across "AI" and
    # "Deepfake" doesn't lose part of that signal.
    fake_sum = 0.0
    real_sum = 0.0
    matched_any = False
    for r in results:
        label = r["label"].strip().lower()
        is_real = any(k in label for k in _REAL_KEYWORDS)
        is_fake = any(k in label for k in _FAKE_KEYWORDS)
        if is_real and not is_fake:
            real_sum += r["score"]
            matched_any = True
        elif is_fake and not is_real:
            fake_sum += r["score"]
            matched_any = True

    if not matched_any:
        # Totally unrecognized label scheme (e.g. LABEL_0/LABEL_1). Assume
        # index 0 is "fake"/negative class per common HF convention, but
        # this is a last-resort guess — log it so it's easy to spot.
        top = max(results, key=lambda r: r["score"])
        fake_sum = top["score"] if top["label"].strip().upper() in ("LABEL_0", "0") else 1 - top["score"]
        real_sum = 1.0 - fake_sum
        print(f"[deepfake_detector] WARNING: unrecognized label scheme {[r['label'] for r in results]}, "
              f"guessing label polarity — please check HF_MODEL_ID's id2label mapping.")

    total = fake_sum + real_sum
    fake_score = (fake_sum / total) if total > 0 else fake_sum
    fake_likelihood = round(fake_score * 100.0, 1)
    details = ", ".join(f"{r['label']}={r['score']*100:.1f}%" for r in results)
    return fake_likelihood, details


def _analyze(pil_img: Image.Image):
    pipe = _get_pipeline()
    if pipe is not None:
        try:
            fake_likelihood, details = _classify_with_model(pil_img, pipe)
            method = "model"
        except Exception:
            import traceback
            print("[deepfake_detector] Model inference failed, using heuristic. Full error below:")
            traceback.print_exc()
            fake_likelihood, details = _heuristic_score(pil_img)
            method = "heuristic"
    else:
        fake_likelihood, details = _heuristic_score(pil_img)
        method = "heuristic"

    real_likelihood = round(100.0 - fake_likelihood, 1)
    if fake_likelihood >= 65:
        verdict = "fake"
    elif fake_likelihood <= 35:
        verdict = "real"
    else:
        verdict = "uncertain"

    confidence = max(fake_likelihood, real_likelihood)
    # Always logged to console -- makes debugging verdicts trivial without
    # having to reproduce the request or dig through the DB history.
    print(f"[deepfake_detector] verdict={verdict} confidence={confidence}% "
          f"method={method} | {details}")
    return {
        "verdict": verdict,
        "confidence": confidence,
        "real_score": real_likelihood,
        "fake_score": fake_likelihood,
        "method": method,
        "details": details,
    }


# ------------------------------------------------------------
# HELPERS
# ------------------------------------------------------------
def _decode_data_url(data_url: str) -> bytes:
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    return base64.b64decode(data_url)


def _load_image_from_bytes(raw: bytes) -> Image.Image:
    return Image.open(io.BytesIO(raw))


def _save_copy(raw: bytes, ext: str) -> str:
    fname = f"{uuid.uuid4().hex}{ext}"
    with open(os.path.join(UPLOAD_DIR, fname), "wb") as f:
        f.write(raw)
    return fname


def _sample_frames_from_video(path, num_frames=VIDEO_SAMPLE_FRAMES):
    """Opens a video with OpenCV and returns up to `num_frames` evenly
    spaced PIL images sampled across its duration."""
    import cv2  # already a project dependency (used by face_expression.py / objecttracking.py)

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("Could not open video file.")

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    frames = []
    if total <= 0:
        # Frame count unknown (some containers) — just read sequentially.
        count = 0
        while count < num_frames:
            ok, frame = cap.read()
            if not ok:
                break
            frames.append(frame)
            count += 1
    else:
        indices = np.linspace(0, max(total - 1, 0), num=min(num_frames, total), dtype=int)
        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
            ok, frame = cap.read()
            if ok:
                frames.append(frame)
    cap.release()

    if not frames:
        raise RuntimeError("Could not extract any frames from this video.")

    pil_frames = []
    for frame in frames:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        pil_frames.append(Image.fromarray(rgb))
    return pil_frames


def _current_user_id():
    try:
        return g.current_user_id
    except Exception:
        return None


# ------------------------------------------------------------
# ROUTE HANDLERS (called directly from app.py, same style as
# horoscopeapi.py / dailytask.py etc.)
# ------------------------------------------------------------
def handle_upload():
    """POST /api/deepfake/analyze  (multipart/form-data, field: 'image')"""
    if "image" not in request.files:
        return jsonify({"success": False, "message": "No image uploaded."}), 400

    file = request.files["image"]
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTS:
        return jsonify({"success": False, "message": "Unsupported file type. Use JPG/PNG/WEBP."}), 400

    raw = file.read()
    if len(raw) > MAX_IMAGE_BYTES:
        return jsonify({"success": False, "message": "Image too large (max 12MB)."}), 400

    try:
        img = _load_image_from_bytes(raw)
        img.verify()
        img = _load_image_from_bytes(raw)  # verify() consumes the stream; reload
        # IMPORTANT: convert to RGB before classification. PNG uploads with
        # an alpha channel (RGBA) or CMYK JPEGs were being fed straight into
        # the HF processor. Depending on the transformers/Pillow version,
        # that either errors out (silently caught -> heuristic fallback) or
        # gets auto-flattened onto a BLACK background, which reliably reads
        # as a "fake/synthetic" texture to the classifier -- a likely cause
        # of real photos (especially PNGs, e.g. from screenshots or WhatsApp)
        # being scored as fake.
        img = img.convert("RGB")
    except Exception:
        return jsonify({"success": False, "message": "Could not read image file."}), 400

    result = _analyze(img)
    stored_filename = _save_copy(raw, ext)
    scan_id = _log_scan(_current_user_id(), "upload", stored_filename,
                         result["verdict"], result["confidence"],
                         result["method"], result["details"])

    result["scan_id"] = scan_id
    result["success"] = True
    return jsonify(result)


def handle_webcam_frame():
    """POST /api/deepfake/analyze_webcam  JSON: { image_base64: 'data:image/jpeg;base64,...' }"""
    data = request.get_json(silent=True) or {}
    data_url = data.get("image_base64")
    if not data_url:
        return jsonify({"success": False, "message": "No frame received."}), 400

    try:
        raw = _decode_data_url(data_url)
        if len(raw) > MAX_IMAGE_BYTES:
            return jsonify({"success": False, "message": "Frame too large."}), 400
        img = _load_image_from_bytes(raw)
        img.load()
        img = img.convert("RGB")
    except Exception:
        return jsonify({"success": False, "message": "Invalid frame data."}), 400

    result = _analyze(img)
    stored_filename = _save_copy(raw, ".jpg")
    scan_id = _log_scan(_current_user_id(), "webcam", stored_filename,
                         result["verdict"], result["confidence"],
                         result["method"], result["details"])

    result["scan_id"] = scan_id
    result["success"] = True
    return jsonify(result)


def handle_video_upload():
    """POST /api/deepfake/analyze_video  (multipart/form-data, field: 'video')
    Samples several evenly-spaced frames, analyzes each, and returns the
    aggregated (worst-case-weighted) verdict."""
    if "video" not in request.files:
        return jsonify({"success": False, "message": "No video uploaded."}), 400

    file = request.files["video"]
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_VIDEO_EXTS:
        return jsonify({"success": False, "message": "Unsupported video type. Use MP4/MOV/WEBM/MKV/AVI."}), 400

    raw = file.read()
    if len(raw) > MAX_VIDEO_BYTES:
        return jsonify({"success": False, "message": "Video too large (max 80MB)."}), 400

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name

        frames = _sample_frames_from_video(tmp_path)
        frame_results = [_analyze(f) for f in frames]

        fake_scores = [r["fake_score"] for r in frame_results]
        avg_fake = round(float(np.mean(fake_scores)), 1)
        max_fake = round(float(np.max(fake_scores)), 1)
        # Weight toward the most-suspicious frame so a single manipulated
        # segment isn't diluted away by many clean frames.
        combined_fake = round(0.5 * avg_fake + 0.5 * max_fake, 1)
        combined_real = round(100.0 - combined_fake, 1)

        if combined_fake >= 65:
            verdict = "fake"
        elif combined_fake <= 35:
            verdict = "real"
        else:
            verdict = "uncertain"

        method = frame_results[0]["method"]  # 'model' or 'heuristic' (same for all frames in a run)
        details = (
            f"{len(frame_results)} frames sampled · avg fake={avg_fake}% · "
            f"most suspicious frame={max_fake}%"
        )

        # Save the most suspicious frame as the stored thumbnail for history/preview.
        worst_idx = int(np.argmax(fake_scores))
        thumb_buf = io.BytesIO()
        frames[worst_idx].convert("RGB").save(thumb_buf, "JPEG", quality=88)
        stored_filename = _save_copy(thumb_buf.getvalue(), ".jpg")

        scan_id = _log_scan(_current_user_id(), "video", stored_filename,
                             verdict, max(combined_fake, combined_real), method, details)

        return jsonify({
            "success": True,
            "scan_id": scan_id,
            "verdict": verdict,
            "confidence": max(combined_fake, combined_real),
            "real_score": combined_real,
            "fake_score": combined_fake,
            "method": method,
            "details": details,
            "frames_analyzed": len(frame_results),
        })
    except Exception as e:
        return jsonify({"success": False, "message": f"Could not analyze video: {e}"}), 400
    finally:
        if tmp_path and os.path.isfile(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def handle_history():
    """GET /api/deepfake/history"""
    uid = _current_user_id()
    conn = _connect()
    rows = conn.execute(
        """SELECT id, source, verdict, confidence, method, created_at
           FROM deepfake_scans WHERE user_id IS ? ORDER BY id DESC LIMIT 50""",
        (uid,),
    ).fetchall()
    conn.close()
    return jsonify({"success": True, "history": [dict(r) for r in rows]})


def handle_delete(scan_id):
    """DELETE /api/deepfake/history/<scan_id>"""
    uid = _current_user_id()
    conn = _connect()
    row = conn.execute(
        "SELECT stored_filename FROM deepfake_scans WHERE id=? AND user_id IS ?",
        (scan_id, uid),
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"success": False, "message": "Scan not found."}), 404
    conn.execute("DELETE FROM deepfake_scans WHERE id=? AND user_id IS ?", (scan_id, uid))
    conn.commit()
    conn.close()
    if row["stored_filename"]:
        path = os.path.join(UPLOAD_DIR, row["stored_filename"])
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass
    return jsonify({"success": True})