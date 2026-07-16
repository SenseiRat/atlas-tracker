from __future__ import annotations

import base64
import hashlib
import html
import hmac
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Set, Tuple

from fastapi import APIRouter, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from server.app.config import *  # noqa: F401,F403

def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)

def slugify(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")

def as_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

def is_polygonal_geometry(geometry: Any) -> bool:
    if not isinstance(geometry, dict):
        return False
    return str(geometry.get("type") or "").strip() in {"Polygon", "MultiPolygon"}

def normalize_country_code(raw: Any, iso2_to_iso3: Dict[str, str]) -> Optional[str]:
    code = str(raw or "").strip().upper()
    if not code:
        return None
    if len(code) == 2:
        return iso2_to_iso3.get(code, code)
    return code

def extract_state_code(item: Dict[str, Any]) -> Optional[str]:
    state_code = item.get("state_code") or item.get("admin1_code") or item.get("state")
    if not state_code and item.get("iso_3166_2"):
        region = str(item.get("iso_3166_2"))
        if "-" in region:
            state_code = region.split("-", 1)[1]
        else:
            state_code = region
    if not state_code and item.get("iso_region"):
        region = str(item.get("iso_region"))
        if "-" in region:
            state_code = region.split("-", 1)[1]
        else:
            state_code = region
    state_code_text = str(state_code or "").strip().upper()
    return state_code_text or None

def extract_airport_code(item: Dict[str, Any]) -> Optional[str]:
    for key in ("iata_code", "airport_code", "code"):
        value = str(item.get(key) or "").strip().upper()
        if IATA_CODE_RE.match(value):
            return value
    return None

def is_duplicate_airport_record(item: Dict[str, Any]) -> bool:
    name = str(item.get("name") or "").strip().lower()
    return name.startswith("(duplicate)")

def normalize_profile_color(raw: Any) -> str:
    color = str(raw or "").strip()
    if HEX_COLOR_RE.match(color):
        return color.lower()
    return DEFAULT_PROFILE_COLOR

def normalize_profile_home_country_code(raw: Any) -> Optional[str]:
    code = str(raw or "").strip().upper()
    if not code:
        return None
    if re.fullmatch(r"[A-Z]{2,3}", code):
        return code
    raise HTTPException(status_code=400, detail="home_country_code must be a 2- or 3-letter country code")

def extract_timezone(item: Dict[str, Any]) -> Optional[str]:
    for key in ("timezone", "tz_database_time_zone", "tz", "iana_timezone"):
        value = str(item.get(key) or "").strip()
        if value:
            return value
    return None

def extract_elevation_meters(item: Dict[str, Any]) -> Optional[float]:
    meters = as_float(item.get("elevation_m") or item.get("elevation"))
    if meters is not None:
        return meters
    feet = as_float(item.get("elevation_ft"))
    if feet is not None:
        return feet * 0.3048
    dem = as_float(item.get("dem"))
    if dem is not None:
        return dem
    return None

def get_continent_from_country_data(data_value: str) -> Optional[str]:
    try:
        payload = json.loads(data_value)
    except json.JSONDecodeError:
        return None
    properties = payload.get("properties", {}) if isinstance(payload, dict) else {}
    continent = str(properties.get("CONTINENT") or properties.get("continent") or "").strip()
    return continent or None

def parse_json_object(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        loaded = json.loads(str(raw or "{}"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}

def nested_place_properties(item: Dict[str, Any]) -> Dict[str, Any]:
    properties = item.get("properties", {})
    return properties if isinstance(properties, dict) else {}

def extract_population(item: Dict[str, Any]) -> Optional[int]:
    properties = nested_place_properties(item)
    for value in (
        item.get("population"),
        properties.get("POP_EST"),
        properties.get("pop_est"),
        properties.get("population"),
    ):
        parsed = as_float(value)
        if parsed is not None:
            return int(parsed)
    return None

def extract_area_sqkm(item: Dict[str, Any]) -> Optional[float]:
    properties = nested_place_properties(item)
    for value in (
        item.get("area_sqkm"),
        properties.get("area_sqkm"),
        properties.get("AREA_SQKM"),
    ):
        parsed = as_float(value)
        if parsed is not None:
            return parsed
    return None

def extract_country_currency(item: Dict[str, Any]) -> Optional[str]:
    properties = nested_place_properties(item)
    currency_code = str(
        properties.get("CURRENCY_CODE")
        or properties.get("currency_code")
        or properties.get("currency")
        or item.get("currency_code")
        or item.get("currency")
        or ""
    ).strip()
    return currency_code or None

def extract_country_economy(item: Dict[str, Any]) -> Optional[str]:
    properties = nested_place_properties(item)
    economy = str(properties.get("ECONOMY") or properties.get("economy") or "").strip()
    return economy or None

def extract_continent_name(item: Dict[str, Any]) -> Optional[str]:
    properties = nested_place_properties(item)
    continent = str(properties.get("CONTINENT") or properties.get("continent") or item.get("continent") or "").strip()
    return continent or None

def metric_entry(
    metric_id: str,
    label: str,
    place_name: str,
    value: Any,
    display_value: str,
    *,
    detail: Optional[str] = None,
    unit: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "id": metric_id,
        "label": label,
        "place_name": place_name,
        "value": value,
        "display_value": display_value,
        "detail": detail,
        "unit": unit,
    }

def current_timestamp() -> str:
    # naive-UTC isoformat, matching the format stored since the first release
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()

def _normalize_local_username(raw: Any) -> str:
    username = str(raw or "").strip().lower()
    if not username or not re.match(r"^[a-z0-9_.-]{3,40}$", username):
        raise HTTPException(status_code=400, detail="Username must be 3-40 chars: letters, numbers, ., _, -")
    return username

def _path_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

HTML_TAG_RE = re.compile(r"<[^>]+>")

DARKSKY_CATEGORY_RE = re.compile(
    r"Category\s+(.+?)(?=\s*Address|\s*Google Maps|\s*Contact|\s*Documents|\s*Website|\s*Weather|\s*Certified\b|\s*Land area|\s*Area\b|$)",
    re.IGNORECASE,
)

DARKSKY_ADDRESS_RE = re.compile(
    r"Address\s+(.+?)(?=Google Maps|\s*Contact|\s*Documents|\s*Website|\s*Weather|\s*Certified\b|$)",
    re.IGNORECASE,
)

DARKSKY_WEATHER_COORDS_RE = re.compile(
    r"Weather\b.*?\((-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)",
    re.IGNORECASE,
)

DARKSKY_ANY_COORDS_RE = re.compile(r"\((-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)")

def sanitize_markup_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    if not text:
        return None
    text = re.sub(r"(?i)<br\s*/?>", " ", text)
    text = HTML_TAG_RE.sub("", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text or None

def normalize_lookup_text(value: Any) -> str:
    text = sanitize_markup_text(value) or ""
    normalized = unicodedata.normalize("NFKD", text)
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    normalized = normalized.replace("&", " and ")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized.lower()).strip()
    return normalized

def register_country_name_variants(mapping: Dict[str, str], country_code: str, *names: Any) -> None:
    for raw_name in names:
        normalized = normalize_lookup_text(raw_name)
        if normalized:
            mapping[normalized] = country_code

def infer_country_code_from_text(value: Any, country_name_to_iso3: Dict[str, str]) -> Optional[str]:
    text = sanitize_markup_text(value)
    if not text:
        return None
    candidates = [text]
    segments = [segment.strip() for segment in re.split(r"[,;/|()]", text) if segment.strip()]
    candidates.extend(reversed(segments))
    for candidate in candidates:
        normalized = normalize_lookup_text(candidate)
        if not normalized:
            continue
        if normalized in country_name_to_iso3:
            return country_name_to_iso3[normalized]
        words = normalized.split()
        for width in range(min(len(words), 5), 0, -1):
            suffix = " ".join(words[-width:])
            if suffix in country_name_to_iso3:
                return country_name_to_iso3[suffix]
    return None

def extract_michelin_location_parts(value: Any) -> Tuple[Optional[str], Optional[str]]:
    text = sanitize_markup_text(value)
    if not text:
        return None, None
    parts = [segment.strip() for segment in text.split(",") if segment.strip()]
    if not parts:
        return text, None
    location = ", ".join(parts[:-1]) if len(parts) > 1 else parts[0]
    country = parts[-1] if len(parts) > 1 else None
    return location or None, country or None

def extract_michelin_summary_details(value: Any, restaurant_name: Optional[str]) -> Dict[str, Optional[str]]:
    text = sanitize_markup_text(value)
    if not text:
        return {"location": None, "price": None, "cuisine": None}
    prefix = "Reserve a table "
    if text.startswith(prefix):
        text = text[len(prefix):].strip()
    if restaurant_name and text.startswith(restaurant_name):
        text = text[len(restaurant_name):].strip(" ,-")

    cuisine = None
    details_text = text
    if " · " in text:
        details_text, cuisine = [part.strip() or None for part in text.rsplit(" · ", 1)]

    price = None
    price_match = re.search(r"(?P<location>.+?)\s+(?P<price>\$+)$", details_text or "")
    if price_match:
        details_text = price_match.group("location").strip()
        price = price_match.group("price").strip()

    return {
        "location": details_text or None,
        "price": price,
        "cuisine": cuisine,
    }

def extract_darksky_coordinates(value: Any) -> Tuple[Optional[float], Optional[float]]:
    text = sanitize_markup_text(value)
    if not text:
        return None, None
    match = DARKSKY_WEATHER_COORDS_RE.search(text)
    if match is None:
        all_matches = DARKSKY_ANY_COORDS_RE.findall(text)
        match = all_matches[-1] if all_matches else None
        if match is None:
            return None, None
        lat = as_float(match[0])
        lon = as_float(match[1])
        return lat, lon
    lat = as_float(match.group(1))
    lon = as_float(match.group(2))
    return lat, lon

def extract_darksky_category_label(value: Any) -> Optional[str]:
    text = sanitize_markup_text(value)
    if not text:
        return None
    match = DARKSKY_CATEGORY_RE.search(text)
    if match:
        return sanitize_markup_text(match.group(1))
    normalized = normalize_lookup_text(text)
    if "urban night sky place" in normalized:
        return "Urban Night Sky Place"
    if "darksky approved lodging" in normalized or "darksky lodging standards" in normalized or "lodging program" in normalized:
        return "Dark Sky Lodging"
    if "dark sky sanctuary" in normalized:
        return "Dark Sky Sanctuary"
    if "dark sky reserve" in normalized:
        return "Dark Sky Reserve"
    if "dark sky community" in normalized:
        return "Dark Sky Community"
    if "dark sky park" in normalized:
        return "Dark Sky Park"
    return None

def extract_darksky_address(value: Any) -> Optional[str]:
    text = sanitize_markup_text(value)
    if not text:
        return None
    match = DARKSKY_ADDRESS_RE.search(text)
    return sanitize_markup_text(match.group(1)) if match else None

def normalize_darksky_category(category_label: Optional[str]) -> str:
    label = normalize_lookup_text(category_label)
    if "lodging" in label:
        return "dark_sky_lodging"
    if "urban night sky place" in label:
        return "urban_night_sky_place"
    if "sanctuary" in label:
        return "dark_sky_sanctuary"
    if "reserve" in label:
        return "dark_sky_reserve"
    if "community" in label:
        return "dark_sky_community"
    if "park" in label:
        return "dark_sky_park"
    if "place" in label:
        return "dark_sky_place"
    return "dark_sky_site"


__all__ = [
    'load_json',
    'slugify',
    'as_float',
    'is_polygonal_geometry',
    'normalize_country_code',
    'extract_state_code',
    'extract_airport_code',
    'is_duplicate_airport_record',
    'normalize_profile_color',
    'normalize_profile_home_country_code',
    'extract_timezone',
    'extract_elevation_meters',
    'get_continent_from_country_data',
    'parse_json_object',
    'nested_place_properties',
    'extract_population',
    'extract_area_sqkm',
    'extract_country_currency',
    'extract_country_economy',
    'extract_continent_name',
    'metric_entry',
    'current_timestamp',
    '_normalize_local_username',
    '_path_digest',
    'HTML_TAG_RE',
    'DARKSKY_CATEGORY_RE',
    'DARKSKY_ADDRESS_RE',
    'DARKSKY_WEATHER_COORDS_RE',
    'DARKSKY_ANY_COORDS_RE',
    'sanitize_markup_text',
    'normalize_lookup_text',
    'register_country_name_variants',
    'infer_country_code_from_text',
    'extract_michelin_location_parts',
    'extract_michelin_summary_details',
    'extract_darksky_coordinates',
    'extract_darksky_category_label',
    'extract_darksky_address',
    'normalize_darksky_category',
]
