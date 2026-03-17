#!/usr/bin/env python3
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


ROOT = Path(__file__).resolve().parents[1]
DATA_SOURCES_DIR = ROOT / "data_sources"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def as_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def is_polygonal_geometry(geometry: Any) -> bool:
    return isinstance(geometry, dict) and str(geometry.get("type") or "").strip() in {"Polygon", "MultiPolygon"}


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
        state_code = region.split("-", 1)[1] if "-" in region else region
    if not state_code and item.get("iso_region"):
        region = str(item.get("iso_region"))
        state_code = region.split("-", 1)[1] if "-" in region else region
    text = str(state_code or "").strip().upper()
    return text or None


def count_missing_point_fields(rows: Iterable[Dict[str, Any]]) -> int:
    missing = 0
    for row in rows:
        lat = as_float(row.get("lat", row.get("latitude", row.get("latitude_deg"))))
        lon = as_float(row.get("lon", row.get("longitude", row.get("longitude_deg"))))
        if lat is None or lon is None:
            missing += 1
    return missing


def main() -> int:
    countries = load_json(DATA_SOURCES_DIR / "countries.geojson")
    states = load_json(DATA_SOURCES_DIR / "state_regions.geojson")
    cities = load_json(DATA_SOURCES_DIR / "cities.json")
    airports = load_json(DATA_SOURCES_DIR / "airports.json")
    sites = load_json(DATA_SOURCES_DIR / "sites.json")

    iso2_to_iso3: Dict[str, str] = {}
    missing_country_fields: Counter[str] = Counter()
    for feature in countries.get("features", []):
        props = feature.get("properties", {})
        iso3 = str(props.get("ADM0_A3") or props.get("ISO_A3") or props.get("NAME") or "").upper()
        iso2 = str(props.get("ISO_A2") or "").upper()
        if iso2 and iso3:
            iso2_to_iso3[iso2] = iso3
        if not iso3:
            missing_country_fields["country_code"] += 1
        if not (props.get("NAME") or props.get("NAME_LONG") or props.get("ADMIN")):
            missing_country_fields["country_name"] += 1

    state_issues: Counter[str] = Counter()
    usable_states = 0
    for feature in states.get("features", []):
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
        if not country_code:
            state_issues["missing_country_code"] += 1
        if not state_code:
            state_issues["missing_state_code"] += 1
        if not is_polygonal_geometry(geometry):
            state_issues["non_polygon_geometry"] += 1
        if country_code and state_code and is_polygonal_geometry(geometry):
            usable_states += 1

    point_country_missing = Counter()
    for label, rows in (("city", cities), ("airport", airports), ("site", sites)):
        for row in rows:
            country_code = normalize_country_code(row.get("country_code") or row.get("iso_country"), iso2_to_iso3)
            if not country_code:
                point_country_missing[label] += 1

    print("Source audit")
    print(f"countries: {len(countries.get('features', []))} features")
    print(f"states: {len(states.get('features', []))} features, {usable_states} usable")
    print(f"cities: {len(cities)} rows")
    print(f"airports: {len(airports)} rows")
    print(f"sites: {len(sites)} rows")
    print()
    print(f"country issues: {dict(missing_country_fields)}")
    print(f"state issues: {dict(state_issues)}")
    print(f"point rows missing country code: {dict(point_country_missing)}")
    print(
        "point rows missing coordinates: "
        f"{{'city': {count_missing_point_fields(cities)}, "
        f"'airport': {count_missing_point_fields(airports)}, "
        f"'site': {count_missing_point_fields(sites)}}}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
