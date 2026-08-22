"""
db.py — SQLite layer for S.N.E.T.C.H
Handles: users table, OTP codes (email verify + password reset), reset tokens,
         user settings, and user-feature entity mapping for multi-user isolation.
Uses only Python's built-in sqlite3, so no extra dependency needed.
"""

import sqlite3
import os
import time
import uuid
import json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "db_storage", "snetch.db")

# Default settings for every new user
DEFAULT_USER_SETTINGS = {
    "theme": "dark",
    "theme_color": "Neon Purple",
    "font_size": "Medium",
    "language": "English",
    "animations": True,
    "sound_effects": True,
    "notifications": True,
    "reminders_notify": True,
    "default_home": "Dashboard",
    "privacy": "Strict",
    "auto_backup": True,
}


def get_conn():
    folder = os.path.dirname(DB_PATH)
    if os.path.exists(folder) and not os.path.isdir(folder):
        os.remove(folder)  # stray file with this name, clear it
    os.makedirs(folder, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT,
            google_id TEXT,
            is_verified INTEGER NOT NULL DEFAULT 0,
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_login_at INTEGER
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS otps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            code TEXT NOT NULL,
            purpose TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS reset_tokens (
            token TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        )
    """)

    # Per-user settings (JSON blob)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id INTEGER PRIMARY KEY,
            settings_json TEXT NOT NULL DEFAULT '{}',
            updated_at INTEGER NOT NULL
        )
    """)

    # Maps (user_id, feature_name, entity_id) so we know which chats /
    # alarms / tasks / reminders / shopping-lists / sessions belong to
    # which user — without modifying the feature modules themselves.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_feature_map (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            feature TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_ufm_user_feature
        ON user_feature_map (user_id, feature)
    """)
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ufm_unique
        ON user_feature_map (user_id, feature, entity_id)
    """)

    conn.commit()

    # ── Migration: add last_login_at to existing users table if missing ──
    try:
        cur.execute("SELECT last_login_at FROM users LIMIT 1")
    except sqlite3.OperationalError:
        cur.execute("ALTER TABLE users ADD COLUMN last_login_at INTEGER")
        conn.commit()

    conn.close()


# ───────────────────────── USERS ─────────────────────────

def get_user_by_email(email):
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email.lower(),)).fetchone()
    conn.close()
    return row


def get_user_by_id(user_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return row


def create_or_update_pending_user(email, username, password_hash):
    """Used at /register. If user exists but not verified, update details and resend OTP.
    If user exists and verified -> raises ValueError."""
    email = email.lower()
    existing = get_user_by_email(email)
    conn = get_conn()
    if existing:
        if existing["is_verified"]:
            conn.close()
            raise ValueError("Email already registered")
        conn.execute(
            "UPDATE users SET username=?, password_hash=? WHERE email=?",
            (username, password_hash, email),
        )
    else:
        conn.execute(
            "INSERT INTO users (username, email, password_hash, is_verified, created_at) VALUES (?,?,?,0,?)",
            (username, email, password_hash, int(time.time())),
        )
    conn.commit()
    conn.close()


def mark_verified(email):
    conn = get_conn()
    conn.execute("UPDATE users SET is_verified=1 WHERE email=?", (email.lower(),))
    conn.commit()
    conn.close()


def set_password(email, password_hash):
    conn = get_conn()
    conn.execute("UPDATE users SET password_hash=? WHERE email=?", (password_hash, email.lower()))
    conn.commit()
    conn.close()


def update_failed_attempts(email, count):
    conn = get_conn()
    conn.execute("UPDATE users SET failed_attempts=? WHERE email=?", (count, email.lower()))
    conn.commit()
    conn.close()


def update_last_login(user_id):
    """Record the timestamp of the most recent successful login."""
    conn = get_conn()
    conn.execute("UPDATE users SET last_login_at=? WHERE id=?", (int(time.time()), user_id))
    conn.commit()
    conn.close()


def update_username(user_id, new_username):
    """Update a user's display name."""
    conn = get_conn()
    conn.execute("UPDATE users SET username=? WHERE id=?", (new_username, user_id))
    conn.commit()
    conn.close()


def link_google_login(email, google_id, name=None):
    """Used at the Google OAuth callback.
    - If the user already exists, link the Google account and log them in.
    - If the user does NOT exist, auto-create a verified account and log them in.
    Returns the user row (never None)."""
    email = email.lower()
    existing = get_user_by_email(email)
    conn = get_conn()
    if not existing:
        # Auto-create a new verified account for Google users
        username = name or email.split("@")[0]
        now = int(time.time())
        conn.execute(
            "INSERT INTO users (username, email, password_hash, google_id, is_verified, created_at, last_login_at) "
            "VALUES (?,?,NULL,?,1,?,?)",
            (username, email, google_id, now, now),
        )
        conn.commit()
        # Initialize default settings for the new user
        new_user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        conn.close()
        if new_user:
            init_user_settings(new_user["id"])
        return get_user_by_email(email)
    else:
        conn.execute(
            "UPDATE users SET google_id=?, is_verified=1 WHERE email=?",
            (google_id, email),
        )
        conn.commit()
        conn.close()
        return get_user_by_email(email)


# ───────────────────────── OTPS ─────────────────────────

def create_otp(email, code, purpose, ttl_seconds=600):
    conn = get_conn()
    # invalidate older otps of same purpose for this email
    conn.execute("DELETE FROM otps WHERE email=? AND purpose=?", (email.lower(), purpose))
    conn.execute(
        "INSERT INTO otps (email, code, purpose, expires_at, created_at) VALUES (?,?,?,?,?)",
        (email.lower(), code, purpose, int(time.time()) + ttl_seconds, int(time.time())),
    )
    conn.commit()
    conn.close()


def get_active_otp(email, purpose):
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM otps WHERE email=? AND purpose=? ORDER BY id DESC LIMIT 1",
        (email.lower(), purpose),
    ).fetchone()
    conn.close()
    return row


def bump_otp_attempts(otp_id):
    conn = get_conn()
    conn.execute("UPDATE otps SET attempts = attempts + 1 WHERE id=?", (otp_id,))
    conn.commit()
    conn.close()


def delete_otp(email, purpose):
    conn = get_conn()
    conn.execute("DELETE FROM otps WHERE email=? AND purpose=?", (email.lower(), purpose))
    conn.commit()
    conn.close()


# ───────────────────────── RESET TOKENS ─────────────────────────

def create_reset_token(email, ttl_seconds=900):
    token = uuid.uuid4().hex
    conn = get_conn()
    conn.execute(
        "INSERT INTO reset_tokens (token, email, expires_at) VALUES (?,?,?)",
        (token, email.lower(), int(time.time()) + ttl_seconds),
    )
    conn.commit()
    conn.close()
    return token


def get_reset_token(token):
    conn = get_conn()
    row = conn.execute("SELECT * FROM reset_tokens WHERE token=?", (token,)).fetchone()
    conn.close()
    return row


def delete_reset_token(token):
    conn = get_conn()
    conn.execute("DELETE FROM reset_tokens WHERE token=?", (token,))
    conn.commit()
    conn.close()


# ───────────────────────── USER SETTINGS ─────────────────────────

def init_user_settings(user_id):
    """Create default settings row for a newly registered user."""
    conn = get_conn()
    existing = conn.execute("SELECT 1 FROM user_settings WHERE user_id=?", (user_id,)).fetchone()
    if not existing:
        conn.execute(
            "INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?,?,?)",
            (user_id, json.dumps(DEFAULT_USER_SETTINGS), int(time.time())),
        )
        conn.commit()
    conn.close()


def get_user_settings(user_id):
    """Return settings dict for a user (auto-inits if missing)."""
    conn = get_conn()
    row = conn.execute("SELECT settings_json FROM user_settings WHERE user_id=?", (user_id,)).fetchone()
    conn.close()
    if not row:
        init_user_settings(user_id)
        return dict(DEFAULT_USER_SETTINGS)
    try:
        saved = json.loads(row["settings_json"])
    except (json.JSONDecodeError, TypeError):
        saved = {}
    # Merge with defaults so new keys are always present
    merged = dict(DEFAULT_USER_SETTINGS)
    merged.update(saved)
    return merged


def save_user_settings(user_id, settings_dict):
    """Persist user settings (partial update — merges with existing)."""
    current = get_user_settings(user_id)
    current.update(settings_dict)
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO user_settings (user_id, settings_json, updated_at) VALUES (?,?,?)",
        (user_id, json.dumps(current), int(time.time())),
    )
    conn.commit()
    conn.close()
    return current


# ───────────────────────── USER FEATURE MAP ─────────────────────────
# Links user_id -> (feature, entity_id) so every feature module's data
# can be filtered per-user without modifying the feature module itself.

def map_feature_entity(user_id, feature, entity_id):
    """Record that entity_id (chat/alarm/task/reminder/list/session) belongs to user_id."""
    conn = get_conn()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO user_feature_map (user_id, feature, entity_id, created_at) VALUES (?,?,?,?)",
            (user_id, feature, str(entity_id), int(time.time())),
        )
        conn.commit()
    except Exception:
        pass  # duplicate — already mapped
    conn.close()


def get_user_entities(user_id, feature):
    """Return list of entity_ids belonging to user_id for a given feature."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT entity_id FROM user_feature_map WHERE user_id=? AND feature=?",
        (user_id, feature),
    ).fetchall()
    conn.close()
    return [r["entity_id"] for r in rows]


def unmap_feature_entity(user_id, feature, entity_id):
    """Remove the mapping (e.g. when a chat is deleted)."""
    conn = get_conn()
    conn.execute(
        "DELETE FROM user_feature_map WHERE user_id=? AND feature=? AND entity_id=?",
        (user_id, feature, str(entity_id)),
    )
    conn.commit()
    conn.close()


def unmap_feature_entities(user_id, feature, entity_ids):
    """Remove multiple mappings at once."""
    if not entity_ids:
        return
    conn = get_conn()
    for eid in entity_ids:
        conn.execute(
            "DELETE FROM user_feature_map WHERE user_id=? AND feature=? AND entity_id=?",
            (user_id, feature, str(eid)),
        )
    conn.commit()
    conn.close()


def count_user_entities(user_id):
    """Count total entities across all features for a user (for profile stats)."""
    conn = get_conn()
    row = conn.execute(
        "SELECT COUNT(*) as cnt FROM user_feature_map WHERE user_id=?", (user_id,)
    ).fetchone()
    conn.close()
    return row["cnt"] if row else 0


def get_user_features_used(user_id):
    """Return set of distinct feature names used by this user."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT DISTINCT feature FROM user_feature_map WHERE user_id=?", (user_id,)
    ).fetchall()
    conn.close()
    return [r["feature"] for r in rows]
