"""
wheather.py — S.N.E.T.C.H AI Weather Center (backend)

Provides normalized current-weather data for:
  • Auto-detected current location (lat/lon from the browser)
  • Any searched city name

Data source: Open-Meteo (https://open-meteo.com) — free, no API key
required, and returns everything the Weather Center UI needs in one
place (temperature, feels-like, humidity, wind, pressure, visibility,
UV index, sunrise/sunset) plus a WMO weather code we translate into
one of five cinematic scenes: sunny, rainy, cloudy, windy, snowy.

Public functions used by app.py:
    get_weather_by_coords(lat, lon)  -> dict
    get_weather_by_city(city)        -> dict

Both raise LocationNotFoundError / WeatherServiceError on failure so
app.py can turn them into clean JSON error responses.
"""

import datetime
import requests

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
REVERSE_GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/reverse"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

REQUEST_TIMEOUT = 10  # seconds


class WeatherServiceError(Exception):
    """Raised when the upstream weather service can't be reached / parsed."""


class LocationNotFoundError(Exception):
    """Raised when a searched city can't be resolved to a location."""


# ─────────────────────────────────────────────────────────────────
#  WMO WEATHER CODE → (description, scene category)
#  Scene category drives which cinematic environment the frontend
#  renders: sunny | rainy | cloudy | windy | snowy
# ─────────────────────────────────────────────────────────────────
WMO_CODES = {
    0: ("Clear Sky", "sunny"),
    1: ("Mainly Clear", "sunny"),
    2: ("Partly Cloudy", "cloudy"),
    3: ("Overcast", "cloudy"),
    45: ("Fog", "cloudy"),
    48: ("Depositing Rime Fog", "cloudy"),
    51: ("Light Drizzle", "rainy"),
    53: ("Moderate Drizzle", "rainy"),
    55: ("Dense Drizzle", "rainy"),
    56: ("Light Freezing Drizzle", "rainy"),
    57: ("Dense Freezing Drizzle", "rainy"),
    61: ("Slight Rain", "rainy"),
    63: ("Moderate Rain", "rainy"),
    65: ("Heavy Rain", "rainy"),
    66: ("Light Freezing Rain", "rainy"),
    67: ("Heavy Freezing Rain", "rainy"),
    71: ("Slight Snow Fall", "snowy"),
    73: ("Moderate Snow Fall", "snowy"),
    75: ("Heavy Snow Fall", "snowy"),
    77: ("Snow Grains", "snowy"),
    80: ("Slight Rain Showers", "rainy"),
    81: ("Moderate Rain Showers", "rainy"),
    82: ("Violent Rain Showers", "rainy"),
    85: ("Slight Snow Showers", "snowy"),
    86: ("Heavy Snow Showers", "snowy"),
    95: ("Thunderstorm", "cloudy"),
    96: ("Thunderstorm With Slight Hail", "cloudy"),
    99: ("Thunderstorm With Heavy Hail", "cloudy"),
}

# Wind speed (km/h) at/above which the scene becomes "windy",
# unless it's already actively raining/snowing.
WINDY_THRESHOLD_KMH = 38


def _describe_code(code):
    return WMO_CODES.get(int(code), ("Unknown", "cloudy"))


def _classify_condition(code, wind_speed_kmh):
    """Decide the final cinematic scene category."""
    _, base_category = _describe_code(code)

    if base_category in ("rainy", "snowy"):
        # Rain / snow always win — they define their own strong visuals.
        return base_category

    if wind_speed_kmh is not None and wind_speed_kmh >= WINDY_THRESHOLD_KMH:
        return "windy"

    return base_category


def _format_time(iso_string):
    """'2026-07-05T06:12' -> '06:12 AM' (best-effort, falls back to raw)."""
    if not iso_string:
        return "--"
    try:
        dt = datetime.datetime.fromisoformat(iso_string)
        return dt.strftime("%I:%M %p").lstrip("0")
    except ValueError:
        return iso_string


def _nearest_hour_index(hourly_times, current_time_iso):
    if not hourly_times:
        return 0
    if current_time_iso in hourly_times:
        return hourly_times.index(current_time_iso)
    return 0


def _build_weather_payload(lat, lon, location_name, country):
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": ",".join([
            "temperature_2m",
            "relative_humidity_2m",
            "apparent_temperature",
            "is_day",
            "weather_code",
            "surface_pressure",
            "wind_speed_10m",
            "wind_direction_10m",
            "wind_gusts_10m",
        ]),
        "hourly": "visibility,uv_index",
        "daily": "sunrise,sunset,uv_index_max",
        "timezone": "auto",
        "forecast_days": 1,
    }

    try:
        response = requests.get(FORECAST_URL, params=params, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        raise WeatherServiceError(f"Could not reach weather service: {exc}") from exc
    except ValueError as exc:
        raise WeatherServiceError("Weather service returned invalid data.") from exc

    current = data.get("current") or {}
    hourly = data.get("hourly") or {}
    daily = data.get("daily") or {}

    if not current:
        raise WeatherServiceError("Weather service returned no current conditions.")

    idx = _nearest_hour_index(hourly.get("time", []), current.get("time"))
    visibility_m = _safe_index(hourly.get("visibility"), idx)
    uv_index = _safe_index(hourly.get("uv_index"), idx)
    if uv_index is None:
        uv_index = _safe_index(daily.get("uv_index_max"), 0)

    code = current.get("weather_code", 0)
    wind_speed = current.get("wind_speed_10m")
    description, _ = _describe_code(code)
    condition_type = _classify_condition(code, wind_speed)

    payload = {
        "location": location_name,
        "country": country,
        "temperature": _round_or_none(current.get("temperature_2m")),
        "feels_like": _round_or_none(current.get("apparent_temperature")),
        "humidity": _round_or_none(current.get("relative_humidity_2m")),
        "wind_speed": _round_or_none(wind_speed),
        "wind_direction": current.get("wind_direction_10m"),
        "wind_gusts": _round_or_none(current.get("wind_gusts_10m")),
        "pressure": _round_or_none(current.get("surface_pressure")),
        "visibility": round(visibility_m / 1000, 1) if visibility_m is not None else None,
        "uv_index": _round_or_none(uv_index),
        "sunrise": _format_time(_safe_index(daily.get("sunrise"), 0)),
        "sunset": _format_time(_safe_index(daily.get("sunset"), 0)),
        "is_day": bool(current.get("is_day", 1)),
        "condition_code": int(code),
        "condition_text": description,
        "condition_type": condition_type,
        "last_updated": current.get("time"),
        "latitude": lat,
        "longitude": lon,
    }
    return payload


def _safe_index(seq, idx):
    if not seq:
        return None
    try:
        return seq[idx]
    except (IndexError, TypeError):
        return None


def _round_or_none(value):
    return round(value) if isinstance(value, (int, float)) else value


def get_weather_by_coords(lat, lon):
    """Current weather for raw coordinates (used for auto-detected location)."""
    location_name, country = _reverse_geocode(lat, lon)
    return _build_weather_payload(lat, lon, location_name, country)


def get_weather_by_city(city):
    """Current weather for a searched city name."""
    lat, lon, location_name, country = _geocode_city(city)
    return _build_weather_payload(lat, lon, location_name, country)


def _geocode_city(city):
    params = {"name": city, "count": 1, "language": "en", "format": "json"}
    try:
        response = requests.get(GEOCODE_URL, params=params, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        raise WeatherServiceError(f"Could not reach location service: {exc}") from exc

    results = data.get("results") or []
    if not results:
        raise LocationNotFoundError(f'Could not find a location named "{city}".')

    top = results[0]
    name = top.get("name", city)
    admin1 = top.get("admin1")
    country = top.get("country", "")
    display_name = f"{name}, {admin1}" if admin1 and admin1 != name else name
    return top["latitude"], top["longitude"], display_name, country


def _reverse_geocode(lat, lon):
    params = {"latitude": lat, "longitude": lon, "language": "en", "format": "json"}
    try:
        response = requests.get(REVERSE_GEOCODE_URL, params=params, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json()
    except requests.RequestException:
        return "Your Location", ""

    results = data.get("results") or []
    if not results:
        return "Your Location", ""

    top = results[0]
    name = top.get("name", "Your Location")
    admin1 = top.get("admin1")
    country = top.get("country", "")
    display_name = f"{name}, {admin1}" if admin1 and admin1 != name else name
    return display_name, country


if __name__ == "__main__":
    city = input("Enter a city name (e.g. Jaipur): ").strip()
    try:
        result = get_weather_by_city(city)
        print("\n===== WEATHER REPORT =====")
        for key, value in result.items():
            print(f"{key:15}: {value}")
        print("===========================\n")
    except (WeatherServiceError, LocationNotFoundError) as exc:
        print(f"Error: {exc}")