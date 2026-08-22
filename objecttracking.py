# ============================================================
# objecttracking.py — S.N.E.T.C.H · Object Tracking (YOLOv11s)
# Object Detection + Tracking + Speed Estimation + Counting
#
# PLAIN HELPER MODULE — this is NOT a Flask Blueprint. Every
# @app.route(...) lives directly in app.py (same pattern as
# wheather.py's /api/wheather/* routes). This file only exposes
# plain functions that app.py's route handlers call and return
# directly. Because Flask's `request` object is a context-local
# proxy, these functions can safely use `request` even though the
# route decorator itself is in app.py.
#
# Functions app.py should wire up (see the bottom of this file
# for the exact @app.route blocks to paste into app.py):
#
#   handle_image()                    -> POST /api/objecttracking/image
#   handle_video_start()              -> POST /api/objecttracking/video/start
#   handle_video_progress(job_id)     -> GET  /api/objecttracking/video/progress/<job_id>
#   handle_video_cancel(job_id)       -> POST /api/objecttracking/video/cancel/<job_id>
#   handle_video_download(job_id)     -> GET  /api/objecttracking/video/download/<job_id>
#   handle_webcam_start()             -> POST /api/objecttracking/webcam/start
#   handle_webcam_process_frame()     -> POST /api/objecttracking/webcam/process_frame
#   handle_webcam_feed()              -> GET  /api/objecttracking/webcam/feed
#   handle_webcam_stats()             -> GET  /api/objecttracking/webcam/stats
#   handle_webcam_stop()              -> POST /api/objecttracking/webcam/stop
#
# Output files are ALSO auto-copied to the system Downloads folder,
# same behaviour as the original standalone script.
# ============================================================

import os
import math
import time
import uuid
import base64
import shutil
import threading
import traceback

import cv2
import numpy as np
from flask import request, jsonify, Response, send_file

try:
    from ultralytics import YOLO
    YOLO_OK = True
except ImportError:  # pragma: no cover - surfaced as a clean error at request time
    YOLO_OK = False


# ------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

MODEL_FOLDER = os.path.join(BASE_DIR, "models")
os.makedirs(MODEL_FOLDER, exist_ok=True)
from model_loader import ensure_model
MODEL_PATH = os.path.join(MODEL_FOLDER, "yolo11s.pt")
ensure_model(MODEL_PATH, "17jqD5FeB64m_DsbTGIl9cAT2z2cP9_CO")

WORK_DIR = os.path.join(BASE_DIR, "db_storage", "objecttracking_outputs")
os.makedirs(WORK_DIR, exist_ok=True)

# COCO dataset vehicle class IDs (highway speed sirf inhi par nikalte hain)
VEHICLE_CLASS_IDS = [1, 2, 3, 5, 7]  # bicycle, car, motorcycle, bus, truck

DEFAULT_CONF = 0.4
DEFAULT_PPM = 8  # pixels-per-meter calibration (tunable from the UI)

ALLOWED_IMAGE_EXT = {"jpg", "jpeg", "png", "webp", "bmp"}
ALLOWED_VIDEO_EXT = {"mp4", "mov", "avi", "mkv", "webm"}


# ------------------------------------------------------------
# Model — loaded once (lazily) and reused across every request
# ------------------------------------------------------------
_model = None
_model_lock = threading.Lock()


def get_model():
    global _model
    if not YOLO_OK:
        raise RuntimeError(
            "ultralytics is not installed. Run: pip install ultralytics opencv-python"
        )
    with _model_lock:
        if _model is None:
            _model = YOLO(MODEL_PATH)
    return _model


def get_downloads_folder():
    """OS ke hisaab se Downloads folder ka path nikalta hai."""
    home = os.path.expanduser("~")
    downloads = os.path.join(home, "Downloads")
    if not os.path.exists(downloads):
        os.makedirs(downloads, exist_ok=True)
    return downloads


def compute_speed_kmh(prev_x, prev_y, curr_x, curr_y, time_diff, ppm):
    """Do consecutive positions aur time gap se speed (km/h) nikalta hai."""
    if time_diff <= 0:
        return 0.0
    pixel_dist = math.hypot(curr_x - prev_x, curr_y - prev_y)
    meters = pixel_dist / ppm
    speed_mps = meters / time_diff
    return speed_mps * 3.6  # m/s -> km/h


def _ext_ok(filename, allowed):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in allowed


def _draw_box(frame, cx, cy, bw, bh, label):
    x1, y1 = int(cx - bw / 2), int(cy - bh / 2)
    x2, y2 = int(cx + bw / 2), int(cy + bh / 2)
    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
    cv2.putText(
        frame, label, (x1, max(y1 - 8, 15)),
        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2,
    )


def _draw_hud(frame, w, unique_count, current_count):
    cv2.rectangle(frame, (0, 0), (w, 40), (0, 0, 0), -1)
    cv2.putText(
        frame,
        f"Total Unique Objects: {unique_count}   Current Frame Objects: {current_count}",
        (10, 27), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2,
    )


def _json_error(exc, code=500):
    return jsonify({"ok": False, "error": str(exc) or "Internal server error"}), code


# ============================================================
# MODE 1: IMAGE — one-shot detection + class-wise count
# app.py route:  POST /api/objecttracking/image
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

        tmp_name = f"{uuid.uuid4().hex}_{file.filename}"
        tmp_path = os.path.join(WORK_DIR, tmp_name)
        file.save(tmp_path)

        try:
            model = get_model()
            results = model.predict(source=tmp_path, conf=conf, verbose=False)
            result = results[0]
            annotated = result.plot()

            counts = {}
            for box in result.boxes:
                cls_name = model.names[int(box.cls[0])]
                counts[cls_name] = counts.get(cls_name, 0) + 1

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
                "total": len(result.boxes),
                "counts": counts,
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
#   POST /api/objecttracking/video/start
#   GET  /api/objecttracking/video/progress/<job_id>
#   POST /api/objecttracking/video/cancel/<job_id>
#   GET  /api/objecttracking/video/download/<job_id>
# ============================================================
jobs = {}
jobs_lock = threading.Lock()


def _process_video_job(job_id, input_path, conf, ppm):
    with jobs_lock:
        jobs[job_id]["status"] = "processing"

    cap = None
    writer = None
    try:
        model = get_model()
        cap = cv2.VideoCapture(input_path)
        if not cap.isOpened():
            raise RuntimeError("Video open nahi ho payi. File corrupt ho sakti hai.")

        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        frame_time = 1 / fps
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

        out_path = os.path.join(WORK_DIR, f"{job_id}.mp4")
        writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

        last_position, speed_of_id, unique_ids = {}, {}, set()
        frame_count = 0

        while cap.isOpened():
            with jobs_lock:
                if jobs[job_id].get("_cancel"):
                    jobs[job_id]["status"] = "cancelled"
                    break

            ok, frame = cap.read()
            if not ok:
                break
            frame_count += 1

            results = model.track(frame, persist=True, conf=conf, verbose=False)
            result = results[0]

            if result.boxes.id is not None:
                boxes = result.boxes.xywh.cpu().numpy()
                ids = result.boxes.id.cpu().numpy().astype(int)
                classes = result.boxes.cls.cpu().numpy().astype(int)

                for box, track_id, cls_id in zip(boxes, ids, classes):
                    cx, cy, bw, bh = box
                    unique_ids.add(int(track_id))

                    speed_text = ""
                    if cls_id in VEHICLE_CLASS_IDS:
                        if track_id in last_position:
                            px, py = last_position[track_id]
                            speed = compute_speed_kmh(px, py, cx, cy, frame_time, ppm)
                            prev_speed = speed_of_id.get(track_id, speed)
                            speed = 0.7 * prev_speed + 0.3 * speed  # smoothing
                            speed_of_id[track_id] = speed
                            speed_text = f" {speed:.1f} km/h"
                        last_position[track_id] = (cx, cy)

                    label = f"{model.names[cls_id]} ID:{track_id}{speed_text}"
                    _draw_box(frame, cx, cy, bw, bh, label)

            _draw_hud(frame, w, len(unique_ids), len(result.boxes))
            writer.write(frame)

            with jobs_lock:
                job = jobs[job_id]
                job["frame_count"] = frame_count
                job["total_frames"] = total_frames
                job["unique_count"] = len(unique_ids)
                job["percent"] = round((frame_count / total_frames) * 100, 1) if total_frames else 0

        cap.release()
        writer.release()

        with jobs_lock:
            job = jobs[job_id]
            if job["status"] != "cancelled":
                job["status"] = "finished"
                job["percent"] = 100
                job["output_path"] = out_path
                job["unique_count"] = len(unique_ids)
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
        try:
            ppm = float(request.form.get("ppm", DEFAULT_PPM))
        except ValueError:
            ppm = DEFAULT_PPM

        job_id = uuid.uuid4().hex
        in_path = os.path.join(WORK_DIR, f"{job_id}_{file.filename}")
        file.save(in_path)

        with jobs_lock:
            jobs[job_id] = {
                "status": "queued", "percent": 0, "frame_count": 0,
                "total_frames": 0, "unique_count": 0, "_cancel": False,
                "output_path": None, "error": None,
            }

        threading.Thread(
            target=_process_video_job, args=(job_id, in_path, conf, ppm), daemon=True
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
# MODE 3: WEBCAM — browser owns the camera (getUserMedia), posts
# individual frames here for detection+tracking, draws the
# overlay itself using the normalized boxes we return.
# app.py routes:
#   POST /api/objecttracking/webcam/start
#   POST /api/objecttracking/webcam/process_frame
#   GET  /api/objecttracking/webcam/feed     (legacy MJPEG mode, optional)
#   GET  /api/objecttracking/webcam/stats
#   POST /api/objecttracking/webcam/stop
# ============================================================
_webcam_lock = threading.Lock()
_webcam_state = {
    "cap": None,
    "active": False,
    "unique_ids": set(),
    "last_position": {},
    "speed_of_id": {},
    "prev_time_per_id": {},
    "current_frame_objects": 0,
}


def _reset_webcam_state():
    _webcam_state["unique_ids"] = set()
    _webcam_state["last_position"] = {}
    _webcam_state["speed_of_id"] = {}
    _webcam_state["prev_time_per_id"] = {}
    _webcam_state["current_frame_objects"] = 0
    _webcam_state["next_id"] = 1


def handle_webcam_start():
    """Reset tracking state for a fresh client-side camera session."""
    with _webcam_lock:
        _webcam_state["active"] = True
        _reset_webcam_state()
    return jsonify({"ok": True})


def handle_webcam_process_frame():
    """Run detection+tracking on one frame posted by the browser.

    Expects multipart/form-data: `frame` (JPEG blob), `conf`, `ppm`.
    Returns normalized (0..1) box centers/sizes so the client can draw an
    overlay on top of its own <video> element regardless of its render size.
    """
    try:
        file = request.files.get("frame")
        if not file:
            return jsonify({"ok": False, "error": "No frame uploaded."}), 400

        try:
            conf = float(request.form.get("conf", DEFAULT_CONF))
        except ValueError:
            conf = DEFAULT_CONF
        try:
            ppm = float(request.form.get("ppm", DEFAULT_PPM))
        except ValueError:
            ppm = DEFAULT_PPM

        file_bytes = np.frombuffer(file.read(), dtype=np.uint8)
        frame = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
        if frame is None:
            return jsonify({"ok": False, "error": "Could not decode frame."}), 400

        h, w = frame.shape[:2]
        model = get_model()
        now = time.time()

        # Use predict() instead of track() to ensure ALL detections are returned, 
        # immune to tracker state/framerate issues over HTTP.
        with _model_lock:
            results = model.predict(frame, conf=conf, verbose=False)
        result = results[0]

        detections = []
        with _webcam_lock:
            if not _webcam_state["active"]:
                _webcam_state["active"] = True
                _reset_webcam_state()

            last_position = _webcam_state["last_position"]
            speed_of_id = _webcam_state["speed_of_id"]
            prev_time_per_id = _webcam_state["prev_time_per_id"]
            unique_ids = _webcam_state["unique_ids"]
            next_id = _webcam_state.get("next_id", 1)

            if len(result.boxes) > 0:
                boxes = result.boxes.xywh.cpu().numpy()
                classes = result.boxes.cls.cpu().numpy().astype(int)
                confs = result.boxes.conf.cpu().numpy()
            else:
                boxes = []
                classes = []
                confs = []

            current_positions = {}
            
            for box, cls_id, box_conf in zip(boxes, classes, confs):
                cx, cy, bw, bh = box
                
                # Simple centroid matching
                best_id = None
                best_dist = float('inf')
                
                for tid, (px, py) in last_position.items():
                    if tid in current_positions: 
                        continue
                    dist = math.hypot(cx - px, cy - py)
                    if dist < w * 0.3 and dist < best_dist:  # 30% of frame width max movement
                        best_dist = dist
                        best_id = tid
                        
                if best_id is None:
                    best_id = next_id
                    next_id += 1
                    
                current_positions[best_id] = (float(cx), float(cy))
                unique_ids.add(int(best_id))
                
                speed_kmh = 0.0
                if cls_id in VEHICLE_CLASS_IDS:
                    if best_id in last_position:
                        px, py = last_position[best_id]
                        dt = now - prev_time_per_id.get(best_id, now)
                        speed_kmh = compute_speed_kmh(px, py, cx, cy, dt, ppm)
                        prev_speed = speed_of_id.get(best_id, speed_kmh)
                        speed_kmh = 0.7 * prev_speed + 0.3 * speed_kmh
                        speed_of_id[best_id] = speed_kmh
                    prev_time_per_id[best_id] = now

                detections.append({
                    "cx": float(cx) / w, "cy": float(cy) / h,
                    "bw": float(bw) / w, "bh": float(bh) / h,
                    "cls": model.names[int(cls_id)],
                    "id": int(best_id),
                    "conf": round(float(box_conf), 2),
                    "spd": round(speed_kmh, 1),
                })
                
            _webcam_state["last_position"] = current_positions
            _webcam_state["next_id"] = next_id
            _webcam_state["current_frame_objects"] = len(detections)
            unique_count = len(unique_ids)

        return jsonify({
            "ok": True,
            "d": detections,
            "uc": unique_count,
            "fc": len(detections),
        })
    except Exception as exc:
        traceback.print_exc()
        return _json_error(exc)


def _gen_webcam_frames(camera_index, conf, ppm):
    """Legacy server-side-camera MJPEG generator (kept for optional use
    via /webcam/feed — the main UI now uses the client-capture flow
    above instead, since that works with the browser's own camera)."""
    model = get_model()

    with _webcam_lock:
        if _webcam_state["cap"] is not None:
            _webcam_state["cap"].release()
        _webcam_state["cap"] = cv2.VideoCapture(camera_index)
        _webcam_state["active"] = True
        _reset_webcam_state()
        cap = _webcam_state["cap"]

    if not cap.isOpened():
        with _webcam_lock:
            _webcam_state["active"] = False
        return

    try:
        while True:
            with _webcam_lock:
                if not _webcam_state["active"]:
                    break

            ok, frame = cap.read()
            if not ok:
                break

            now = time.time()
            results = model.track(frame, persist=True, conf=conf, verbose=False)
            result = results[0]

            with _webcam_lock:
                last_position = _webcam_state["last_position"]
                speed_of_id = _webcam_state["speed_of_id"]
                prev_time_per_id = _webcam_state["prev_time_per_id"]
                unique_ids = _webcam_state["unique_ids"]

                if result.boxes.id is not None:
                    boxes = result.boxes.xywh.cpu().numpy()
                    ids = result.boxes.id.cpu().numpy().astype(int)
                    classes = result.boxes.cls.cpu().numpy().astype(int)

                    for box, track_id, cls_id in zip(boxes, ids, classes):
                        cx, cy, bw, bh = box
                        unique_ids.add(int(track_id))

                        speed_text = ""
                        if cls_id in VEHICLE_CLASS_IDS:
                            if track_id in last_position:
                                px, py = last_position[track_id]
                                dt = now - prev_time_per_id.get(track_id, now)
                                speed = compute_speed_kmh(px, py, cx, cy, dt, ppm)
                                prev_speed = speed_of_id.get(track_id, speed)
                                speed = 0.7 * prev_speed + 0.3 * speed
                                speed_of_id[track_id] = speed
                                speed_text = f" {speed:.1f} km/h"
                            last_position[track_id] = (cx, cy)
                            prev_time_per_id[track_id] = now

                        label = f"{model.names[cls_id]} ID:{track_id}{speed_text}"
                        _draw_box(frame, cx, cy, bw, bh, label)

                _webcam_state["current_frame_objects"] = len(result.boxes)
                h, w = frame.shape[:2]
                _draw_hud(frame, w, len(unique_ids), len(result.boxes))

            _, buf = cv2.imencode(".jpg", frame)
            frame_bytes = buf.tobytes()
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + frame_bytes + b"\r\n"
            )
    finally:
        with _webcam_lock:
            if _webcam_state["cap"] is not None:
                _webcam_state["cap"].release()
            _webcam_state["cap"] = None
            _webcam_state["active"] = False


def handle_webcam_feed():
    camera_index = int(request.args.get("camera", 0))
    try:
        conf = float(request.args.get("conf", DEFAULT_CONF))
    except ValueError:
        conf = DEFAULT_CONF
    try:
        ppm = float(request.args.get("ppm", DEFAULT_PPM))
    except ValueError:
        ppm = DEFAULT_PPM

    return Response(
        _gen_webcam_frames(camera_index, conf, ppm),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


def handle_webcam_stats():
    with _webcam_lock:
        return jsonify({
            "ok": True,
            "active": _webcam_state["active"],
            "unique_count": len(_webcam_state["unique_ids"]),
            "current_frame_objects": _webcam_state["current_frame_objects"],
        })


def handle_webcam_stop():
    with _webcam_lock:
        _webcam_state["active"] = False
        if _webcam_state["cap"] is not None:
            _webcam_state["cap"].release()
            _webcam_state["cap"] = None
    return jsonify({"ok": True})


def register_object_tracking(app):
    app.add_url_rule('/api/objecttracking/image', 'ot_image', handle_image, methods=['POST'])
    app.add_url_rule('/api/objecttracking/video/start', 'ot_video_start', handle_video_start, methods=['POST'])
    app.add_url_rule('/api/objecttracking/video/progress/<job_id>', 'ot_video_progress', handle_video_progress, methods=['GET'])
    app.add_url_rule('/api/objecttracking/video/cancel/<job_id>', 'ot_video_cancel', handle_video_cancel, methods=['POST'])
    app.add_url_rule('/api/objecttracking/video/download/<job_id>', 'ot_video_download', handle_video_download, methods=['GET'])
    app.add_url_rule('/api/objecttracking/webcam/start', 'ot_webcam_start', handle_webcam_start, methods=['POST'])
    app.add_url_rule('/api/objecttracking/webcam/process_frame', 'ot_webcam_process_frame', handle_webcam_process_frame, methods=['POST'])
    app.add_url_rule('/api/objecttracking/webcam/feed', 'ot_webcam_feed', handle_webcam_feed, methods=['GET'])
    app.add_url_rule('/api/objecttracking/webcam/stats', 'ot_webcam_stats', handle_webcam_stats, methods=['GET'])
    app.add_url_rule('/api/objecttracking/webcam/stop', 'ot_webcam_stop', handle_webcam_stop, methods=['POST'])

