"""
shopinglist.py — S.N.E.T.C.H Shopping Planner & Grocery Management (backend module)

Self-contained Flask Blueprint for the Shopping Planner feature:
    • Shopping lists (create / rename / delete / pin / archive / search / download)
    • Natural-language item parser (quantity + unit + name, any word order,
      fractions, plurals, short-hand units like "2L" / "500gm")
    • Item CRUD (add many at once, update one, delete one/many/all)
    • Purchase tracking (mark purchased + price, auto totals)

Storage: SQLite at db_storage/shoppinglist_data.db (created automatically).

Wire this into app.py with just two lines (near the other feature imports):

    import shopinglist
    ...
    shopinglist.register_shopping_planner(app)

Nothing else in app.py needs to change — this module owns its own routes,
its own database file, and does not import or touch any other feature.
"""

import os
import re
import io
import uuid
import sqlite3
import datetime

from flask import Blueprint, request, jsonify, send_file

# ─────────────────────────────────────────────
#  Storage
# ─────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_STORAGE_DIR = os.path.join(BASE_DIR, "db_storage")
DB_PATH = os.path.join(DB_STORAGE_DIR, "shoppinglist_data.db")

shopping_bp = Blueprint("shopping_planner", __name__, url_prefix="/api/shopping")


def _get_conn():
    os.makedirs(DB_STORAGE_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    os.makedirs(DB_STORAGE_DIR, exist_ok=True)
    conn = _get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS shopping_lists (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            list_date   TEXT NOT NULL,
            pinned      INTEGER NOT NULL DEFAULT 0,
            archived    INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS shopping_items (
            id          TEXT PRIMARY KEY,
            list_id     TEXT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            qty         REAL NOT NULL DEFAULT 1,
            unit        TEXT NOT NULL DEFAULT 'piece',
            purchased   INTEGER NOT NULL DEFAULT 0,
            price       REAL NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_items_list_id ON shopping_items(list_id);
        """
    )
    conn.commit()
    conn.close()


def _now():
    return datetime.datetime.utcnow().isoformat()


# ─────────────────────────────────────────────
#  Natural-language item parser
# ─────────────────────────────────────────────

UNIT_ALIASES = {
    "kg": "kg", "kgs": "kg", "kilogram": "kg", "kilograms": "kg",
    "g": "g", "gm": "g", "gms": "g", "gram": "g", "grams": "g",
    "l": "l", "litre": "l", "litres": "l", "liter": "l", "liters": "l",
    "ml": "ml", "millilitre": "ml", "millilitres": "ml", "milliliter": "ml", "milliliters": "ml",
    "dozen": "dozen", "dozens": "dozen",
    "packet": "packet", "packets": "packet", "pack": "packet", "packs": "packet",
    "box": "box", "boxes": "box",
    "jar": "jar", "jars": "jar",
    "tube": "tube", "tubes": "tube",
    "roll": "roll", "rolls": "roll",
    "carton": "carton", "cartons": "carton",
    "sack": "sack", "sacks": "sack",
    "bag": "bag", "bags": "bag",
    "bucket": "bucket", "buckets": "bucket",
    "piece": "piece", "pieces": "piece", "pcs": "piece", "pc": "piece",
    "bottle": "bottle", "bottles": "bottle",
    "can": "can", "cans": "can",
    "loaf": "loaf", "loaves": "loaf",
    "bunch": "bunch", "bunches": "bunch",
    "tray": "tray", "trays": "tray",
}

_UNIT_TOKENS = sorted(UNIT_ALIASES.keys(), key=len, reverse=True)
UNIT_ALT = "|".join(re.escape(u) for u in _UNIT_TOKENS)

FRACTION_MAP = {
    "three quarter": 0.75, "three quarters": 0.75,
    "half": 0.5, "quarter": 0.25,
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "a": 1, "an": 1,
}
_FRACTION_TOKENS = sorted(FRACTION_MAP.keys(), key=len, reverse=True)
FRACTION_ALT = "|".join(re.escape(f).replace(r"\ ", r"\s+") for f in _FRACTION_TOKENS)

QTY = r"\d+(?:\.\d+)?"

PAT_QTY_UNIT_NAME = re.compile(rf"^({QTY})\s*({UNIT_ALT})\b\.?\s+(.+)$")
PAT_NAME_QTY_UNIT = re.compile(rf"^(.+?)\s+({QTY})\s*({UNIT_ALT})\b\.?$")
PAT_FRAC_UNIT_NAME = re.compile(rf"^({FRACTION_ALT})\s+({UNIT_ALT})\b\s+(.+)$")
PAT_UNIT_NAME = re.compile(rf"^({UNIT_ALT})\b\s+(.+)$")
PAT_QTY_NAME = re.compile(rf"^({QTY})\s+(.+)$")
PAT_NAME_QTY = re.compile(rf"^(.+?)\s+({QTY})$")


def _clean_name(name: str) -> str:
    name = re.sub(r"\s+", " ", name.strip())
    return name.title()


def _round_qty(qty):
    try:
        qty = float(qty)
    except (TypeError, ValueError):
        return 1
    return int(qty) if qty == int(qty) else round(qty, 2)


def parse_single_item(text: str):
    """Parse one natural-language item description into {name, qty, unit}."""
    raw = text.strip()
    if not raw:
        return None
    t = re.sub(r"\s+", " ", raw.lower().strip())

    m = PAT_QTY_UNIT_NAME.match(t)
    if m:
        qty = float(m.group(1))
        unit = UNIT_ALIASES[m.group(2)]
        name = m.group(3)
        return {"name": _clean_name(name), "qty": _round_qty(qty), "unit": unit}

    m = PAT_NAME_QTY_UNIT.match(t)
    if m:
        name = m.group(1)
        qty = float(m.group(2))
        unit = UNIT_ALIASES[m.group(3)]
        return {"name": _clean_name(name), "qty": _round_qty(qty), "unit": unit}

    m = PAT_FRAC_UNIT_NAME.match(t)
    if m:
        frac_key = re.sub(r"\s+", " ", m.group(1))
        qty = FRACTION_MAP[frac_key]
        unit = UNIT_ALIASES[m.group(2)]
        name = m.group(3)
        return {"name": _clean_name(name), "qty": _round_qty(qty), "unit": unit}

    m = PAT_UNIT_NAME.match(t)
    if m:
        unit = UNIT_ALIASES[m.group(1)]
        name = m.group(2)
        return {"name": _clean_name(name), "qty": 1, "unit": unit}

    m = PAT_QTY_NAME.match(t)
    if m:
        qty = float(m.group(1))
        name = m.group(2)
        return {"name": _clean_name(name), "qty": _round_qty(qty), "unit": "piece"}

    m = PAT_NAME_QTY.match(t)
    if m:
        name = m.group(1)
        qty = float(m.group(2))
        return {"name": _clean_name(name), "qty": _round_qty(qty), "unit": "piece"}

    return {"name": _clean_name(t), "qty": 1, "unit": "piece"}


def parse_items(text: str):
    """Split a raw textarea/input value on commas / newlines / semicolons and
    parse each piece into a structured item."""
    parts = re.split(r"[,\n;]+", text or "")
    results = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        item = parse_single_item(p)
        if item:
            results.append(item)
    return results


# ─────────────────────────────────────────────
#  Serialization helpers
# ─────────────────────────────────────────────

def _serialize_list(row, items=None):
    data = {
        "id": row["id"],
        "name": row["name"],
        "date": row["list_date"],
        "pinned": bool(row["pinned"]),
        "archived": bool(row["archived"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if items is not None:
        data["items"] = [_serialize_item(i) for i in items]
        data["summary"] = _summary(items)
    return data


def _serialize_item(row):
    return {
        "id": row["id"],
        "list_id": row["list_id"],
        "name": row["name"],
        "qty": _round_qty(row["qty"]),
        "unit": row["unit"],
        "purchased": bool(row["purchased"]),
        "price": row["price"] if row["purchased"] else 0,
    }


def _summary(items):
    total = len(items)
    purchased = sum(1 for i in items if i["purchased"])
    remaining = total - purchased
    total_cost = round(sum((i["price"] or 0) for i in items if i["purchased"]), 2)
    return {
        "total_items": total,
        "purchased_items": purchased,
        "remaining_items": remaining,
        "total_cost": total_cost,
    }


def _fetch_list(conn, list_id):
    return conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()


def _fetch_items(conn, list_id):
    rows = conn.execute(
        "SELECT * FROM shopping_items WHERE list_id = ? ORDER BY created_at ASC", (list_id,)
    ).fetchall()
    return [_serialize_item(r) for r in rows]


# ─────────────────────────────────────────────
#  Routes — Shopping Lists
# ─────────────────────────────────────────────

@shopping_bp.route("/lists", methods=["GET"])
def get_lists():
    """All non-archived lists, pinned first, most recently updated first."""
    conn = _get_conn()
    rows = conn.execute(
        """SELECT * FROM shopping_lists WHERE archived = 0
           ORDER BY pinned DESC, updated_at DESC"""
    ).fetchall()
    result = [_serialize_list(r) for r in rows]
    conn.close()
    return jsonify({"lists": result})


@shopping_bp.route("/lists/archived", methods=["GET"])
def get_archived_lists():
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM shopping_lists WHERE archived = 1 ORDER BY updated_at DESC"
    ).fetchall()
    result = [_serialize_list(r) for r in rows]
    conn.close()
    return jsonify({"lists": result})


@shopping_bp.route("/lists", methods=["POST"])
def create_list():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip() or "Untitled Shopping List"
    list_date = (data.get("date") or "").strip() or datetime.date.today().isoformat()

    conn = _get_conn()
    now = _now()
    new_id = uuid.uuid4().hex
    conn.execute(
        """INSERT INTO shopping_lists (id, name, list_date, pinned, archived, created_at, updated_at)
           VALUES (?, ?, ?, 0, 0, ?, ?)""",
        (new_id, name, list_date, now, now),
    )
    conn.commit()
    row = _fetch_list(conn, new_id)
    result = _serialize_list(row, items=[])
    conn.close()
    return jsonify({"status": "ok", "list": result}), 201


@shopping_bp.route("/lists/<list_id>", methods=["GET"])
def get_list_detail(list_id):
    conn = _get_conn()
    row = _fetch_list(conn, list_id)
    if not row:
        conn.close()
        return jsonify({"error": "Shopping list not found."}), 404
    items = conn.execute(
        "SELECT * FROM shopping_items WHERE list_id = ? ORDER BY created_at ASC", (list_id,)
    ).fetchall()
    serialized_items = [_serialize_item(i) for i in items]
    result = _serialize_list(row)
    result["items"] = serialized_items
    result["summary"] = _summary(serialized_items)
    conn.close()
    return jsonify({"list": result})


@shopping_bp.route("/lists/<list_id>", methods=["PATCH"])
def update_list(list_id):
    """Rename / pin / unpin / archive / unarchive a list."""
    data = request.get_json(force=True, silent=True) or {}
    conn = _get_conn()
    row = _fetch_list(conn, list_id)
    if not row:
        conn.close()
        return jsonify({"error": "Shopping list not found."}), 404

    fields = []
    values = []
    if "name" in data:
        new_name = (data.get("name") or "").strip()
        if not new_name:
            conn.close()
            return jsonify({"error": "Shopping list name cannot be empty."}), 400
        fields.append("name = ?")
        values.append(new_name)
    if "date" in data:
        fields.append("list_date = ?")
        values.append((data.get("date") or "").strip() or row["list_date"])
    if "pinned" in data:
        fields.append("pinned = ?")
        values.append(1 if data.get("pinned") else 0)
    if "archived" in data:
        fields.append("archived = ?")
        values.append(1 if data.get("archived") else 0)

    if not fields:
        conn.close()
        return jsonify({"error": "No valid fields to update."}), 400

    fields.append("updated_at = ?")
    values.append(_now())
    values.append(list_id)

    conn.execute(f"UPDATE shopping_lists SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    updated = _fetch_list(conn, list_id)
    result = _serialize_list(updated)
    conn.close()
    return jsonify({"status": "ok", "list": result})


@shopping_bp.route("/lists/<list_id>", methods=["DELETE"])
def delete_list(list_id):
    conn = _get_conn()
    row = _fetch_list(conn, list_id)
    if not row:
        conn.close()
        return jsonify({"error": "Shopping list not found."}), 404
    conn.execute("DELETE FROM shopping_items WHERE list_id = ?", (list_id,))
    conn.execute("DELETE FROM shopping_lists WHERE id = ?", (list_id,))
    conn.commit()
    conn.close()
    return jsonify({"status": "ok", "deleted_id": list_id})


@shopping_bp.route("/lists/<list_id>/download", methods=["GET"])
def download_list(list_id):
    conn = _get_conn()
    row = _fetch_list(conn, list_id)
    if not row:
        conn.close()
        return jsonify({"error": "Shopping list not found."}), 404
    items = conn.execute(
        "SELECT * FROM shopping_items WHERE list_id = ? ORDER BY created_at ASC", (list_id,)
    ).fetchall()
    serialized_items = [_serialize_item(i) for i in items]
    summary = _summary(serialized_items)
    conn.close()

    lines = [
        f"S.N.E.T.C.H Shopping Planner",
        f"Shopping List: {row['name']}",
        f"Date: {row['list_date']}",
        "-" * 50,
    ]
    for it in serialized_items:
        status = "PURCHASED" if it["purchased"] else "PENDING"
        price_str = f" - Rs.{it['price']}" if it["purchased"] else ""
        lines.append(f"[{status:9}] {it['qty']} {it['unit']} x {it['name']}{price_str}")
    lines.append("-" * 50)
    lines.append(f"Total Items: {summary['total_items']}")
    lines.append(f"Purchased: {summary['purchased_items']}")
    lines.append(f"Remaining: {summary['remaining_items']}")
    lines.append(f"Total Shopping Cost: Rs.{summary['total_cost']}")

    buf = io.BytesIO("\n".join(lines).encode("utf-8"))
    buf.seek(0)
    safe_name = re.sub(r"[^A-Za-z0-9_\-]+", "_", row["name"]).strip("_") or "shopping_list"
    return send_file(
        buf,
        mimetype="text/plain",
        as_attachment=True,
        download_name=f"{safe_name}.txt",
    )


@shopping_bp.route("/search", methods=["GET"])
def search_lists():
    query = (request.args.get("q") or "").strip().lower()
    if not query:
        return jsonify({"lists": []})

    conn = _get_conn()
    like = f"%{query}%"
    rows = conn.execute(
        """
        SELECT DISTINCT sl.* FROM shopping_lists sl
        LEFT JOIN shopping_items si ON si.list_id = sl.id
        WHERE LOWER(sl.name) LIKE ?
           OR LOWER(sl.list_date) LIKE ?
           OR LOWER(si.name) LIKE ?
        ORDER BY sl.pinned DESC, sl.updated_at DESC
        """,
        (like, like, like),
    ).fetchall()
    result = [_serialize_list(r) for r in rows]
    conn.close()
    return jsonify({"lists": result})


# ─────────────────────────────────────────────
#  Routes — Items
# ─────────────────────────────────────────────

@shopping_bp.route("/lists/<list_id>/items", methods=["GET"])
def get_items(list_id):
    conn = _get_conn()
    row = _fetch_list(conn, list_id)
    if not row:
        conn.close()
        return jsonify({"error": "Shopping list not found."}), 404
    items = _fetch_items(conn, list_id)
    conn.close()
    return jsonify({"items": items, "summary": _summary(items)})


@shopping_bp.route("/lists/<list_id>/items", methods=["POST"])
def add_items(list_id):
    """Parse natural-language input (comma / newline separated) and add items."""
    data = request.get_json(force=True, silent=True) or {}
    text = data.get("text") or ""
    parsed = parse_items(text)
    if not parsed:
        return jsonify({"error": "No valid items found in that input."}), 400

    conn = _get_conn()
    row = _fetch_list(conn, list_id)
    if not row:
        conn.close()
        return jsonify({"error": "Shopping list not found."}), 404

    now = _now()
    added = []
    skipped = []
    existing = conn.execute(
        "SELECT name FROM shopping_items WHERE list_id = ?", (list_id,)
    ).fetchall()
    existing_names = {r["name"].lower() for r in existing}

    for entry in parsed:
        if entry["name"].lower() in existing_names:
            skipped.append(entry["name"])
            continue
        item_id = uuid.uuid4().hex
        conn.execute(
            """INSERT INTO shopping_items (id, list_id, name, qty, unit, purchased, price, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)""",
            (item_id, list_id, entry["name"], entry["qty"], entry["unit"], now, now),
        )
        existing_names.add(entry["name"].lower())
        added.append(entry["name"])

    conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, list_id))
    conn.commit()
    items = _fetch_items(conn, list_id)
    conn.close()
    return jsonify({
        "status": "ok",
        "added": added,
        "skipped_duplicates": skipped,
        "items": items,
        "summary": _summary(items),
    }), 201


@shopping_bp.route("/items/<item_id>", methods=["PUT"])
def update_item(item_id):
    data = request.get_json(force=True, silent=True) or {}
    conn = _get_conn()
    item = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
    if not item:
        conn.close()
        return jsonify({"error": "Item not found."}), 404

    name = (data.get("name") or item["name"]).strip()
    try:
        qty = float(data.get("qty", item["qty"]))
    except (TypeError, ValueError):
        qty = item["qty"]
    unit = (data.get("unit") or item["unit"]).strip().lower()
    unit = UNIT_ALIASES.get(unit, unit) if unit in UNIT_ALIASES else unit

    conn.execute(
        "UPDATE shopping_items SET name = ?, qty = ?, unit = ?, updated_at = ? WHERE id = ?",
        (name, qty, unit, _now(), item_id),
    )
    conn.execute(
        "UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (_now(), item["list_id"])
    )
    conn.commit()
    updated = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
    items = _fetch_items(conn, item["list_id"])
    conn.close()
    return jsonify({"status": "ok", "item": _serialize_item(updated), "items": items, "summary": _summary(items)})


@shopping_bp.route("/items/delete", methods=["POST"])
def delete_items():
    """Bulk delete: { ids: [...] }"""
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not ids:
        return jsonify({"error": "No item ids supplied."}), 400

    conn = _get_conn()
    placeholder = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT DISTINCT list_id FROM shopping_items WHERE id IN ({placeholder})", ids
    ).fetchall()
    list_ids = [r["list_id"] for r in rows]

    conn.execute(f"DELETE FROM shopping_items WHERE id IN ({placeholder})", ids)
    now = _now()
    for lid in list_ids:
        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, lid))
    conn.commit()

    items = _fetch_items(conn, list_ids[0]) if list_ids else []
    summary = _summary(items) if list_ids else _summary([])
    conn.close()
    return jsonify({"status": "ok", "deleted": ids, "items": items, "summary": summary})


@shopping_bp.route("/items/<item_id>/purchase", methods=["POST"])
def purchase_item(item_id):
    """Mark an item purchased and record its price."""
    data = request.get_json(force=True, silent=True) or {}
    try:
        price = float(data.get("price", 0))
    except (TypeError, ValueError):
        price = 0
    if price < 0:
        return jsonify({"error": "Price cannot be negative."}), 400

    conn = _get_conn()
    item = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
    if not item:
        conn.close()
        return jsonify({"error": "Item not found."}), 404

    conn.execute(
        "UPDATE shopping_items SET purchased = 1, price = ?, updated_at = ? WHERE id = ?",
        (price, _now(), item_id),
    )
    conn.execute(
        "UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (_now(), item["list_id"])
    )
    conn.commit()
    items = _fetch_items(conn, item["list_id"])
    conn.close()
    return jsonify({"status": "ok", "items": items, "summary": _summary(items)})


@shopping_bp.route("/items/<item_id>/unpurchase", methods=["POST"])
def unpurchase_item(item_id):
    """Undo a purchase mark (in case of a mistake)."""
    conn = _get_conn()
    item = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
    if not item:
        conn.close()
        return jsonify({"error": "Item not found."}), 404

    conn.execute(
        "UPDATE shopping_items SET purchased = 0, price = 0, updated_at = ? WHERE id = ?",
        (_now(), item_id),
    )
    conn.execute(
        "UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (_now(), item["list_id"])
    )
    conn.commit()
    items = _fetch_items(conn, item["list_id"])
    conn.close()
    return jsonify({"status": "ok", "items": items, "summary": _summary(items)})


# ─────────────────────────────────────────────
#  Registration
# ─────────────────────────────────────────────

def register_shopping_planner(app) -> None:
    """Wire this feature's API into the main Flask app.

    shopinglist.py deliberately does not import app.py (to avoid touching
    any other feature/file). Add these two lines once in app.py, near the
    other feature imports:

        import shopinglist
        ...
        shopinglist.register_shopping_planner(app)
    """
    init_db()
    app.register_blueprint(shopping_bp)