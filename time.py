"""
time.py — S.N.E.T.C.H World Clock backend module.

Provides live, authoritative server-side time data for the Futuristic
Time Experience (World Clock feature). Exposes get_time_payload(), a
small pure function returning a JSON-serializable dict, which app.py's
/api/time/now route uses to keep the frontend clock perfectly in sync
with the server.

NOTE: All logic lives inside functions — nothing runs at import time —
so this module is safe to import from app.py without side effects.
"""

from datetime import datetime


def get_time_payload():
    """Build a JSON-serializable snapshot of the current server time.

    Returns a dict containing everything the World Clock frontend needs:
    12h/24h time strings, individual hour/minute/second components (for
    smooth analog-hand math), and the calendar fields (date, month,
    year, day, week number) shown on the info cards.
    """
    now = datetime.now()

    first_day_of_year = datetime(now.year, 1, 1)
    days_passed = (now - first_day_of_year).days
    week_number = (days_passed + first_day_of_year.weekday()) // 7 + 1

    return {
        "iso": now.isoformat(),
        "epoch_ms": int(now.timestamp() * 1000),

        "time_12h": now.strftime("%I:%M:%S %p"),
        "time_24h": now.strftime("%H:%M:%S"),
        "ampm": now.strftime("%p"),

        "hour_24": now.hour,
        "hour_12": int(now.strftime("%I")),
        "minute": now.minute,
        "second": now.second,
        "microsecond": now.microsecond,

        "date": now.strftime("%d"),
        "month": now.strftime("%B"),
        "month_short": now.strftime("%b"),
        "month_num": now.month,
        "year": now.strftime("%Y"),
        "day": now.strftime("%A"),
        "day_short": now.strftime("%a"),
        "week_number": week_number,
    }


if __name__ == "__main__":
    # Manual/CLI sanity check only — never runs on import.
    payload = get_time_payload()
    print("=" * 40)
    print("🕒 Current Date & Time")
    print("=" * 40)
    for key in ("time_12h", "date", "day", "month", "year", "week_number"):
        print(f"{key:12}: {payload[key]}")
    print("=" * 40)