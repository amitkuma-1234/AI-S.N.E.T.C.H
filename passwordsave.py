"""
passwordsave.py — S.N.E.T.C.H Password Vault & Secure Document Manager
=======================================================================

Flask blueprint (mounted at /api/vault) that powers the Password Vault
feature. Wired into app.py via:

    import passwordsave
    passwordsave.init_db()
    passwordsave.register_vault(app)

Design
------
Every vault entry (password / document) is encrypted with a random
per-user 256-bit "Vault Encryption Key" (VEK). The VEK itself is never
stored in the clear -- it is wrapped (encrypted) twice:

  1. wrapped_vek_master   -> unwrapped using a key derived (PBKDF2-HMAC-
                              SHA256) from the user's Master Key. This is
                              the everyday unlock path.
  2. wrapped_vek_recovery -> unwrapped using a random 32-byte
                              "recovery_wrap_key" stored in the vault_master
                              row. This is what powers "Forgot Master Key"
                              -- since the user, by definition, no longer
                              knows the value needed to unwrap path (1).

Rotating the Master Key (update / forgot flows) only re-wraps the VEK --
existing encrypted passwords and documents never need to be re-encrypted.

Every sensitive read/write requires the Master Key to be re-validated.
Successful validation ("unlock") issues a short-lived, in-memory
"vault session token" (5 minutes) that scopes the subsequent list /
add / show / update / delete calls for that menu -- the raw Master Key
itself is never persisted anywhere, only the transient VEK, in server
memory, for the lifetime of that token.
"""

import os
import time
import uuid
import json
import base64
import hashlib
import sqlite3
import mimetypes
from functools import wraps

import jwt
from flask import Blueprint, request, jsonify, Response

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

import email_utils

# -----------------------------------------------
# PATHS & CONSTANTS
# -----------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "db_storage", "vault.db")
DOCS_DIR = os.path.join(BASE_DIR, "vault_storage", "documents")

JWT_SECRET = os.getenv("SECRET_KEY", "dev-secret-change-this-please")
JWT_ALGO = "HS256"

PBKDF2_ITERATIONS = 200_000
SALT_LEN = 16
NONCE_LEN = 12

OTP_EXPIRY_SECONDS = 10 * 60      # 10 minutes, per spec
VAULT_SESSION_SECONDS = 5 * 60    # unlock lasts 5 minutes
PENDING_EXPIRY_SECONDS = 20 * 60  # abandoned flows self-clean

vault_bp = Blueprint("vault", __name__, url_prefix="/api/vault")

# In-memory unlocked-vault sessions: token -> {user_id, vek, expires_at}
_VAULT_SESSIONS = {}

# Server-side pepper used ONLY to encrypt transient data held between an
# OTP being sent and being verified (e.g. the unwrapped VEK while a
# Master Key rotation is pending). Never used for actual vault data.
_SERVER_KEY = hashlib.sha256(("vault::" + JWT_SECRET).encode()).digest()


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
    os.makedirs(DOCS_DIR, exist_ok=True)
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS vault_master (
            user_id INTEGER PRIMARY KEY,
            wrapped_vek_master BLOB NOT NULL,
            recovery_wrap_key BLOB NOT NULL,
            wrapped_vek_recovery BLOB NOT NULL,
            recovery_email TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS vault_pending (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            purpose TEXT NOT NULL,
            payload BLOB,
            target_email TEXT,
            otp_code TEXT,
            otp_expires_at INTEGER,
            otp_attempts INTEGER NOT NULL DEFAULT 0,
            otp_verified INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS vault_passwords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            enc_blob BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS vault_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
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
# CRYPTO HELPERS
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


def wrap_with_master(master_key: str, vek: bytes) -> bytes:
    salt = os.urandom(SALT_LEN)
    key = _derive_key(master_key, salt)
    return salt + _aead_encrypt(key, vek)


def unwrap_with_master(master_key: str, wrapped: bytes) -> bytes:
    salt, rest = wrapped[:SALT_LEN], wrapped[SALT_LEN:]
    key = _derive_key(master_key, salt)
    return _aead_decrypt(key, rest)  # raises on wrong key / tampering


def wrap_with_recovery(recovery_wrap_key: bytes, vek: bytes) -> bytes:
    return _aead_encrypt(recovery_wrap_key, vek)


def unwrap_with_recovery(recovery_wrap_key: bytes, wrapped: bytes) -> bytes:
    return _aead_decrypt(recovery_wrap_key, wrapped)


def encrypt_with_vek(vek: bytes, data: dict) -> bytes:
    return _aead_encrypt(vek, json.dumps(data).encode())


def decrypt_with_vek(vek: bytes, blob: bytes) -> dict:
    return json.loads(_aead_decrypt(vek, blob).decode())


def server_seal(obj: dict) -> bytes:
    return _aead_encrypt(_SERVER_KEY, json.dumps(obj).encode())


def server_unseal(blob: bytes) -> dict:
    return json.loads(_aead_decrypt(_SERVER_KEY, blob).decode())


def gen_otp() -> str:
    return "".join(str(b % 10) for b in os.urandom(6))


def mask_email(addr: str) -> str:
    try:
        name, domain = addr.split("@", 1)
        if len(name) <= 2:
            masked = name[0] + "*"
        else:
            masked = name[0] + "*" * (len(name) - 2) + name[-1]
        return f"{masked}@{domain}"
    except Exception:
        return addr


def valid_email(addr: str) -> bool:
    return bool(addr) and "@" in addr and "." in addr.split("@")[-1] and " " not in addr


# -----------------------------------------------
# AUTH (mirrors app.py's JWT scheme, no circular import needed)
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
# MASTER-ROW HELPERS
# -----------------------------------------------

def get_master(user_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM vault_master WHERE user_id=?", (user_id,)).fetchone()
    conn.close()
    return row


def _cleanup_expired_pending():
    conn = get_conn()
    conn.execute("DELETE FROM vault_pending WHERE created_at < ?", (int(time.time()) - PENDING_EXPIRY_SECONDS,))
    conn.commit()
    conn.close()


def create_pending(user_id, purpose, payload: dict, target_email: str) -> str:
    _cleanup_expired_pending()
    token = uuid.uuid4().hex
    conn = get_conn()
    # Only one pending flow per user at a time.
    conn.execute("DELETE FROM vault_pending WHERE user_id=?", (user_id,))
    conn.execute(
        "INSERT INTO vault_pending (token, user_id, purpose, payload, target_email, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (token, user_id, purpose, server_seal(payload), target_email, int(time.time())),
    )
    conn.commit()
    conn.close()
    return token


def set_pending_otp(token, code):
    conn = get_conn()
    conn.execute(
        "UPDATE vault_pending SET otp_code=?, otp_expires_at=?, otp_attempts=0, otp_verified=0 WHERE token=?",
        (code, int(time.time()) + OTP_EXPIRY_SECONDS, token),
    )
    conn.commit()
    conn.close()


def get_pending(user_id, token):
    conn = get_conn()
    row = conn.execute("SELECT * FROM vault_pending WHERE token=? AND user_id=?", (token, user_id)).fetchone()
    conn.close()
    return row


def delete_pending(token):
    conn = get_conn()
    conn.execute("DELETE FROM vault_pending WHERE token=?", (token,))
    conn.commit()
    conn.close()


def send_otp_to_pending(row):
    email_utils.send_otp_email(row["target_email"], row["otp_code"], purpose="vault_otp")


# -----------------------------------------------
# VAULT (unlock) SESSIONS -- in-memory, transient
# -----------------------------------------------

def _cleanup_vault_sessions():
    now = time.time()
    dead = [t for t, s in _VAULT_SESSIONS.items() if s["expires_at"] < now]
    for t in dead:
        _VAULT_SESSIONS.pop(t, None)


def create_vault_session(user_id, vek: bytes) -> str:
    _cleanup_vault_sessions()
    token = uuid.uuid4().hex
    _VAULT_SESSIONS[token] = {
        "user_id": user_id,
        "vek": vek,
        "expires_at": time.time() + VAULT_SESSION_SECONDS,
    }
    return token


def get_vek_for_session(token, user_id=None):
    """Returns vek bytes if the session is valid (and, if user_id given,
    matches). Returns None otherwise."""
    _cleanup_vault_sessions()
    sess = _VAULT_SESSIONS.get(token)
    if not sess:
        return None
    if sess["expires_at"] < time.time():
        _VAULT_SESSIONS.pop(token, None)
        return None
    if user_id is not None and sess["user_id"] != user_id:
        return None
    return sess["vek"]


# =================================================================
#  ROUTES -- STATUS
# =================================================================

@vault_bp.route("/status", methods=["GET"])
@require_user
def route_status(uid):
    row = get_master(uid)
    return jsonify(
        has_master_key=bool(row),
        recovery_email=(mask_email(row["recovery_email"]) if row else None),
    )


# =================================================================
#  ROUTES -- MASTER KEY: CREATE
# =================================================================

@vault_bp.route("/master/create/start", methods=["POST"])
@require_user
def route_create_start(uid):
    data = request.get_json(force=True, silent=True) or {}
    master_key = data.get("master_key", "") or ""
    recovery_email = (data.get("recovery_email") or "").strip()

    if get_master(uid):
        return jsonify(error="A Master Key already exists. Use Update instead."), 400
    if len(master_key) < 10:
        return jsonify(error="Master Key must be at least 10 characters."), 400
    if not valid_email(recovery_email):
        return jsonify(error="Enter a valid recovery email address."), 400

    vek = os.urandom(32)
    wrapped_master = wrap_with_master(master_key, vek)
    recovery_wrap_key = os.urandom(32)
    wrapped_recovery = wrap_with_recovery(recovery_wrap_key, vek)

    payload = {
        "wrapped_vek_master": base64.b64encode(wrapped_master).decode(),
        "recovery_wrap_key": base64.b64encode(recovery_wrap_key).decode(),
        "wrapped_vek_recovery": base64.b64encode(wrapped_recovery).decode(),
        "recovery_email": recovery_email,
    }
    token = create_pending(uid, "create_master", payload, recovery_email)
    code = gen_otp()
    set_pending_otp(token, code)
    email_utils.send_otp_email(recovery_email, code, purpose="vault_otp")
    return jsonify(token=token, message=f"OTP sent to {mask_email(recovery_email)}.")


# =================================================================
#  ROUTES -- MASTER KEY: UPDATE (existing key known)
# =================================================================

@vault_bp.route("/master/update/start", methods=["POST"])
@require_user
def route_update_start(uid):
    data = request.get_json(force=True, silent=True) or {}
    current_master_key = data.get("current_master_key", "") or ""

    row = get_master(uid)
    if not row:
        return jsonify(error="No Master Key exists yet. Please create one first."), 400
    try:
        vek = unwrap_with_master(current_master_key, row["wrapped_vek_master"])
    except Exception:
        return jsonify(error="Incorrect current Master Key."), 401

    payload = {"vek": base64.b64encode(vek).decode()}
    target_email = row["recovery_email"]
    token = create_pending(uid, "update_master", payload, target_email)
    code = gen_otp()
    set_pending_otp(token, code)
    email_utils.send_otp_email(target_email, code, purpose="vault_otp")
    return jsonify(token=token, message=f"OTP sent to {mask_email(target_email)}.")


# =================================================================
#  ROUTES -- MASTER KEY: FORGOT (no current key needed)
# =================================================================

@vault_bp.route("/master/forgot/start", methods=["POST"])
@require_user
def route_forgot_start(uid):
    data = request.get_json(force=True, silent=True) or {}
    recovery_email = (data.get("recovery_email") or "").strip()

    row = get_master(uid)
    if not row:
        return jsonify(error="No Master Key exists yet. Please create one first."), 400
    if recovery_email.lower() != (row["recovery_email"] or "").lower():
        return jsonify(error="That email does not match our records."), 401

    try:
        vek = unwrap_with_recovery(row["recovery_wrap_key"], row["wrapped_vek_recovery"])
    except Exception:
        return jsonify(error="Recovery data is corrupted. Please contact support."), 500

    payload = {"vek": base64.b64encode(vek).decode()}
    token = create_pending(uid, "forgot_master", payload, row["recovery_email"])
    code = gen_otp()
    set_pending_otp(token, code)
    email_utils.send_otp_email(row["recovery_email"], code, purpose="vault_otp")
    return jsonify(token=token, message=f"OTP sent to {mask_email(row['recovery_email'])}.")


# =================================================================
#  ROUTES -- MASTER KEY: set-new (shared by update + forgot)
# =================================================================

@vault_bp.route("/master/set-new", methods=["POST"])
@require_user
def route_master_set_new(uid):
    data = request.get_json(force=True, silent=True) or {}
    token = data.get("token", "")
    new_master_key = data.get("new_master_key", "") or ""

    row = get_pending(uid, token)
    if not row or row["purpose"] not in ("update_master", "forgot_master"):
        return jsonify(error="This session has expired. Please start again."), 400
    if not row["otp_verified"]:
        return jsonify(error="Please verify the OTP first."), 400
    if len(new_master_key) < 10:
        return jsonify(error="New Master Key must be at least 10 characters."), 400

    payload = server_unseal(row["payload"])
    vek = base64.b64decode(payload["vek"])
    wrapped_master = wrap_with_master(new_master_key, vek)

    conn = get_conn()
    conn.execute(
        "UPDATE vault_master SET wrapped_vek_master=?, updated_at=? WHERE user_id=?",
        (wrapped_master, int(time.time()), uid),
    )
    conn.commit()
    conn.close()
    delete_pending(token)
    return jsonify(done=True, message="Master Key updated successfully.")


# =================================================================
#  ROUTES -- UPDATE RECOVERY EMAIL
# =================================================================

@vault_bp.route("/email/start", methods=["POST"])
@require_user
def route_email_start(uid):
    data = request.get_json(force=True, silent=True) or {}
    current_master_key = data.get("current_master_key", "") or ""
    new_recovery_email = (data.get("new_recovery_email") or "").strip()

    row = get_master(uid)
    if not row:
        return jsonify(error="No Master Key exists yet. Please create one first."), 400
    try:
        unwrap_with_master(current_master_key, row["wrapped_vek_master"])
    except Exception:
        return jsonify(error="Incorrect Master Key."), 401
    if not valid_email(new_recovery_email):
        return jsonify(error="Enter a valid email address."), 400

    token = create_pending(uid, "update_email", {}, new_recovery_email)
    code = gen_otp()
    set_pending_otp(token, code)
    email_utils.send_otp_email(new_recovery_email, code, purpose="vault_otp")
    return jsonify(token=token, message=f"OTP sent to {mask_email(new_recovery_email)}.")


# =================================================================
#  ROUTES -- SHARED OTP RESEND / VERIFY
# =================================================================

@vault_bp.route("/otp/resend", methods=["POST"])
@require_user
def route_otp_resend(uid):
    data = request.get_json(force=True, silent=True) or {}
    token = data.get("token", "")
    row = get_pending(uid, token)
    if not row:
        return jsonify(error="This session has expired. Please start again."), 400
    code = gen_otp()
    set_pending_otp(token, code)
    row = get_pending(uid, token)
    send_otp_to_pending(row)
    return jsonify(message=f"OTP resent to {mask_email(row['target_email'])}.")


@vault_bp.route("/otp/verify", methods=["POST"])
@require_user
def route_otp_verify(uid):
    data = request.get_json(force=True, silent=True) or {}
    token = data.get("token", "")
    otp = (data.get("otp") or "").strip()

    row = get_pending(uid, token)
    if not row:
        return jsonify(error="This session has expired. Please start again."), 400
    if not row["otp_code"] or int(row["otp_expires_at"] or 0) < int(time.time()):
        return jsonify(error="OTP has expired. Please resend."), 400
    if row["otp_attempts"] >= 5:
        delete_pending(token)
        return jsonify(error="Too many incorrect attempts. Please start again."), 429
    if otp != row["otp_code"]:
        conn = get_conn()
        conn.execute("UPDATE vault_pending SET otp_attempts=otp_attempts+1 WHERE token=?", (token,))
        conn.commit()
        conn.close()
        return jsonify(error="Incorrect OTP."), 400

    purpose = row["purpose"]

    if purpose == "create_master":
        payload = server_unseal(row["payload"])
        now = int(time.time())
        conn = get_conn()
        conn.execute(
            "INSERT INTO vault_master (user_id, wrapped_vek_master, recovery_wrap_key, "
            "wrapped_vek_recovery, recovery_email, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (
                uid,
                base64.b64decode(payload["wrapped_vek_master"]),
                base64.b64decode(payload["recovery_wrap_key"]),
                base64.b64decode(payload["wrapped_vek_recovery"]),
                payload["recovery_email"],
                now, now,
            ),
        )
        conn.commit()
        conn.close()
        delete_pending(token)
        return jsonify(done=True, message="Master Key created successfully.")

    elif purpose == "update_email":
        conn = get_conn()
        conn.execute(
            "UPDATE vault_master SET recovery_email=?, updated_at=? WHERE user_id=?",
            (row["target_email"], int(time.time()), uid),
        )
        conn.commit()
        conn.close()
        delete_pending(token)
        return jsonify(done=True, message="Recovery email updated successfully.")

    elif purpose in ("update_master", "forgot_master"):
        conn = get_conn()
        conn.execute("UPDATE vault_pending SET otp_verified=1 WHERE token=?", (token,))
        conn.commit()
        conn.close()
        return jsonify(done=False, next="set_new_key", message="OTP verified. Enter your new Master Key.")

    return jsonify(error="Unknown flow."), 400


# =================================================================
#  ROUTES -- UNLOCK (validate master key -> short-lived vault session)
# =================================================================

@vault_bp.route("/unlock", methods=["POST"])
@require_user
def route_unlock(uid):
    data = request.get_json(force=True, silent=True) or {}
    master_key = data.get("master_key", "") or ""

    row = get_master(uid)
    if not row:
        return jsonify(error="Please create a Master Key first."), 400
    try:
        vek = unwrap_with_master(master_key, row["wrapped_vek_master"])
    except Exception:
        return jsonify(error="Incorrect Master Key."), 401

    token = create_vault_session(uid, vek)
    return jsonify(vault_token=token, expires_in=VAULT_SESSION_SECONDS)


def _require_vault_session():
    """Shared guard for password/document ops. Returns (uid, vek, error)."""
    data = request.get_json(force=True, silent=True) or request.form or {}
    vtoken = data.get("vault_token", "")
    uid = _get_uid_from_request()
    if uid is None:
        return None, None, (jsonify(error="Please sign in again."), 401)
    vek = get_vek_for_session(vtoken, uid)
    if vek is None:
        return None, None, (jsonify(error="Vault session expired. Please re-enter your Master Key."), 401)
    return uid, vek, None


# =================================================================
#  ROUTES -- PASSWORDS
# =================================================================

@vault_bp.route("/passwords/list", methods=["POST"])
def route_passwords_list():
    uid, vek, err = _require_vault_session()
    if err:
        return err
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, created_at, updated_at FROM vault_passwords WHERE user_id=? ORDER BY name COLLATE NOCASE",
        (uid,),
    ).fetchall()
    conn.close()
    return jsonify(items=[dict(r) for r in rows])


@vault_bp.route("/passwords/reveal", methods=["POST"])
def route_passwords_reveal():
    uid, vek, err = _require_vault_session()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    entry_id = data.get("id")
    conn = get_conn()
    row = conn.execute("SELECT * FROM vault_passwords WHERE id=? AND user_id=?", (entry_id, uid)).fetchone()
    conn.close()
    if not row:
        return jsonify(error="Password entry not found."), 404
    try:
        secret = decrypt_with_vek(vek, row["enc_blob"])
    except Exception:
        return jsonify(error="Decryption failed."), 500
    return jsonify(name=row["name"], password=secret["password"])


@vault_bp.route("/passwords/download", methods=["GET"])
def route_passwords_download():
    vtoken = request.args.get("vault_token", "")
    entry_id = request.args.get("id")
    vek = get_vek_for_session(vtoken)
    if vek is None:
        return jsonify(error="Vault session expired."), 401
    sess = _VAULT_SESSIONS.get(vtoken)
    uid = sess["user_id"] if sess else None
    conn = get_conn()
    row = conn.execute("SELECT * FROM vault_passwords WHERE id=? AND user_id=?", (entry_id, uid)).fetchone()
    conn.close()
    if not row:
        return jsonify(error="Password entry not found."), 404
    secret = decrypt_with_vek(vek, row["enc_blob"])
    content = (
        "S.N.E.T.C.H Password Vault\n"
        "===========================\n"
        f"Password Name : {row['name']}\n"
        f"Password      : {secret['password']}\n"
    )
    safe_name = "".join(c for c in row["name"] if c.isalnum() or c in " _-").strip() or "password"
    resp = Response(content, mimetype="text/plain")
    resp.headers["Content-Disposition"] = f'attachment; filename="{safe_name}.txt"'
    return resp


@vault_bp.route("/passwords/add", methods=["POST"])
def route_passwords_add():
    uid, vek, err = _require_vault_session()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    password = data.get("password") or ""
    if not name:
        return jsonify(error="Password Name is required."), 400
    if not password:
        return jsonify(error="Password is required."), 400

    conn = get_conn()
    dup = conn.execute(
        "SELECT id FROM vault_passwords WHERE user_id=? AND name=? COLLATE NOCASE", (uid, name)
    ).fetchone()
    if dup:
        conn.close()
        return jsonify(error=f"A password named '{name}' already exists."), 400

    now = int(time.time())
    enc = encrypt_with_vek(vek, {"password": password})
    conn.execute(
        "INSERT INTO vault_passwords (user_id, name, enc_blob, created_at, updated_at) VALUES (?,?,?,?,?)",
        (uid, name, enc, now, now),
    )
    conn.commit()
    conn.close()
    return jsonify(done=True, message="Password saved.")


@vault_bp.route("/passwords/update", methods=["POST"])
def route_passwords_update():
    uid, vek, err = _require_vault_session()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    entry_id = data.get("id")
    name = (data.get("name") or "").strip()
    password = data.get("password") or ""
    if not name:
        return jsonify(error="Password Name is required."), 400
    if not password:
        return jsonify(error="Password is required."), 400

    conn = get_conn()
    row = conn.execute("SELECT id FROM vault_passwords WHERE id=? AND user_id=?", (entry_id, uid)).fetchone()
    if not row:
        conn.close()
        return jsonify(error="Password entry not found."), 404
    dup = conn.execute(
        "SELECT id FROM vault_passwords WHERE user_id=? AND name=? COLLATE NOCASE AND id != ?",
        (uid, name, entry_id),
    ).fetchone()
    if dup:
        conn.close()
        return jsonify(error=f"A password named '{name}' already exists."), 400

    enc = encrypt_with_vek(vek, {"password": password})
    conn.execute(
        "UPDATE vault_passwords SET name=?, enc_blob=?, updated_at=? WHERE id=? AND user_id=?",
        (name, enc, int(time.time()), entry_id, uid),
    )
    conn.commit()
    conn.close()
    return jsonify(done=True, message="Password updated.")


@vault_bp.route("/passwords/delete", methods=["POST"])
def route_passwords_delete():
    uid, vek, err = _require_vault_session()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify(error="No entries selected."), 400
    conn = get_conn()
    qmarks = ",".join("?" * len(ids))
    conn.execute(f"DELETE FROM vault_passwords WHERE user_id=? AND id IN ({qmarks})", (uid, *ids))
    deleted = conn.total_changes
    conn.commit()
    conn.close()
    return jsonify(done=True, deleted=deleted, message=f"{deleted} password(s) deleted.")


# =================================================================
#  ROUTES -- DOCUMENTS
# =================================================================

@vault_bp.route("/documents/list", methods=["POST"])
def route_documents_list():
    uid, vek, err = _require_vault_session()
    if err:
        return err
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, original_filename, mime_type, size_bytes, created_at, updated_at "
        "FROM vault_documents WHERE user_id=? ORDER BY name COLLATE NOCASE",
        (uid,),
    ).fetchall()
    conn.close()
    return jsonify(items=[dict(r) for r in rows])


@vault_bp.route("/documents/add", methods=["POST"])
def route_documents_add():
    vtoken = request.form.get("vault_token", "")
    uid = _get_uid_from_request()
    if uid is None:
        return jsonify(error="Please sign in again."), 401
    vek = get_vek_for_session(vtoken, uid)
    if vek is None:
        return jsonify(error="Vault session expired. Please re-enter your Master Key."), 401

    name = (request.form.get("name") or "").strip()
    file = request.files.get("file")
    if not name:
        return jsonify(error="Document Name is required."), 400
    if not file or not file.filename:
        return jsonify(error="Please choose a document to upload."), 400

    conn = get_conn()
    dup = conn.execute(
        "SELECT id FROM vault_documents WHERE user_id=? AND name=? COLLATE NOCASE", (uid, name)
    ).fetchone()
    if dup:
        conn.close()
        return jsonify(error=f"A document named '{name}' already exists."), 400

    plaintext = file.read()
    mime_type = file.mimetype or mimetypes.guess_type(file.filename)[0] or "application/octet-stream"
    stored_filename = uuid.uuid4().hex + ".enc"
    os.makedirs(os.path.join(DOCS_DIR, str(uid)), exist_ok=True)
    disk_path = os.path.join(DOCS_DIR, str(uid), stored_filename)
    with open(disk_path, "wb") as f:
        f.write(_aead_encrypt(vek, plaintext))

    now = int(time.time())
    conn.execute(
        "INSERT INTO vault_documents (user_id, name, original_filename, stored_filename, mime_type, "
        "size_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (uid, name, file.filename, stored_filename, mime_type, len(plaintext), now, now),
    )
    conn.commit()
    conn.close()
    return jsonify(done=True, message="Document saved.")


@vault_bp.route("/documents/update", methods=["POST"])
def route_documents_update():
    vtoken = request.form.get("vault_token", "")
    uid = _get_uid_from_request()
    if uid is None:
        return jsonify(error="Please sign in again."), 401
    vek = get_vek_for_session(vtoken, uid)
    if vek is None:
        return jsonify(error="Vault session expired. Please re-enter your Master Key."), 401

    doc_id = request.form.get("id")
    new_name = (request.form.get("name") or "").strip()
    file = request.files.get("file")

    conn = get_conn()
    row = conn.execute("SELECT * FROM vault_documents WHERE id=? AND user_id=?", (doc_id, uid)).fetchone()
    if not row:
        conn.close()
        return jsonify(error="Document not found."), 404

    name = new_name or row["name"]
    if name.lower() != row["name"].lower():
        dup = conn.execute(
            "SELECT id FROM vault_documents WHERE user_id=? AND name=? COLLATE NOCASE AND id != ?",
            (uid, name, doc_id),
        ).fetchone()
        if dup:
            conn.close()
            return jsonify(error=f"A document named '{name}' already exists."), 400

    stored_filename = row["stored_filename"]
    original_filename = row["original_filename"]
    mime_type = row["mime_type"]
    size_bytes = row["size_bytes"]

    if file and file.filename:
        plaintext = file.read()
        mime_type = file.mimetype or mimetypes.guess_type(file.filename)[0] or "application/octet-stream"
        old_path = os.path.join(DOCS_DIR, str(uid), row["stored_filename"])
        new_stored = uuid.uuid4().hex + ".enc"
        os.makedirs(os.path.join(DOCS_DIR, str(uid)), exist_ok=True)
        new_path = os.path.join(DOCS_DIR, str(uid), new_stored)
        with open(new_path, "wb") as f:
            f.write(_aead_encrypt(vek, plaintext))
        if os.path.exists(old_path):
            os.remove(old_path)
        stored_filename = new_stored
        original_filename = file.filename
        size_bytes = len(plaintext)

    conn.execute(
        "UPDATE vault_documents SET name=?, original_filename=?, stored_filename=?, mime_type=?, "
        "size_bytes=?, updated_at=? WHERE id=? AND user_id=?",
        (name, original_filename, stored_filename, mime_type, size_bytes, int(time.time()), doc_id, uid),
    )
    conn.commit()
    conn.close()
    return jsonify(done=True, message="Document updated.")


@vault_bp.route("/documents/delete", methods=["POST"])
def route_documents_delete():
    uid, vek, err = _require_vault_session()
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify(error="No documents selected."), 400

    conn = get_conn()
    qmarks = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT stored_filename FROM vault_documents WHERE user_id=? AND id IN ({qmarks})", (uid, *ids)
    ).fetchall()
    conn.execute(f"DELETE FROM vault_documents WHERE user_id=? AND id IN ({qmarks})", (uid, *ids))
    deleted = conn.total_changes
    conn.commit()
    conn.close()

    for r in rows:
        p = os.path.join(DOCS_DIR, str(uid), r["stored_filename"])
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass

    return jsonify(done=True, deleted=deleted, message=f"{deleted} document(s) deleted.")


def _document_response(disposition):
    vtoken = request.args.get("vault_token", "")
    doc_id = request.args.get("id")
    vek = get_vek_for_session(vtoken)
    if vek is None:
        return jsonify(error="Vault session expired."), 401
    sess = _VAULT_SESSIONS.get(vtoken)
    uid = sess["user_id"] if sess else None

    conn = get_conn()
    row = conn.execute("SELECT * FROM vault_documents WHERE id=? AND user_id=?", (doc_id, uid)).fetchone()
    conn.close()
    if not row:
        return jsonify(error="Document not found."), 404

    disk_path = os.path.join(DOCS_DIR, str(uid), row["stored_filename"])
    if not os.path.exists(disk_path):
        return jsonify(error="File missing on disk."), 404
    with open(disk_path, "rb") as f:
        blob = f.read()
    try:
        plaintext = _aead_decrypt(vek, blob)
    except Exception:
        return jsonify(error="Decryption failed."), 500

    resp = Response(plaintext, mimetype=row["mime_type"] or "application/octet-stream")
    resp.headers["Content-Disposition"] = f'{disposition}; filename="{row["original_filename"]}"'
    return resp


@vault_bp.route("/documents/download", methods=["GET"])
def route_documents_download():
    return _document_response("attachment")


@vault_bp.route("/documents/view", methods=["GET"])
def route_documents_view():
    return _document_response("inline")


# -----------------------------------------------
# app.py integration
# -----------------------------------------------

def register_vault(app):
    app.register_blueprint(vault_bp)
