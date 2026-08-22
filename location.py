"""
S.N.E.T.C.H — Maps & Navigation AI Assistant (backend)

This module powers the "Maps & Navigation" feature. It understands natural
language location queries and returns structured JSON data that the frontend
(location.js) renders as premium result cards, plus ready-to-use Google Maps
links so the user's own browser (not the server) opens navigation/search.

No paid API key is required — it uses free, keyless public services:
  • OpenStreetMap Nominatim  -> geocoding / reverse geocoding / place search
  • OSRM (public demo router) -> driving distance, duration & route summary
  • Open-Meteo               -> current weather (no key needed)

All network calls are wrapped in try/except with short timeouts so a slow or
unreachable third-party service degrades gracefully instead of crashing the
Flask app.
"""

import math
import re
import requests

# ─────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────

NOMINATIM_URL = "https://nominatim.openstreetmap.org"
OSRM_URL = "https://router.project-osrm.org"
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"

HTTP_HEADERS = {
    "User-Agent": "SNETCH-Location-AI/1.0 (contact: snetch-assistant)"
}
REQUEST_TIMEOUT = 6  # seconds — keep the UI snappy even if a service is slow

# Friendly aliases -> a normalized search term Nominatim understands well.
PLACE_TYPE_ALIASES = {
    "restaurant": "restaurant", "restaurants": "restaurant", "food": "restaurant",
    "hotel": "hotel", "hotels": "hotel", "stay": "hotel",
    "hospital": "hospital", "hospitals": "hospital", "clinic": "hospital",
    "atm": "atm", "atms": "atm", "cash machine": "atm",
    "petrol pump": "petrol pump", "petrol": "petrol pump", "gas station": "petrol pump",
    "fuel station": "petrol pump", "fuel": "petrol pump", "pump": "petrol pump",
    "pharmacy": "pharmacy", "medical store": "pharmacy", "chemist": "pharmacy", "medicine shop": "pharmacy",
    "railway station": "railway station", "train station": "railway station", "station": "railway station",
    "airport": "airport",
    "bus stand": "bus station", "bus station": "bus station", "bus stop": "bus station",
    "police station": "police station", "police": "police station",
    "shopping mall": "shopping mall", "mall": "shopping mall",
    "grocery store": "grocery store", "grocery": "grocery store", "supermarket": "grocery store", "kirana": "grocery store",
    "coffee shop": "cafe", "cafe": "cafe", "coffee": "cafe",
    "gym": "gym", "fitness center": "gym", "fitness centre": "gym", "workout": "gym",
    "tourist place": "tourist attraction", "tourist places": "tourist attraction",
    "tourist attraction": "tourist attraction", "tourist attractions": "tourist attraction",
    "famous place": "tourist attraction", "famous places": "tourist attraction", "attractions": "tourist attraction",
}

CURRENT_LOCATION_WORDS = ("my location", "current location", "here", "me", "my current location")


# ─────────────────────────────────────────
#  LOW-LEVEL HELPERS
# ─────────────────────────────────────────

def _get(url, params):
    """GET with a short timeout; returns parsed JSON or None on any failure."""
    try:
        r = requests.get(url, params=params, headers=HTTP_HEADERS, timeout=REQUEST_TIMEOUT)
        if r.status_code == 200:
            return r.json()
    except requests.exceptions.RequestException:
        return None
    except ValueError:
        return None
    return None


def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in kilometers between two points."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def geocode(place: str, lat=None, lon=None):
    """Resolve a place name into {lat, lon, display_name}. Optionally biased
    toward a given lat/lon so ambiguous names ('Jaipur') resolve sensibly."""
    if not place:
        return None
    params = {"q": place, "format": "jsonv2", "limit": 1}
    if lat is not None and lon is not None:
        params["viewbox"] = f"{lon-2},{lat+2},{lon+2},{lat-2}"
    data = _get(f"{NOMINATIM_URL}/search", params)
    if not data:
        return None
    top = data[0]
    return {
        "lat": float(top["lat"]),
        "lon": float(top["lon"]),
        "display_name": top.get("display_name", place),
    }


def reverse_geocode(lat, lon):
    """Turn coordinates into a readable address."""
    data = _get(f"{NOMINATIM_URL}/reverse", {"lat": lat, "lon": lon, "format": "jsonv2"})
    if not data:
        return None
    return data.get("display_name")


def search_nearby(category_term, lat, lon, radius_km=5, limit=6):
    """Free-text nearby search bounded around (lat, lon)."""
    d = radius_km / 111.0  # ~degrees per km
    params = {
        "q": category_term,
        "format": "jsonv2",
        "limit": limit,
        "bounded": 1,
        "viewbox": f"{lon-d},{lat+d},{lon+d},{lat-d}",
    }
    data = _get(f"{NOMINATIM_URL}/search", params)
    if not data:
        return []
    results = []
    for item in data:
        plat, plon = float(item["lat"]), float(item["lon"])
        results.append({
            "name": item.get("name") or item.get("display_name", "").split(",")[0],
            "address": item.get("display_name", ""),
            "lat": plat,
            "lon": plon,
            "distance_km": round(haversine_km(lat, lon, plat, plon), 2),
        })
    results.sort(key=lambda x: x["distance_km"])
    return results


def get_route(lat1, lon1, lat2, lon2):
    """Driving distance/duration + a short turn-by-turn summary via OSRM."""
    url = f"{OSRM_URL}/route/v1/driving/{lon1},{lat1};{lon2},{lat2}"
    data = _get(url, {"overview": "false", "steps": "true", "alternatives": "false"})
    if not data or data.get("code") != "Ok" or not data.get("routes"):
        return None
    route = data["routes"][0]
    distance_km = round(route["distance"] / 1000.0, 1)
    duration_min = round(route["duration"] / 60.0)

    summary = []
    try:
        for leg in route.get("legs", []):
            for step in leg.get("steps", []):
                road = step.get("name") or "the road"
                maneuver = step.get("maneuver", {}).get("type", "continue")
                summary.append(f"{maneuver.replace('_', ' ').capitalize()} onto {road}".strip())
    except Exception:
        pass
    summary = [s for s in summary if s][:6] or ["Follow the main route to your destination."]

    return {
        "distance_km": distance_km,
        "duration_min": duration_min,
        "summary": summary,
    }


def get_weather(lat, lon):
    data = _get(WEATHER_URL, {
        "latitude": lat, "longitude": lon,
        "current_weather": "true",
        "timezone": "auto",
    })
    if not data or "current_weather" not in data:
        return None
    cw = data["current_weather"]
    return {
        "temperature_c": cw.get("temperature"),
        "windspeed_kmh": cw.get("windspeed"),
        "weather_code": cw.get("weathercode"),
    }


# ─────────────────────────────────────────
#  GOOGLE MAPS LINK BUILDERS (open client-side, never server-side)
# ─────────────────────────────────────────

def gmaps_search_url(query=None, lat=None, lon=None):
    if lat is not None and lon is not None:
        q = f"{lat},{lon}"
    else:
        q = query or ""
    return f"https://www.google.com/maps/search/?api=1&query={requests.utils.quote(q)}"


def gmaps_directions_url(origin, destination):
    return (
        "https://www.google.com/maps/dir/?api=1"
        f"&origin={requests.utils.quote(origin)}"
        f"&destination={requests.utils.quote(destination)}"
        "&travelmode=driving"
    )


def gmaps_home_url():
    return "https://www.google.com/maps"


def _normalize_place_type(raw):
    raw = raw.strip().lower()
    raw = re.sub(r"\bnearest\b|\bnearby\b|\bnear\s*(me|my location)?\b", "", raw).strip()
    raw = re.sub(r"\s+", " ", raw)
    return PLACE_TYPE_ALIASES.get(raw, raw if raw else None)


# ─────────────────────────────────────────
#  RESPONSE BUILDERS (structured dicts consumed by the frontend)
# ─────────────────────────────────────────

def _err(message, code="error"):
    return {"type": "error", "code": code, "message": message}


def resp_current_location(lat, lon):
    if lat is None or lon is None:
        return _err(
            "I need your device location to show where you are. Please allow "
            "location access and try again.", "location_permission_denied"
        )
    address = reverse_geocode(lat, lon) or "Unknown address"
    return {
        "type": "current_location",
        "message": "Here's your current location.",
        "location_name": "My Current Location",
        "address": address,
        "lat": lat,
        "lon": lon,
        "google_maps_url": gmaps_search_url(lat=lat, lon=lon),
    }


def resp_nearby(category_term, lat, lon, from_place=None):
    origin_lat, origin_lon, origin_label = lat, lon, "My Location"

    if from_place and from_place.strip().lower() not in CURRENT_LOCATION_WORDS:
        place = geocode(from_place)
        if not place:
            return _err(f"I couldn't find the place '{from_place}'.", "invalid_destination")
        origin_lat, origin_lon, origin_label = place["lat"], place["lon"], place["display_name"]

    if origin_lat is None or origin_lon is None:
        return _err(
            "I need a location to search nearby. Please allow location access "
            "or tell me a starting place.", "location_permission_denied"
        )

    term = _normalize_place_type(category_term) or category_term
    places = search_nearby(term, origin_lat, origin_lon)
    if not places:
        return _err(f"No {term} found near {origin_label}.", "no_route_found")

    for p in places:
        p["google_maps_url"] = gmaps_search_url(query=p["name"] or term, lat=p["lat"], lon=p["lon"])
        p["navigation_url"] = gmaps_directions_url(f"{origin_lat},{origin_lon}", f"{p['lat']},{p['lon']}")

    return {
        "type": "nearby",
        "message": f"Here are {term} places near {origin_label}.",
        "category": term,
        "origin": origin_label,
        "results": places,
        "google_maps_url": gmaps_search_url(query=f"{term} near {origin_label}"),
    }


def resp_navigate(destination, origin=None, lat=None, lon=None, mode_label="Route"):
    dest_place = geocode(destination, lat, lon)
    if not dest_place:
        return _err(f"I couldn't find the destination '{destination}'.", "invalid_destination")

    if origin and origin.strip().lower() not in CURRENT_LOCATION_WORDS:
        origin_place = geocode(origin)
        if not origin_place:
            return _err(f"I couldn't find the starting place '{origin}'.", "invalid_destination")
        o_lat, o_lon, o_label = origin_place["lat"], origin_place["lon"], origin_place["display_name"]
    elif lat is not None and lon is not None:
        o_lat, o_lon, o_label = lat, lon, "My Current Location"
    else:
        return _err(
            "I need your current location to plan a route. Please allow "
            "location access or tell me a starting place.", "location_permission_denied"
        )

    route = get_route(o_lat, o_lon, dest_place["lat"], dest_place["lon"])
    if not route:
        route = {
            "distance_km": round(haversine_km(o_lat, o_lon, dest_place["lat"], dest_place["lon"]), 1),
            "duration_min": None,
            "summary": ["Approximate straight-line distance shown — live routing is temporarily unavailable."],
        }

    origin_str = f"{o_lat},{o_lon}"
    dest_str = f"{dest_place['lat']},{dest_place['lon']}"

    return {
        "type": "navigate",
        "message": f"{mode_label} to {dest_place['display_name']}.",
        "origin": o_label,
        "destination": dest_place["display_name"],
        "distance_km": route["distance_km"],
        "duration_min": route["duration_min"],
        "route_summary": route["summary"],
        "google_maps_url": gmaps_search_url(lat=dest_place["lat"], lon=dest_place["lon"]),
        "navigation_url": gmaps_directions_url(origin_str, dest_str),
    }


def resp_distance(place_a, place_b, lat=None, lon=None, traffic_note=False):
    if place_a.strip().lower() in CURRENT_LOCATION_WORDS:
        if lat is None or lon is None:
            return _err(
                "I need your current location to measure this distance. "
                "Please allow location access.", "location_permission_denied"
            )
        a_lat, a_lon, a_label = lat, lon, "My Current Location"
    else:
        a_place = geocode(place_a)
        if not a_place:
            return _err(f"I couldn't find '{place_a}'.", "invalid_destination")
        a_lat, a_lon, a_label = a_place["lat"], a_place["lon"], a_place["display_name"]

    b_place = geocode(place_b, a_lat, a_lon)
    if not b_place:
        return _err(f"I couldn't find '{place_b}'.", "invalid_destination")

    route = get_route(a_lat, a_lon, b_place["lat"], b_place["lon"])
    if not route:
        route = {
            "distance_km": round(haversine_km(a_lat, a_lon, b_place["lat"], b_place["lon"]), 1),
            "duration_min": None,
            "summary": ["Approximate straight-line distance shown — live routing is temporarily unavailable."],
        }

    result = {
        "type": "distance",
        "message": f"Distance between {a_label} and {b_place['display_name']}.",
        "origin": a_label,
        "destination": b_place["display_name"],
        "distance_km": route["distance_km"],
        "duration_min": route["duration_min"],
        "route_summary": route["summary"],
        "google_maps_url": gmaps_search_url(lat=b_place["lat"], lon=b_place["lon"]),
        "navigation_url": gmaps_directions_url(f"{a_lat},{a_lon}", f"{b_place['lat']},{b_place['lon']}"),
    }
    if traffic_note:
        result["message"] = f"Estimated travel time between {a_label} and {b_place['display_name']}."
        result["note"] = "Live traffic data isn't available, so this is a typical drive-time estimate."
    return result


def resp_weather(lat, lon):
    if lat is None or lon is None:
        return _err(
            "I need your current location to check the weather. Please allow "
            "location access.", "location_permission_denied"
        )
    w = get_weather(lat, lon)
    if not w:
        return _err("Weather service is unavailable right now. Please try again.", "no_internet")
    address = reverse_geocode(lat, lon) or "your location"
    return {
        "type": "weather",
        "message": f"Current weather near {address}.",
        "location_name": address,
        "temperature_c": w["temperature_c"],
        "windspeed_kmh": w["windspeed_kmh"],
        "google_maps_url": gmaps_search_url(lat=lat, lon=lon),
    }


def resp_open_maps():
    return {
        "type": "open_maps",
        "message": "Opening Google Maps.",
        "google_maps_url": gmaps_home_url(),
    }


# ─────────────────────────────────────────
#  INTENT PARSER (entry point used by app.py)
# ─────────────────────────────────────────

def handle_query(query: str, lat=None, lon=None):
    """Parse a natural-language location query and return a structured dict.
    `lat`/`lon` are the user's real device coordinates from the browser
    (Geolocation API), used for anything relative to 'me' / 'near me'."""
    if not query or not query.strip():
        return _err("I didn't catch that. Could you try asking again?", "speech_recognition_failed")

    q = query.strip().lower()
    q = re.sub(r"[?.!]+$", "", q).strip()

    # Open Google Maps directly
    if re.search(r"\bopen google maps\b", q):
        return resp_open_maps()

    # Weather at current location
    if re.search(r"\bweather\b", q) and re.search(r"\b(my location|here|current location|my current location)\b", q):
        return resp_weather(lat, lon)

    # Where am I / current location
    if re.search(r"\b(where am i|my location|current location|where i am|show( my)? location|my current location)\b", q):
        return resp_current_location(lat, lon)

    # Traffic between A and B
    traffic_match = re.search(r"traffic\s+(?:between|from)\s+(.+?)\s+(?:to|and)\s+(.+)", q)
    if traffic_match:
        return resp_distance(traffic_match.group(1).strip(), traffic_match.group(2).strip(), lat, lon, traffic_note=True)

    # Shortest distance / distance between A and B
    dist_match = re.search(
        r"(?:shortest\s+)?distance\s+(?:between\s+)?(.+?)\s+(?:to|and)\s+(.+)", q
    )
    if dist_match:
        return resp_distance(dist_match.group(1).strip(), dist_match.group(2).strip(), lat, lon)

    # Fastest / best route to X
    route_match = re.search(r"(?:fastest|best)\s+route\s+(?:to\s+)?(.+)", q)
    if route_match:
        return resp_navigate(route_match.group(1).strip(), lat=lat, lon=lon, mode_label="Best route")

    # Navigate to X [from Y]
    nav_match = re.search(r"navigate\s+(?:to\s+)?(.+?)(?:\s+from\s+(.+))?$", q)
    if nav_match:
        dest = nav_match.group(1).strip()
        origin = nav_match.group(2).strip() if nav_match.group(2) else None
        return resp_navigate(dest, origin=origin, lat=lat, lon=lon)

    # Famous / tourist places in X
    famous_match = re.search(r"(?:famous places|tourist places|tourist attractions|attractions)\s+in\s+(.+)", q)
    if famous_match:
        place_name = famous_match.group(1).strip()
        place = geocode(place_name)
        if not place:
            return _err(f"I couldn't find '{place_name}'.", "invalid_destination")
        return resp_nearby("tourist attraction", place["lat"], place["lon"], from_place=place_name)

    # Tourist places near me
    if re.search(r"tourist places?\s+near\s+(?:me|my location)", q):
        return resp_nearby("tourist attraction", lat, lon)

    # nearest/nearby X from Y
    near_from = re.search(r"nearest?\s+(.+?)\s+from\s+(.+)", q)
    if near_from:
        return resp_nearby(near_from.group(1).strip(), lat, lon, from_place=near_from.group(2).strip())

    # X near me / nearby X / nearest X
    near_me = re.search(
        r"^(.+?)\s+near\s+(?:me|my location)$|^nearby\s+(.+)$|^nearest\s+(.+)$", q
    )
    if near_me:
        ptype = (near_me.group(1) or near_me.group(2) or near_me.group(3) or "").strip()
        if ptype:
            return resp_nearby(ptype, lat, lon)

    return _err(
        "I couldn't understand that location request. Try things like "
        "'restaurants near me', 'navigate to Jaipur', or 'distance between "
        "Jaipur and Delhi'.", "unknown_query"
    )


# Backwards-compatible alias (older code in this project called handle_input)
def handle_input(query: str, lat=None, lon=None):
    return handle_query(query, lat, lon)


# ─────────────────────────────────────────
#  STANDALONE MODE (manual testing without Flask)
# ─────────────────────────────────────────

if __name__ == "__main__":
    import json
    print("=" * 55)
    print("   S.N.E.T.C.H — Maps & Navigation AI (console test)")
    print("=" * 55)
    print("  Tip: pass 'lat,lon' first to simulate your location, e.g:")
    print("       28.6139,77.2090")
    print("  Then ask things like 'restaurants near me' or 'navigate to Agra'")
    print("=" * 55)

    test_lat, test_lon = None, None
    while True:
        try:
            query = input("\n  You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n  Bye!")
            break
        if not query:
            continue
        if query.lower() in ("quit", "exit", "bye", "q"):
            print("  Bye!")
            break
        if re.match(r"^-?\d+\.\d+,\s*-?\d+\.\d+$", query):
            test_lat, test_lon = (float(x) for x in query.split(","))
            print(f"  → Location set to {test_lat}, {test_lon}")
            continue
        try:
            result = handle_query(query, test_lat, test_lon)
            print(f"  → {json.dumps(result, indent=2)}")
        except Exception as e:
            print(f"  ✗ Error: {e}")
