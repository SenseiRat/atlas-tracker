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
from server.app.db import *  # noqa: F401,F403
from server.app.helpers import *  # noqa: F401,F403
from server.app.settings_store import *  # noqa: F401,F403

def _source_paths(config: Dict[str, Any]) -> List[Path]:
    filenames = config.get("filenames")
    if isinstance(filenames, list):
        return [DATA_SOURCES_DIR / str(filename) for filename in filenames]
    return [DATA_SOURCES_DIR / str(config["filename"])]

def _compute_source_digests() -> Dict[str, str]:
    digests: Dict[str, str] = {}
    for source_key, config in SOURCE_DATASET_DEFINITIONS.items():
        path_digests = [
            f"{path.name}:{_path_digest(path)}"
            for path in _source_paths(config)
            if path.exists()
        ]
        if path_digests:
            digests[source_key] = hashlib.sha256("|".join(path_digests).encode("utf-8")).hexdigest()
    return digests

def _load_source_payloads(source_keys: Optional[Set[str]] = None) -> Dict[str, Any]:
    payloads: Dict[str, Any] = {}
    for source_key, config in SOURCE_DATASET_DEFINITIONS.items():
        if source_keys is not None and source_key not in source_keys:
            continue
        paths = _source_paths(config)
        if len(paths) > 1:
            source_payloads = [
                {"filename": path.name, "payload": load_json(path)}
                for path in paths
                if path.exists()
            ]
            if source_payloads:
                payloads[source_key] = source_payloads
                continue
            if bool(config.get("required")):
                filenames = ", ".join(path.name for path in paths)
                raise FileNotFoundError(f"Required data source missing: one of [{filenames}]")
            payloads[source_key] = config.get("empty_payload", [])
            continue

        path = paths[0]
        if path.exists():
            payloads[source_key] = load_json(path)
            continue
        if bool(config.get("required")):
            raise FileNotFoundError(f"Required data source missing: {path}")
        payloads[source_key] = config.get("empty_payload", {"features": []})
    return payloads

def _collect_country_rows(payload: Any, context: Dict[str, Any]) -> Tuple[List[tuple], Dict[str, Tuple[str, str]]]:
    rows: List[tuple] = []
    source_state: Dict[str, Tuple[str, str]] = {}
    iso2_to_iso3: Dict[str, str] = context.setdefault("iso2_to_iso3", {})
    country_name_to_iso3: Dict[str, str] = context.setdefault("country_name_to_iso3", {})

    for feature in payload.get("features", []):
        props = feature.get("properties", {})
        country_code = str(props.get("ADM0_A3") or props.get("ISO_A3") or props.get("NAME") or "").upper()
        iso2 = str(props.get("ISO_A2") or "").upper()
        if iso2 and country_code:
            iso2_to_iso3[iso2] = country_code
        if country_code:
            register_country_name_variants(
                country_name_to_iso3,
                country_code,
                props.get("NAME"),
                props.get("NAME_LONG"),
                props.get("ADMIN"),
                props.get("FORMAL_EN"),
                props.get("BRK_NAME"),
                props.get("NAME_EN"),
            )
            if country_code == "USA":
                register_country_name_variants(country_name_to_iso3, country_code, "US", "USA", "United States", "United States of America")
            elif country_code == "GBR":
                register_country_name_variants(country_name_to_iso3, country_code, "UK", "United Kingdom", "Great Britain", "England", "Scotland", "Wales", "Northern Ireland")
        place_id = f"country-{country_code}"
        data = {"geometry": feature.get("geometry"), "properties": props}
        rows.append(
            (
                place_id,
                "country",
                props.get("NAME") or props.get("NAME_LONG") or props.get("ADMIN"),
                country_code,
                None,
                None,
                json.dumps(data),
            )
        )
        source_state[place_id] = ("countries", hashlib.sha256(json.dumps(data, sort_keys=True).encode("utf-8")).hexdigest())
    return rows, source_state

def _collect_state_rows(payload: Any, context: Dict[str, Any]) -> Tuple[List[tuple], Dict[str, Tuple[str, str]]]:
    rows: List[tuple] = []
    source_state: Dict[str, Tuple[str, str]] = {}
    iso2_to_iso3: Dict[str, str] = context.setdefault("iso2_to_iso3", {})
    state_rows: Dict[Tuple[str, str], Tuple[str, str, str, Optional[float], Optional[float], str]] = {}

    for feature in payload.get("features", []):
        props = feature.get("properties", {})
        country_code = normalize_country_code(
            props.get("country_code")
            or props.get("iso_country")
            or props.get("ISO_A2")
            or props.get("COUNTRY_CODE")
            or props.get("iso_a2"),
            iso2_to_iso3,
        )
        state_code = extract_state_code(props)
        geometry = feature.get("geometry")
        if not country_code or not state_code or not is_polygonal_geometry(geometry):
            continue
        name = str(
            props.get("name")
            or props.get("NAME")
            or props.get("name_en")
            or props.get("region_name")
            or state_code
        ).strip() or state_code
        state_rows[(country_code, state_code)] = (
            f"state-{country_code}-{state_code}",
            "state",
            name,
            country_code,
            as_float(props.get("lat") or props.get("latitude") or props.get("center_lat")),
            as_float(props.get("lon") or props.get("longitude") or props.get("center_lon")),
            json.dumps(
                {
                    "state_code": state_code,
                    "country_code": country_code,
                    "name": name,
                    "geometry": geometry,
                    "geometry_properties": props,
                    "source": "state_regions.geojson",
                }
            ),
        )
    for state_row in state_rows.values():
        rows.append(state_row)
        source_state[state_row[0]] = ("state_regions", hashlib.sha256(state_row[6].encode("utf-8")).hexdigest())
    return rows, source_state

def _collect_city_rows(payload: Any, context: Dict[str, Any]) -> Tuple[List[tuple], Dict[str, Tuple[str, str]]]:
    rows: List[tuple] = []
    source_state: Dict[str, Tuple[str, str]] = {}
    iso2_to_iso3: Dict[str, str] = context.setdefault("iso2_to_iso3", {})

    for city in payload:
        name = city.get("name") or city.get("asciiname") or "Unknown city"
        country_code = normalize_country_code(city.get("country_code") or city.get("iso_country"), iso2_to_iso3)
        state_code = extract_state_code(city)
        lat = as_float(city.get("lat", city.get("latitude", city.get("latitude_deg"))))
        lon = as_float(city.get("lon", city.get("longitude", city.get("longitude_deg"))))
        place_id = city.get("id") or city.get("geonameid")
        if place_id is None:
            place_id = f"{slugify(name)}-{country_code or 'xx'}-{lat or 'na'}-{lon or 'na'}"
        place_id = str(place_id)
        if not place_id.startswith("city-"):
            place_id = f"city-{place_id}"
        city_payload = dict(city)
        if state_code:
            city_payload["state_code"] = state_code
        if country_code:
            city_payload["country_code"] = country_code
        rows.append(
            (
                place_id,
                "city",
                name,
                country_code,
                lat,
                lon,
                json.dumps(city_payload),
            )
        )
        source_state[place_id] = ("cities", hashlib.sha256(json.dumps(city_payload, sort_keys=True).encode("utf-8")).hexdigest())
    return rows, source_state

def _collect_airport_rows(payload: Any, context: Dict[str, Any]) -> Tuple[List[tuple], Dict[str, Tuple[str, str]]]:
    rows: List[tuple] = []
    source_state: Dict[str, Tuple[str, str]] = {}
    iso2_to_iso3: Dict[str, str] = context.setdefault("iso2_to_iso3", {})

    for airport in payload:
        if is_duplicate_airport_record(airport):
            continue
        name = airport.get("name") or airport.get("municipality") or "Unknown airport"
        country_code = normalize_country_code(airport.get("country_code") or airport.get("iso_country"), iso2_to_iso3)
        state_code = extract_state_code(airport)
        lat = as_float(airport.get("lat", airport.get("latitude", airport.get("latitude_deg"))))
        lon = as_float(airport.get("lon", airport.get("longitude", airport.get("longitude_deg"))))
        airport_id = airport.get("id") or airport.get("ident") or airport.get("icao_code") or airport.get("iata_code") or airport.get("gps_code") or airport.get("local_code")
        if airport_id is None:
            airport_id = f"{slugify(name)}-{country_code or 'xx'}-{lat or 'na'}-{lon or 'na'}"
        place_id = str(airport_id)
        if not place_id.startswith("airport-"):
            place_id = f"airport-{place_id}"
        airport_payload = dict(airport)
        if state_code:
            airport_payload["state_code"] = state_code
        if country_code:
            airport_payload["country_code"] = country_code
        rows.append(
            (
                place_id,
                "airport",
                name,
                country_code,
                lat,
                lon,
                json.dumps(airport_payload),
            )
        )
        source_state[place_id] = ("airports", hashlib.sha256(json.dumps(airport_payload, sort_keys=True).encode("utf-8")).hexdigest())
    return rows, source_state

def _collect_site_rows(payload: Any, context: Dict[str, Any]) -> Tuple[List[tuple], Dict[str, Tuple[str, str]]]:
    rows: List[tuple] = []
    source_state: Dict[str, Tuple[str, str]] = {}
    iso2_to_iso3: Dict[str, str] = context.setdefault("iso2_to_iso3", {})
    country_name_to_iso3: Dict[str, str] = context.setdefault("country_name_to_iso3", {})
    payload_groups = payload
    if not payload_groups or not isinstance(payload_groups, list) or "payload" not in payload_groups[0]:
        payload_groups = [{"filename": "site_dataset", "payload": payload}]

    for payload_group in payload_groups:
        filename = str(payload_group.get("filename") or "")
        source_payload = payload_group.get("payload") or []
        if filename == "festivals.json":
            source_entries = source_payload.get("entries") if isinstance(source_payload, dict) else source_payload
            if not isinstance(source_entries, list):
                source_entries = []
            for festival in source_entries:
                name = sanitize_markup_text(festival.get("name")) or "Unknown festival"
                alternate_names = [
                    item
                    for item in (sanitize_markup_text(value) for value in (festival.get("alternate_names") or []))
                    if item
                ]
                country_or_countries = [
                    item
                    for item in (sanitize_markup_text(value) for value in (festival.get("country_or_countries") or []))
                    if item
                ]
                resolved_country_codes = [
                    code
                    for code in (
                        infer_country_code_from_text(item, country_name_to_iso3) for item in country_or_countries
                    )
                    if code
                ]
                country_code = resolved_country_codes[0] if resolved_country_codes else None
                region = sanitize_markup_text(festival.get("region"))
                city_or_locality = sanitize_markup_text(festival.get("city_or_locality"))
                lat = as_float(festival.get("latitude"))
                lon = as_float(festival.get("longitude"))
                festival_type = sanitize_markup_text(festival.get("festival_type"))
                tradition = sanitize_markup_text(festival.get("tradition"))
                recurrence = sanitize_markup_text(festival.get("recurrence"))
                date_notes = sanitize_markup_text(festival.get("date_notes"))
                summary = sanitize_markup_text(festival.get("summary"))
                tags = [
                    item for item in (sanitize_markup_text(value) for value in (festival.get("tags") or [])) if item
                ]
                site_id = (
                    festival.get("id")
                    or f"festival-{slugify(name)}-{slugify(city_or_locality or region or country_code or 'anchor')}"
                )
                site_payload = {
                    "id": site_id,
                    "name": name,
                    "sourceType": "festival",
                    "alternateNames": alternate_names,
                    "country_code": country_code,
                    "country_codes": resolved_country_codes,
                    "countryOrCountries": country_or_countries,
                    "region": region,
                    "cityOrLocality": city_or_locality,
                    "lat": lat,
                    "lon": lon,
                    "latitude": lat,
                    "longitude": lon,
                    "summary": summary,
                    "tags": tags,
                    "category": "festival",
                    "type": festival_type,
                    "source": "cultural_festival_anchor",
                    "source_dataset": filename,
                    "festival_type": festival_type,
                    "tradition": tradition,
                    "recurrence": recurrence,
                    "date_notes": date_notes,
                    "globally_famous": bool(festival.get("globally_famous")),
                    "culturally_significant": bool(festival.get("culturally_significant")),
                    "heritage_recognized": bool(festival.get("heritage_recognized")),
                    "metadata": {
                        "festival_type": festival_type,
                        "tradition": tradition,
                        "recurrence": recurrence,
                        "date_notes": date_notes,
                        "globally_famous": bool(festival.get("globally_famous")),
                        "culturally_significant": bool(festival.get("culturally_significant")),
                        "heritage_recognized": bool(festival.get("heritage_recognized")),
                    },
                }
                place_id = str(site_id)
                if not place_id.startswith("site-"):
                    place_id = f"site-{place_id}"
                rows.append(
                    (
                        place_id,
                        "site",
                        name,
                        country_code,
                        lat,
                        lon,
                        json.dumps(site_payload),
                    )
                )
                source_state[place_id] = (
                    "sites",
                    hashlib.sha256(json.dumps(site_payload, sort_keys=True).encode("utf-8")).hexdigest(),
                )
            continue
        if filename == "michelin_restaurants.json":
            restaurant_entries = source_payload.get("restaurants") if isinstance(source_payload, dict) else source_payload
            if not isinstance(restaurant_entries, list):
                restaurant_entries = []

            grouped_entries: Dict[str, List[Dict[str, Any]]] = {}
            for restaurant in restaurant_entries:
                if not isinstance(restaurant, dict):
                    continue
                group_key = str(restaurant.get("link") or restaurant.get("name") or "").strip()
                if not group_key:
                    continue
                grouped_entries.setdefault(group_key, []).append(restaurant)

            for group_key, variants in grouped_entries.items():
                base_variant = next(
                    (
                        item
                        for item in variants
                        if sanitize_markup_text(item.get("name"))
                        and sanitize_markup_text(item.get("name")) != "Reserve a table"
                        and not str(sanitize_markup_text(item.get("name")) or "").startswith("Reserve a table ")
                    ),
                    None,
                )
                summary_variant = next(
                    (
                        item
                        for item in variants
                        if str(sanitize_markup_text(item.get("name")) or "").startswith("Reserve a table ")
                    ),
                    None,
                )
                representative = base_variant or summary_variant or variants[0]
                name = sanitize_markup_text(representative.get("name")) or "Unknown restaurant"
                if name == "Reserve a table":
                    continue

                summary_details = extract_michelin_summary_details(
                    summary_variant.get("name") if isinstance(summary_variant, dict) else None,
                    name,
                )
                location_text = (
                    sanitize_markup_text(representative.get("location"))
                    or summary_details["location"]
                )
                location_label, country_label = extract_michelin_location_parts(location_text)
                country_code = infer_country_code_from_text(country_label or location_text, country_name_to_iso3)
                price = sanitize_markup_text(representative.get("price")) or summary_details["price"]
                cuisine = sanitize_markup_text(representative.get("cuisine")) or summary_details["cuisine"]
                distinction = sanitize_markup_text(representative.get("distinction")) or "Michelin-starred restaurant"
                link = str(representative.get("link") or group_key).strip() or None
                source_page = str(representative.get("source_page") or "").strip() or None
                image = str(representative.get("image") or "").strip() or None
                tags = [item for item in [distinction, cuisine, price] if item]
                site_id = f"michelin-{slugify(link or name)}"
                site_payload = {
                    "id": site_id,
                    "name": name,
                    "sourceType": "michelin",
                    "alternateNames": [],
                    "country_code": country_code,
                    "country_codes": [country_code] if country_code else [],
                    "countryOrCountries": [country_label] if country_label else ([country_code] if country_code else []),
                    "region": None,
                    "cityOrLocality": location_label,
                    "lat": None,
                    "lon": None,
                    "latitude": None,
                    "longitude": None,
                    "summary": ", ".join(item for item in [location_text, cuisine, price] if item) or distinction,
                    "tags": tags,
                    "category": "michelin_restaurant",
                    "type": distinction,
                    "source": "guide_michelin",
                    "source_dataset": filename,
                    "link": link,
                    "source_page": source_page,
                    "price": price,
                    "cuisine": cuisine,
                    "distinction": distinction,
                    "image": image,
                    "metadata": {
                        "link": link,
                        "source_page": source_page,
                        "price": price,
                        "cuisine": cuisine,
                        "distinction": distinction,
                        "image": image,
                        "location": location_text,
                    },
                }
                place_id = str(site_id)
                if not place_id.startswith("site-"):
                    place_id = f"site-{place_id}"
                rows.append(
                    (
                        place_id,
                        "site",
                        name,
                        country_code,
                        None,
                        None,
                        json.dumps(site_payload),
                    )
                )
                source_state[place_id] = (
                    "sites",
                    hashlib.sha256(json.dumps(site_payload, sort_keys=True).encode("utf-8")).hexdigest(),
                )
            continue
        for site in source_payload:
            if filename == "whc001.json":
                name = sanitize_markup_text(site.get("name_en") or site.get("name")) or "Unknown site"
                coordinates = site.get("coordinates") or {}
                raw_iso_codes = str(site.get("iso_codes") or "").strip()
                country_codes = [code.strip().upper() for code in raw_iso_codes.split(",") if code.strip()]
                country_code = normalize_country_code(country_codes[0] if country_codes else None, iso2_to_iso3)
                lat = as_float(coordinates.get("lat"))
                lon = as_float(coordinates.get("lon"))
                site_id = site.get("id") or site.get("id_no") or site.get("uuid")
                if site_id is None:
                    site_id = f"unesco-{slugify(name)}-{country_code or 'xx'}-{lat or 'na'}-{lon or 'na'}"
                states_names = [
                    item for item in (sanitize_markup_text(value) for value in (site.get("states_names") or [])) if item
                ]
                region = sanitize_markup_text(site.get("region"))
                category_label = sanitize_markup_text(site.get("category"))
                criteria = sanitize_markup_text(site.get("criteria_txt"))
                short_description = sanitize_markup_text(site.get("short_description_en"))
                site_payload = {
                    "id": site_id,
                    "name": name,
                    "sourceType": "unesco",
                    "alternateNames": [],
                    "country_code": country_code,
                    "country_codes": country_codes,
                    "countryOrCountries": states_names or country_codes,
                    "region": region,
                    "cityOrLocality": None,
                    "lat": lat,
                    "lon": lon,
                    "latitude": lat,
                    "longitude": lon,
                    "summary": short_description,
                    "tags": [item for item in [category_label, criteria, region] if item],
                    "category": "heritage_unesco",
                    "type": category_label or "UNESCO World Heritage Site",
                    "source": "unesco_world_heritage",
                    "source_dataset": filename,
                    "unesco_id": str(site.get("id_no") or "").strip() or None,
                    "unesco_uuid": str(site.get("uuid") or "").strip() or None,
                    "states_names": states_names,
                    "category_label": category_label,
                    "criteria": criteria,
                    "date_inscribed": site.get("date_inscribed"),
                    "danger": str(site.get("danger") or "").strip().lower() == "true",
                    "transboundary": str(site.get("transboundary") or "").strip().lower() == "true",
                    "short_description": short_description,
                    "main_image_url": site.get("main_image_url"),
                    "metadata": {
                        "unesco_id": str(site.get("id_no") or "").strip() or None,
                        "unesco_uuid": str(site.get("uuid") or "").strip() or None,
                        "states_names": states_names,
                        "category_label": category_label,
                        "criteria": criteria,
                        "date_inscribed": site.get("date_inscribed"),
                        "danger": str(site.get("danger") or "").strip().lower() == "true",
                        "transboundary": str(site.get("transboundary") or "").strip().lower() == "true",
                        "main_image_url": site.get("main_image_url"),
                    },
                }
                state_code = None
            elif filename == "darksky.json":
                name = sanitize_markup_text(site.get("title")) or "Unknown site"
                excerpt = sanitize_markup_text(site.get("excerpt"))
                content = sanitize_markup_text(site.get("content"))
                category_label = extract_darksky_category_label(content)
                address = extract_darksky_address(content)
                lat, lon = extract_darksky_coordinates(content)
                country_code = (
                    infer_country_code_from_text(name, country_name_to_iso3)
                    or infer_country_code_from_text(address, country_name_to_iso3)
                )
                raw_slug = str(site.get("slug") or "").strip()
                site_id = f"darksky-{raw_slug or slugify(name)}"
                tags = [item for item in [category_label, address] if item]
                site_payload = {
                    "id": site_id,
                    "name": name,
                    "sourceType": "dark_sky",
                    "alternateNames": [],
                    "country_code": country_code,
                    "countryOrCountries": [country_code] if country_code else [],
                    "region": None,
                    "cityOrLocality": address,
                    "lat": lat,
                    "lon": lon,
                    "latitude": lat,
                    "longitude": lon,
                    "summary": excerpt or content,
                    "tags": tags,
                    "category": normalize_darksky_category(category_label),
                    "type": category_label,
                    "category_label": category_label,
                    "source": "darksky_international",
                    "source_dataset": filename,
                    "slug": str(site.get("slug") or "").strip() or None,
                    "link": str(site.get("link") or "").strip() or None,
                    "designation_date": str(site.get("date") or "").strip() or None,
                    "address": address,
                    "short_description": excerpt,
                    "description": content,
                    "designation_type": category_label,
                    "metadata": {
                        "slug": str(site.get("slug") or "").strip() or None,
                        "link": str(site.get("link") or "").strip() or None,
                        "designation_date": str(site.get("date") or "").strip() or None,
                        "address": address,
                        "description": content,
                        "designation_type": category_label,
                    },
                }
                state_code = None
            else:
                name = site.get("name") or "Unknown site"
                country_code = normalize_country_code(site.get("country_code") or site.get("iso_country"), iso2_to_iso3)
                state_code = extract_state_code(site)
                lat = as_float(site.get("lat", site.get("latitude", site.get("latitude_deg"))))
                lon = as_float(site.get("lon", site.get("longitude", site.get("longitude_deg"))))
                site_id = site.get("id")
                if site_id is None:
                    site_id = f"{slugify(name)}-{country_code or 'xx'}-{lat or 'na'}-{lon or 'na'}"
                site_payload = dict(site)
                site_payload.setdefault("source_dataset", filename or "site_dataset")

            place_id = str(site_id)
            if not place_id.startswith("site-"):
                place_id = f"site-{place_id}"
            if state_code:
                site_payload["state_code"] = state_code
            if country_code:
                site_payload["country_code"] = country_code
            rows.append(
                (
                    place_id,
                    "site",
                    name,
                    country_code,
                    lat,
                    lon,
                    json.dumps(site_payload),
                )
            )
            source_state[place_id] = ("sites", hashlib.sha256(json.dumps(site_payload, sort_keys=True).encode("utf-8")).hexdigest())
    return rows, source_state

SOURCE_COLLECTORS: Dict[str, SourceCollector] = {
    "countries": _collect_country_rows,
    "state_regions": _collect_state_rows,
    "cities": _collect_city_rows,
    "airports": _collect_airport_rows,
    "sites": _collect_site_rows,
}

def _collect_places_from_sources(source_keys: Optional[Set[str]] = None) -> Tuple[List[tuple], Dict[str, Tuple[str, str]]]:
    payloads = _load_source_payloads(source_keys)
    rows: List[tuple] = []
    source_state: Dict[str, Tuple[str, str]] = {}
    context: Dict[str, Any] = {"iso2_to_iso3": {}}

    for source_key in SOURCE_DATASET_DEFINITIONS:
        if source_key not in payloads:
            continue
        collector_rows, collector_state = SOURCE_COLLECTORS[source_key](payloads[source_key], context)
        rows.extend(collector_rows)
        source_state.update(collector_state)
    return rows, source_state

def _place_is_referenced(conn: DBConnection, place_id: str) -> bool:
    visit_ref = conn.execute("SELECT 1 FROM visits WHERE place_id = ? LIMIT 1", (place_id,)).fetchone()
    if visit_ref:
        return True
    trip_ref = conn.execute(
        """
        SELECT 1
        FROM trip_logs
        WHERE origin_place_id = ? OR destination_place_id = ? OR layover_place_ids LIKE ?
        LIMIT 1
        """,
        (place_id, place_id, f'%"{place_id}"%'),
    ).fetchone()
    return bool(trip_ref)

def _delete_removed_source_places(
    conn: DBConnection,
    expected_by_source: Dict[str, Set[str]],
    now: str,
    source_keys: Set[str],
) -> None:
    if not source_keys:
        return
    placeholders = ",".join("?" for _ in source_keys)
    rows = conn.execute(
        f"SELECT place_id, source_key, is_active FROM place_source_state WHERE source_key IN ({placeholders})",
        sorted(source_keys),
    ).fetchall()
    for row in rows:
        place_id = str(row["place_id"])
        source_key = str(row["source_key"])
        if place_id in expected_by_source.get(source_key, set()):
            continue
        if _place_is_referenced(conn, place_id):
            conn.execute(
                """
                UPDATE place_source_state
                SET is_active = ?, last_seen_at = ?
                WHERE place_id = ?
                """,
                (False, now, place_id),
            )
            continue
        conn.execute("DELETE FROM place_source_state WHERE place_id = ?", (place_id,))
        conn.execute("DELETE FROM places WHERE id = ?", (place_id,))

def sync_places_from_data_sources(conn: DBConnection, source_keys: Optional[Set[str]] = None) -> Dict[str, Any]:
    target_source_keys = source_keys or set(SOURCE_DATASET_DEFINITIONS.keys())
    rows, source_state = _collect_places_from_sources(target_source_keys)
    now = current_timestamp()

    if rows:
        conn.executemany(
            """
            INSERT INTO places (id, type, name, country_code, lat, lon, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                type = excluded.type,
                name = excluded.name,
                country_code = excluded.country_code,
                lat = excluded.lat,
                lon = excluded.lon,
                data = excluded.data
            """,
            rows,
        )
    source_rows = [
        (place_id, source_key, content_hash, True, now)
        for place_id, (source_key, content_hash) in source_state.items()
    ]
    if source_rows:
        conn.executemany(
            """
            INSERT INTO place_source_state (place_id, source_key, content_hash, is_active, last_seen_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(place_id) DO UPDATE SET
                source_key = excluded.source_key,
                content_hash = excluded.content_hash,
                is_active = excluded.is_active,
                last_seen_at = excluded.last_seen_at
            """,
            source_rows,
        )
    expected_by_source: Dict[str, Set[str]] = {}
    for place_id, (source_key, _) in source_state.items():
        expected_by_source.setdefault(source_key, set()).add(place_id)
    _delete_removed_source_places(conn, expected_by_source, now, target_source_keys)
    return {
        "place_count": len(rows),
        "source_count": len(source_rows),
        "source_digests": _compute_source_digests(),
        "synced_at": now,
    }

def seed_db() -> None:
    init_db()
    with get_db() as conn:
        result = sync_places_from_data_sources(conn)
        _set_app_settings(
            conn,
            {
                "data_sync.source_digests": json.dumps(result["source_digests"], sort_keys=True),
                "data_sync.schema_version": json.dumps(DATA_SYNC_SCHEMA_VERSION),
                "data_sync.last_synced_at": result["synced_at"],
                "data_sync.last_sync_reason": "seed_db",
            },
        )

def _app_setting_json(conn: DBConnection, key: str) -> Any:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    if not row:
        return None
    try:
        return json.loads(str(row["value"]))
    except json.JSONDecodeError:
        return None

def sync_data_sources_if_needed(*, force: bool = False, reason: str = "manual") -> Dict[str, Any]:
    init_db()
    digests = _compute_source_digests()
    auto_sync_keys = {
        source_key for source_key, config in SOURCE_DATASET_DEFINITIONS.items() if bool(config.get("auto_sync"))
    }
    tracked_digests = {source_key: digests[source_key] for source_key in auto_sync_keys if source_key in digests}
    with get_db() as conn:
        previous_digests = _app_setting_json(conn, "data_sync.source_digests") or {}
        previous_schema_version = int(_app_setting_json(conn, "data_sync.schema_version") or 0)
        if not force and tracked_digests == previous_digests and previous_schema_version == DATA_SYNC_SCHEMA_VERSION:
            return {
                "changed": False,
                "reason": reason,
                "source_digests": tracked_digests,
            }

        result = sync_places_from_data_sources(conn, auto_sync_keys if not force else None)
        settings = {
            "data_sync.source_digests": json.dumps(tracked_digests, sort_keys=True),
            "data_sync.schema_version": json.dumps(DATA_SYNC_SCHEMA_VERSION),
            "data_sync.last_synced_at": result["synced_at"],
            "data_sync.last_sync_reason": reason,
        }
        _set_app_settings(conn, settings)
        logger.info(
            "[data-sync] synced %s places from %s sources (reason=%s)",
            result["place_count"],
            len(result["source_digests"]),
            reason,
        )
        return {
            "changed": True,
            "reason": reason,
            "source_digests": result["source_digests"],
            "place_count": result["place_count"],
        }

def _data_sync_loop() -> None:
    if DATA_SYNC_INTERVAL_SECONDS <= 0:
        return
    while not DATA_SYNC_STOP_EVENT.wait(DATA_SYNC_INTERVAL_SECONDS):
        try:
            sync_data_sources_if_needed(reason="poll")
        except Exception:
            logger.exception("[data-sync] poll failed")

def start_data_sync_thread() -> None:
    global DATA_SYNC_THREAD
    if DATA_SYNC_INTERVAL_SECONDS <= 0:
        return
    with DATA_SYNC_THREAD_LOCK:
        if DATA_SYNC_THREAD and DATA_SYNC_THREAD.is_alive():
            return
        DATA_SYNC_STOP_EVENT.clear()
        DATA_SYNC_THREAD = threading.Thread(target=_data_sync_loop, name="data-sync", daemon=True)
        DATA_SYNC_THREAD.start()

def stop_data_sync_thread() -> None:
    global DATA_SYNC_THREAD
    with DATA_SYNC_THREAD_LOCK:
        DATA_SYNC_STOP_EVENT.set()
        if DATA_SYNC_THREAD and DATA_SYNC_THREAD.is_alive():
            DATA_SYNC_THREAD.join(timeout=2)
        DATA_SYNC_THREAD = None


__all__ = [
    '_source_paths',
    '_compute_source_digests',
    '_load_source_payloads',
    '_collect_country_rows',
    '_collect_state_rows',
    '_collect_city_rows',
    '_collect_airport_rows',
    '_collect_site_rows',
    'SOURCE_COLLECTORS',
    '_collect_places_from_sources',
    '_place_is_referenced',
    '_delete_removed_source_places',
    'sync_places_from_data_sources',
    'seed_db',
    '_app_setting_json',
    'sync_data_sources_if_needed',
    '_data_sync_loop',
    'start_data_sync_thread',
    'stop_data_sync_thread',
]
