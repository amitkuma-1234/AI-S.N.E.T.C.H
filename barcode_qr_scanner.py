"""
barcode_qr_scanner.py
----------------------
Standalone backend module for SNETCH's Barcode/QR Code Scanner feature.

Given the path to an image file, scans it for ANY barcodes or QR codes
present and returns structured information about each one found:
    - type       ("QRCODE", "EAN13", "CODE128", etc.)
    - data       (decoded text/content)
    - category   ("URL", "WiFi", "Contact (vCard)", "Email", "Phone",
                  "Plain Text", "Product Barcode", etc. -- a friendly guess
                  at what kind of content this is)
    - position   (bounding box: x, y, width, height in pixels)
    - polygon    (the exact corner points OpenCV/pyzbar found, useful later
                  for drawing an overlay box in the UI)

No Flask route / UI here yet -- per your request this is pure backend logic
you can run and test standalone first. Once you're happy it's accurate,
wiring it into app.py as a route + template/JS is a small next step.

Requirements (add to requirements.txt):
    pyzbar==0.1.9
    opencv-python-headless==4.10.0.84   (or opencv-python if you already use it)
    Pillow                              (already in your project)

System dependency (pyzbar needs the zbar shared library installed on the OS):
    Ubuntu/Debian:  sudo apt-get install libzbar0
    Windows:        pyzbar's Windows wheel bundles the DLL, usually no extra step needed
    macOS:          brew install zbar

Usage (standalone test, no Flask needed):
    python barcode_qr_scanner.py path/to/image.jpg
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from PIL import Image
from pyzbar import pyzbar
from pyzbar.pyzbar import ZBarSymbol

try:
    from flask import request, jsonify
except ImportError:
    # Flask isn't required to use scan_image()/scan_bytes() standalone
    # (e.g. running this file directly from the CLI to test it) -- it's
    # only needed by the handle_upload()/handle_webcam_frame() route
    # handlers below, which app.py calls once this is wired into SNETCH.
    request = None
    jsonify = None


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class ScanResult:
    type: str
    data: str
    category: str
    position: Dict[str, int]
    polygon: List[Dict[str, int]]
    extra: Dict[str, Any]


# ---------------------------------------------------------------------------
# Image loading / preprocessing
# ---------------------------------------------------------------------------

def _load_image_as_cv(image_path: str) -> np.ndarray:
    """Loads an image from disk as an OpenCV (BGR) array.

    Goes through Pillow first (like the rest of SNETCH does for uploads),
    then converts to RGB explicitly -- this avoids the exact "silently
    misread PNG transparency / weird color mode" class of bug we hit in
    the deepfake detector. Handles HEIC-less formats fine; if you need
    iPhone .HEIC support later, that needs an extra pillow-heif dependency.
    """
    if not os.path.isfile(image_path):
        raise FileNotFoundError(f"No such file: {image_path}")

    pil_img = Image.open(image_path)
    pil_img.load()
    pil_img = pil_img.convert("RGB")

    rgb_array = np.array(pil_img)
    bgr_array = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)
    return bgr_array


def _preprocess_variants(cv_img: np.ndarray) -> List[np.ndarray]:
    """Returns a list of preprocessed versions of the image to try scanning.

    Real-world photos of barcodes/QR codes (as opposed to clean screenshots)
    are often low-contrast, angled, or a bit blurry from a phone camera.
    Trying a few cheap variants meaningfully improves detection rate instead
    of giving up after one failed attempt on the raw image.
    """
    variants = [cv_img]

    gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
    variants.append(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))

    # Adaptive threshold -- helps with uneven lighting / glare on printed codes.
    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 5
    )
    variants.append(cv2.cvtColor(thresh, cv2.COLOR_GRAY2BGR))

    # Upscale small/low-res images -- tiny codes in a big photo are a common
    # real-world failure case for both pyzbar and OpenCV's detectors.
    h, w = cv_img.shape[:2]
    if max(h, w) < 900:
        scale = 900.0 / max(h, w)
        upscaled = cv2.resize(
            cv_img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC
        )
        variants.append(upscaled)

    return variants


# ---------------------------------------------------------------------------
# Content classification (what KIND of QR/barcode payload is this?)
# ---------------------------------------------------------------------------

def _classify_content(symbol_type: str, data: str) -> (str, Dict[str, Any]):
    """Best-effort friendly categorization of decoded content, plus any
    parsed extra fields worth surfacing in the UI later (e.g. WiFi SSID)."""
    extra: Dict[str, Any] = {}

    is_barcode_1d = symbol_type not in ("QRCODE", "DATAMATRIX", "PDF417", "AZTEC")
    if is_barcode_1d:
        return "Product Barcode", extra

    text = data.strip()
    lower = text.lower()

    if lower.startswith(("http://", "https://")):
        return "URL / Link", extra

    if lower.startswith("wifi:"):
        # Format: WIFI:T:WPA;S:MyNetwork;P:MyPassword;;
        fields = dict(re.findall(r"([A-Z]):([^;]*);", text, flags=re.IGNORECASE))
        extra = {
            "ssid": fields.get("S", ""),
            "password": fields.get("P", ""),
            "security": fields.get("T", ""),
        }
        return "WiFi Network", extra

    if lower.startswith("begin:vcard"):
        name = re.search(r"FN:(.*)", text, flags=re.IGNORECASE)
        phone = re.search(r"TEL[^:]*:(.*)", text, flags=re.IGNORECASE)
        email = re.search(r"EMAIL[^:]*:(.*)", text, flags=re.IGNORECASE)
        extra = {
            "name": name.group(1).strip() if name else "",
            "phone": phone.group(1).strip() if phone else "",
            "email": email.group(1).strip() if email else "",
        }
        return "Contact (vCard)", extra

    if lower.startswith("mailto:"):
        extra = {"email": text[7:]}
        return "Email Address", extra

    if lower.startswith("tel:"):
        extra = {"phone": text[4:]}
        return "Phone Number", extra

    if lower.startswith("smsto:") or lower.startswith("sms:"):
        return "SMS", extra

    if lower.startswith("geo:"):
        coords = text[4:].split(",")
        if len(coords) >= 2:
            extra = {"latitude": coords[0], "longitude": coords[1]}
        return "Location (GPS)", extra

    if lower.startswith("upi://pay"):
        # Common in India for UPI payment QR codes (Google Pay/PhonePe/Paytm)
        from urllib.parse import unquote

        params = dict(re.findall(r"[?&]([^=&]+)=([^&]*)", text))
        extra = {
            "payee": unquote(params.get("pn", "")),
            "upi_id": params.get("pa", ""),
            "amount": params.get("am", ""),
        }
        return "UPI Payment", extra

    return "Plain Text", extra


# ---------------------------------------------------------------------------
# Core scan logic
# ---------------------------------------------------------------------------

def _decode_with_pyzbar(cv_img: np.ndarray) -> List[Any]:
    """pyzbar handles both QR codes and most 1D barcode formats (EAN, UPC,
    Code128, Code39, etc.) in a single pass."""
    return pyzbar.decode(cv_img)


def _decode_qr_with_opencv(cv_img: np.ndarray) -> List[Dict[str, Any]]:
    """OpenCV's built-in QR detector as a second opinion / fallback for QR
    codes specifically -- catches a few cases pyzbar misses (e.g. certain
    perspective-distorted or curved codes), using its multi-detect API."""
    detector = cv2.QRCodeDetector()
    found: List[Dict[str, Any]] = []
    try:
        ok, decoded_texts, points, _ = detector.detectAndDecodeMulti(cv_img)
    except Exception:
        return found
    if not ok or points is None:
        return found
    for text, pts in zip(decoded_texts, points):
        if not text:
            continue
        pts = pts.astype(int)
        xs, ys = pts[:, 0], pts[:, 1]
        found.append(
            {
                "data": text,
                "x": int(xs.min()),
                "y": int(ys.min()),
                "w": int(xs.max() - xs.min()),
                "h": int(ys.max() - ys.min()),
                "polygon": [{"x": int(px), "y": int(py)} for px, py in pts],
            }
        )
    return found


def scan_image(image_path: str) -> List[ScanResult]:
    """Main entry point: scans one image file and returns every barcode /
    QR code found, deduplicated by decoded content."""
    cv_img = _load_image_as_cv(image_path)
    return _scan_cv_image(cv_img)


def scan_bytes(raw_bytes: bytes) -> List[ScanResult]:
    """Same as scan_image(), but takes raw image bytes directly (used by the
    Flask upload/webcam routes so we don't need to write a temp file to
    disk just to scan it)."""
    pil_img = Image.open(io.BytesIO(raw_bytes))
    pil_img.load()
    pil_img = pil_img.convert("RGB")
    rgb_array = np.array(pil_img)
    cv_img = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)
    return _scan_cv_image(cv_img)


def _scan_cv_image(cv_img: np.ndarray) -> List[ScanResult]:
    seen_payloads = set()
    results: List[ScanResult] = []

    # Pass 1: pyzbar across a few preprocessed variants (best coverage for
    # both QR and 1D barcodes).
    for variant in _preprocess_variants(cv_img):
        for symbol in _decode_with_pyzbar(variant):
            try:
                data = symbol.data.decode("utf-8", errors="replace")
            except Exception:
                data = str(symbol.data)

            symbol_type = str(symbol.type)
            dedup_key = (symbol_type, data)
            if dedup_key in seen_payloads:
                continue
            seen_payloads.add(dedup_key)

            rect = symbol.rect  # (left, top, width, height)
            polygon = [{"x": p.x, "y": p.y} for p in symbol.polygon]
            category, extra = _classify_content(symbol_type, data)

            results.append(
                ScanResult(
                    type=symbol_type,
                    data=data,
                    category=category,
                    position={
                        "x": rect.left,
                        "y": rect.top,
                        "width": rect.width,
                        "height": rect.height,
                    },
                    polygon=polygon,
                    extra=extra,
                )
            )

    # Pass 2: OpenCV QR fallback, only adds codes pyzbar missed entirely.
    for item in _decode_qr_with_opencv(cv_img):
        dedup_key = ("QRCODE", item["data"])
        if dedup_key in seen_payloads:
            continue
        seen_payloads.add(dedup_key)

        category, extra = _classify_content("QRCODE", item["data"])
        results.append(
            ScanResult(
                type="QRCODE",
                data=item["data"],
                category=category,
                position={
                    "x": item["x"],
                    "y": item["y"],
                    "width": item["w"],
                    "height": item["h"],
                },
                polygon=item["polygon"],
                extra=extra,
            )
        )

    return results


def _friendly_summary(category: str, data: str, extra: Dict[str, Any]) -> str:
    """One short, plain-language sentence describing what was found --
    this is what gets shown as the big headline in the UI, so it needs to
    make sense to someone who doesn't know what 'EAN13' or 'vCard' means."""
    if category == "URL / Link":
        return f"This code opens a website: {data}"
    if category == "WiFi Network":
        ssid = extra.get("ssid", "?")
        return f"This code connects to WiFi network \"{ssid}\""
    if category == "UPI Payment":
        payee = extra.get("payee") or extra.get("upi_id") or "someone"
        amount = extra.get("amount")
        if amount:
            return f"This is a payment request to {payee} for ₹{amount}"
        return f"This is a payment QR code for {payee}"
    if category == "Contact (vCard)":
        name = extra.get("name") or "a contact"
        return f"This code saves contact info for {name}"
    if category == "Email Address":
        return f"This code opens an email to: {extra.get('email', data)}"
    if category == "Phone Number":
        return f"This code dials the number: {extra.get('phone', data)}"
    if category == "SMS":
        return "This code opens a pre-filled text message"
    if category == "Location (GPS)":
        return "This code opens a map location"
    if category == "Product Barcode":
        return f"This is a product barcode, number: {data}"
    return f"This code contains text: {data}"


# ---------------------------------------------------------------------------
# Flask route handlers (called directly from app.py, same style as the
# rest of S.N.E.T.C.H's feature modules e.g. deepfake_detector.py)
# ---------------------------------------------------------------------------

ALLOWED_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_IMAGE_BYTES = 12 * 1024 * 1024  # 12 MB


def _result_to_dict(r: "ScanResult") -> Dict[str, Any]:
    d = asdict(r)
    d["summary"] = _friendly_summary(r.category, r.data, r.extra)
    return d


def _decode_data_url(data_url: str) -> bytes:
    """Strips the 'data:image/jpeg;base64,' prefix (if present) and decodes
    the base64 payload sent from the browser's live-camera capture."""
    import base64

    if "," in data_url and data_url.strip().lower().startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    return base64.b64decode(data_url)


def handle_upload():
    """POST /api/barcode_qr/scan  (multipart/form-data, field: 'image')"""
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
        results = scan_bytes(raw)
    except Exception as e:
        return jsonify({"success": False, "message": f"Could not read image file: {e}"}), 400

    return jsonify({
        "success": True,
        "count": len(results),
        "results": [_result_to_dict(r) for r in results],
    })


def handle_webcam_frame():
    """POST /api/barcode_qr/scan_webcam  JSON: { image_base64: 'data:image/jpeg;base64,...' }
    Called repeatedly (every ~700ms) by the frontend while live-scanning
    mode is active, until a code is found or the user stops."""
    data = request.get_json(silent=True) or {}
    data_url = data.get("image_base64")
    if not data_url:
        return jsonify({"success": False, "message": "No frame received."}), 400

    try:
        raw = _decode_data_url(data_url)
        if len(raw) > MAX_IMAGE_BYTES:
            return jsonify({"success": False, "message": "Frame too large."}), 400
        results = scan_bytes(raw)
    except Exception as e:
        return jsonify({"success": False, "message": f"Invalid frame data: {e}"}), 400

    return jsonify({
        "success": True,
        "count": len(results),
        "results": [_result_to_dict(r) for r in results],
    })


# ---------------------------------------------------------------------------
# Standalone CLI test entry point
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) != 2:
        print("Usage: python barcode_qr_scanner.py <path_to_image>")
        sys.exit(1)

    image_path = sys.argv[1]

    try:
        results = scan_image(image_path)
    except FileNotFoundError as e:
        print(f"Error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"Error while scanning image: {e}")
        sys.exit(1)

    if not results:
        print("No barcode or QR code found in this image.")
        return

    print(f"Found {len(results)} code(s):\n")
    for i, r in enumerate(results, start=1):
        print(f"--- Code {i} ---")
        print(json.dumps(asdict(r), indent=2, ensure_ascii=False))
        print()


if __name__ == "__main__":
    main()