# ============================================================
# FLASK API LAYER — app.py se wire hone wale handler functions
# (CLI mode ke process_frame/detect_faces/predict_emotion functions
#  yahi reuse karte hain, kuch naya nahi banaya gaya)
# ============================================================

import os
import uuid
import base64
import shutil
import threading
import traceback
import cv2
import numpy as np

from flask import request, jsonify, send_file

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORK_DIR = os.path.join(BASE_DIR, "db_storage", "face_expression_outputs")
os.makedirs(WORK_DIR, exist_ok=True)

from model_loader import ensure_model

MODEL_FOLDER = os.path.join(BASE_DIR, "models")
YUNET_PATH = os.path.join(MODEL_FOLDER, "face_detection_yunet_2023mar.onnx")
EMOTION_MODEL_PATH = os.path.join(MODEL_FOLDER, "best_model.pth")
LABELS_PATH = os.path.join(MODEL_FOLDER, "labels.npy")

ensure_model(EMOTION_MODEL_PATH, "18Dn9PhUHb6BNdu_HHjGLFDl_f_RtsTm-")
ensure_model(YUNET_PATH, "17o1PRcz4QP_isryociKdkgeNlI9BBLSq")
ensure_model(LABELS_PATH, "15pJ_Y9ou5At0c5L47VvFjcy-ZtK0Tkt8")

CONFIDENCE_THRESHOLD = 0.5
DEFAULT_CONF = 0.5  # used by handle_image / handle_video_start / handle_webcam_process_frame


# ============================================================
# FACE DETECTOR — OpenCV YuNet (models/face_detection_yunet_2023mar.onnx)
# ============================================================
_yunet = None
_yunet_lock = threading.Lock()


def get_yunet():
    """Lazily loads YuNet once and reuses it across every request."""
    global _yunet
    with _yunet_lock:
        if _yunet is None:
            if not os.path.isfile(YUNET_PATH):
                raise RuntimeError(
                    f"YuNet model not found at {YUNET_PATH}. "
                    "Make sure face_detection_yunet_2023mar.onnx is inside the models/ folder."
                )
            _yunet = cv2.FaceDetectorYN.create(
                YUNET_PATH,
                "",
                (320, 320),          # placeholder input size, reset per-frame below
                score_threshold=0.5,  # lowered from 0.6 -> steadier detection on angle/lighting changes
                nms_threshold=0.3,
                top_k=5000,
            )
    return _yunet


def detect_faces(frame):
    """Runs YuNet on a BGR frame and returns rows of
    [x, y, w, h, <5 landmark x,y pairs>, score] — same raw format
    OpenCV's FaceDetectorYN.detect() returns, so face[:4] downstream
    keeps working exactly as the rest of this file expects."""
    h, w = frame.shape[:2]
    if h == 0 or w == 0:
        return []

    detector = get_yunet()
    detector.setInputSize((w, h))
    _, faces = detector.detect(frame)

    if faces is None:
        return []
    return faces


# ============================================================
# EMOTION CLASSIFIER — SwinTransformerV2 (timm) + custom head
# Reconstructed from best_model.pth's state_dict layer names/shapes:
#   backbone.*      -> timm "swinv2_base_window8_256" (num_classes=0, pooled features -> 1024-d)
#   classifier.*     -> Linear(1024->512) BN ReLU Dropout Linear(512->256) BN ReLU Dropout Linear(256->7)
# ============================================================
try:
    import torch
    import torch.nn as nn
    import timm
    TORCH_OK = True
except ImportError:  # pragma: no cover - surfaced as a clean error at request time
    TORCH_OK = False

_DEVICE = None
_emotion_model = None
_emotion_model_lock = threading.Lock()

_IMG_SIZE = 256
_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Fallback order matches models/labels.npy (['angry','disgust','fear','happy','neutral','sad','surprise'])
_DEFAULT_LABELS = ["angry", "disgust", "fear", "happy", "neutral", "sad", "surprise"]


def _load_labels():
    if os.path.isfile(LABELS_PATH):
        try:
            return [str(x) for x in np.load(LABELS_PATH, allow_pickle=True)]
        except Exception:
            pass
    return list(_DEFAULT_LABELS)


EMOTION_LABELS = _load_labels()


if TORCH_OK:
    class EmotionSwin(nn.Module):
        def __init__(self, num_classes):
            super().__init__()
            self.backbone = timm.create_model(
                "swinv2_base_window8_256", pretrained=False, num_classes=0
            )
            feat_dim = self.backbone.num_features
            self.classifier = nn.Sequential(
                nn.Linear(feat_dim, 512),
                nn.BatchNorm1d(512),
                nn.ReLU(inplace=True),
                nn.Dropout(0.3),
                nn.Linear(512, 256),
                nn.BatchNorm1d(256),
                nn.ReLU(inplace=True),
                nn.Dropout(0.3),
                nn.Linear(256, num_classes),
            )

        def forward(self, x):
            feats = self.backbone(x)
            return self.classifier(feats)


def get_emotion_model():
    global _emotion_model, _DEVICE
    if not TORCH_OK:
        raise RuntimeError(
            "torch/timm not installed. Run: pip install torch timm"
        )
    with _emotion_model_lock:
        if _emotion_model is None:
            if not os.path.isfile(EMOTION_MODEL_PATH):
                raise RuntimeError(
                    f"Emotion model not found at {EMOTION_MODEL_PATH}. "
                    "Make sure best_model.pth is inside the models/ folder."
                )
            _DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            model = EmotionSwin(num_classes=len(EMOTION_LABELS))
            state_dict = torch.load(EMOTION_MODEL_PATH, map_location=_DEVICE)
            model.load_state_dict(state_dict, strict=True)
            model.eval()
            model.to(_DEVICE)
            _emotion_model = model
    return _emotion_model


def _preprocess_face(face_crop_bgr):
    img = cv2.cvtColor(face_crop_bgr, cv2.COLOR_BGR2RGB)
    img = cv2.resize(img, (_IMG_SIZE, _IMG_SIZE), interpolation=cv2.INTER_LINEAR)
    img = img.astype(np.float32) / 255.0
    img = (img - _IMAGENET_MEAN) / _IMAGENET_STD
    img = np.transpose(img, (2, 0, 1))  # HWC -> CHW
    tensor = torch.from_numpy(img).unsqueeze(0).to(_DEVICE)
    return tensor


def predict_emotion(face_crop):
    """Returns (emotion_label:str, confidence:float 0-100)."""
    model = get_emotion_model()
    tensor = _preprocess_face(face_crop)
    with torch.no_grad():
        logits = model(tensor)
        probs = torch.softmax(logits, dim=1)[0]
        conf, idx = torch.max(probs, dim=0)
    emotion = EMOTION_LABELS[int(idx.item())]
    confidence = float(conf.item()) * 100.0
    return emotion, confidence


def draw_prediction(frame, face, emotion, confidence):
    x, y, w, h = map(int, face[:4])
    text = f"{emotion} ({confidence:.1f}%)"
    cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
    cv2.putText(frame, text, (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 0), 2)

ALLOWED_IMAGE_EXT = {"jpg", "jpeg", "png", "webp", "bmp"}
ALLOWED_VIDEO_EXT = {"mp4", "mov", "avi", "mkv", "webm"}


def _ext_ok(filename, allowed):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in allowed


def get_downloads_folder():
    home = os.path.expanduser("~")
    downloads = os.path.join(home, "Downloads")
    if not os.path.exists(downloads):
        os.makedirs(downloads, exist_ok=True)
    return downloads


def _json_error(exc, code=500):
    return jsonify({"ok": False, "error": str(exc) or "Internal server error"}), code


def _detect_with_details(frame, conf_threshold):
    """process_frame() jaisa hi kaam karta hai, par har face ka emotion +
    confidence bhi return karta hai (UI ke chips/overlay ke liye).

    NOTE: Pehle yahan sirf un faces ko draw/return kiya jata tha jinki
    *emotion* confidence slider threshold se zyada thi. Emotion confidence
    naturally frame-to-frame thoda upar-neeche hoti hai (lighting,
    compression, halka sa motion blur) — isliye jab confidence threshold
    ke aas-paas wobble karti thi, poora bounding box hi flicker karta tha
    (on/off/on/off), chahe face continuously present ho. YuNet ne face
    detect kar liya hai matlab face waha hai — isliye ab hum face ko
    hamesha draw/return karte hain. `conf_threshold` sirf ye decide karta
    hai ki emotion label ko "confident" maana jaye ya "low_confidence"."""
    detections = detect_faces(frame)
    faces_info = []

    for face in detections:
        x, y, w, h = map(int, face[:4])
        x, y = max(0, x), max(0, y)
        face_crop = frame[y:y + h, x:x + w]
        if face_crop.size == 0:
            continue

        emotion, confidence = predict_emotion(face_crop)

        draw_prediction(frame, face, emotion, confidence)
        fh, fw = frame.shape[:2]
        faces_info.append({
            "emotion": str(emotion),
            "confidence": round(float(confidence), 1),
            "low_confidence": confidence < (conf_threshold * 100),
            "cx": (x + w / 2) / fw,
            "cy": (y + h / 2) / fh,
            "bw": w / fw,
            "bh": h / fh,
        })

    return frame, faces_info


def _emotion_counts(faces_info):
    counts = {}
    for f in faces_info:
        counts[f["emotion"]] = counts.get(f["emotion"], 0) + 1
    return counts


# ============================================================
# MODE 1: IMAGE
# app.py route: POST /api/facexpression/image
# ============================================================
def handle_image():
    try:
        file = request.files.get("file")
        if not file or file.filename == "":
            return jsonify({"ok": False, "error": "No image uploaded."}), 400
        if not _ext_ok(file.filename, ALLOWED_IMAGE_EXT):
            return jsonify({"ok": False, "error": "Unsupported image format."}), 400

        try:
            conf = float(request.form.get("conf", DEFAULT_CONF))
        except ValueError:
            conf = DEFAULT_CONF

        tmp_path = os.path.join(WORK_DIR, f"{uuid.uuid4().hex}_{file.filename}")
        file.save(tmp_path)

        try:
            frame = cv2.imread(tmp_path)
            if frame is None:
                return jsonify({"ok": False, "error": "Invalid image file."}), 400

            annotated, faces_info = _detect_with_details(frame, conf)

            out_path = os.path.join(WORK_DIR, f"output_{uuid.uuid4().hex}.jpg")
            cv2.imwrite(out_path, annotated)
            try:
                shutil.copy(out_path, os.path.join(get_downloads_folder(), f"output_{file.filename}"))
            except Exception:
                pass

            _, buf = cv2.imencode(".jpg", annotated)
            b64 = base64.b64encode(buf).decode("utf-8")

            return jsonify({
                "ok": True,
                "image_base64": f"data:image/jpeg;base64,{b64}",
                "total": len(faces_info),
                "emotions": _emotion_counts(faces_info),
                "faces": faces_info,
            })
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    except Exception as exc:
        traceback.print_exc()
        return _json_error(exc)


# ============================================================
# MODE 2: VIDEO — background job + progress polling
# app.py routes:
#   POST /api/facexpression/video/start
#   GET  /api/facexpression/video/progress/<job_id>
#   POST /api/facexpression/video/cancel/<job_id>
#   GET  /api/facexpression/video/download/<job_id>
# ============================================================
jobs = {}
jobs_lock = threading.Lock()


def _process_video_job(job_id, input_path, conf):
    with jobs_lock:
        jobs[job_id]["status"] = "processing"

    cap = None
    writer = None
    try:
        cap = cv2.VideoCapture(input_path)
        if not cap.isOpened():
            raise RuntimeError("Video open nahi ho payi. File corrupt ho sakti hai.")

        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

        out_path = os.path.join(WORK_DIR, f"{job_id}.mp4")
        writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

        frame_count = 0
        emotion_totals = {}

        while cap.isOpened():
            with jobs_lock:
                if jobs[job_id].get("_cancel"):
                    jobs[job_id]["status"] = "cancelled"
                    break

            ok, frame = cap.read()
            if not ok:
                break
            frame_count += 1

            annotated, faces_info = _detect_with_details(frame, conf)
            for f in faces_info:
                emotion_totals[f["emotion"]] = emotion_totals.get(f["emotion"], 0) + 1

            writer.write(annotated)

            with jobs_lock:
                job = jobs[job_id]
                job["frame_count"] = frame_count
                job["total_frames"] = total_frames
                job["faces_detected"] = sum(emotion_totals.values())
                job["emotions"] = dict(emotion_totals)
                job["percent"] = round((frame_count / total_frames) * 100, 1) if total_frames else 0

        cap.release()
        writer.release()

        with jobs_lock:
            job = jobs[job_id]
            if job["status"] != "cancelled":
                job["status"] = "finished"
                job["percent"] = 100
                job["output_path"] = out_path
                try:
                    shutil.copy(out_path, os.path.join(get_downloads_folder(), f"output_{job_id}.mp4"))
                except Exception:
                    pass

    except Exception as exc:
        traceback.print_exc()
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = str(exc)
        if cap is not None:
            cap.release()
        if writer is not None:
            writer.release()
    finally:
        try:
            os.remove(input_path)
        except OSError:
            pass


def handle_video_start():
    try:
        file = request.files.get("file")
        if not file or file.filename == "":
            return jsonify({"ok": False, "error": "No video uploaded."}), 400
        if not _ext_ok(file.filename, ALLOWED_VIDEO_EXT):
            return jsonify({"ok": False, "error": "Unsupported video format."}), 400

        try:
            conf = float(request.form.get("conf", DEFAULT_CONF))
        except ValueError:
            conf = DEFAULT_CONF

        job_id = uuid.uuid4().hex
        in_path = os.path.join(WORK_DIR, f"{job_id}_{file.filename}")
        file.save(in_path)

        with jobs_lock:
            jobs[job_id] = {
                "status": "queued", "percent": 0, "frame_count": 0,
                "total_frames": 0, "faces_detected": 0, "emotions": {},
                "_cancel": False, "output_path": None, "error": None,
            }

        threading.Thread(
            target=_process_video_job, args=(job_id, in_path, conf), daemon=True
        ).start()

        return jsonify({"ok": True, "job_id": job_id})
    except Exception as exc:
        traceback.print_exc()
        return _json_error(exc)


def handle_video_progress(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return jsonify({"ok": False, "error": "Unknown job."}), 404
        payload = {k: v for k, v in job.items() if not k.startswith("_") and k != "output_path"}
    return jsonify({"ok": True, **payload})


def handle_video_cancel(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return jsonify({"ok": False, "error": "Unknown job."}), 404
        job["_cancel"] = True
    return jsonify({"ok": True})


def handle_video_download(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job or job.get("status") != "finished" or not job.get("output_path"):
        return jsonify({"ok": False, "error": "Output abhi ready nahi hai."}), 404
    return send_file(job["output_path"], as_attachment=True, download_name=f"output_{job_id}.mp4")


# ============================================================
# MODE 3: WEBCAM — browser getUserMedia se frame bhejta hai,
# yahan sirf detect + emotion predict hota hai, overlay drawing
# client-side JS karta hai (normalized cx/cy/bw/bh return hota hai)
# app.py routes:
#   POST /api/facexpression/webcam/start
#   POST /api/facexpression/webcam/process_frame
#   POST /api/facexpression/webcam/stop
# ============================================================
_webcam_lock = threading.Lock()
_webcam_active = False


def handle_webcam_start():
    global _webcam_active
    with _webcam_lock:
        _webcam_active = True
    return jsonify({"ok": True})


def handle_webcam_process_frame():
    try:
        blob = request.files.get("frame")
        if not blob:
            return jsonify({"ok": False, "error": "No frame received."}), 400

        try:
            conf = float(request.form.get("conf", DEFAULT_CONF))
        except ValueError:
            conf = DEFAULT_CONF

        file_bytes = np.frombuffer(blob.read(), np.uint8)
        frame = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
        if frame is None:
            return jsonify({"ok": False, "error": "Could not decode frame."}), 400

        _, faces_info = _detect_with_details(frame, conf)

        dominant = "—"
        if faces_info:
            counts = _emotion_counts(faces_info)
            dominant = max(counts, key=counts.get)

        return jsonify({
            "ok": True,
            "d": faces_info,
            "face_count": len(faces_info),
            "dominant_emotion": dominant,
        })
    except Exception as exc:
        traceback.print_exc()
        return _json_error(exc)


def handle_webcam_stop():
    global _webcam_active
    with _webcam_lock:
        _webcam_active = False
    return jsonify({"ok": True})


def register_face_expression(app):
    app.add_url_rule('/api/facexpression/image', 'fe_image', handle_image, methods=['POST'])
    app.add_url_rule('/api/facexpression/video/start', 'fe_video_start', handle_video_start, methods=['POST'])
    app.add_url_rule('/api/facexpression/video/progress/<job_id>', 'fe_video_progress', handle_video_progress, methods=['GET'])
    app.add_url_rule('/api/facexpression/video/cancel/<job_id>', 'fe_video_cancel', handle_video_cancel, methods=['POST'])
    app.add_url_rule('/api/facexpression/video/download/<job_id>', 'fe_video_download', handle_video_download, methods=['GET'])
    app.add_url_rule('/api/facexpression/webcam/start', 'fe_webcam_start', handle_webcam_start, methods=['POST'])
    app.add_url_rule('/api/facexpression/webcam/process_frame', 'fe_webcam_process_frame', handle_webcam_process_frame, methods=['POST'])
    app.add_url_rule('/api/facexpression/webcam/stop', 'fe_webcam_stop', handle_webcam_stop, methods=['POST'])