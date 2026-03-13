#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from statistics import mean
from urllib.request import urlopen

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / 'data_sources'
CITIES_PATH = DATA_DIR / 'cities.json'
AIRPORTS_PATH = DATA_DIR / 'airports.json'
OUTPUT_PATH = DATA_DIR / 'state_regions.json'
GEONAMES_ADMIN1_URL = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt'


def as_float(value):
    if value in (None, ''):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_json(path: Path):
    with path.open('r', encoding='utf-8') as handle:
        return json.load(handle)


def fetch_admin1_names() -> dict[tuple[str, str], str]:
    mapping: dict[tuple[str, str], str] = {}
    with urlopen(GEONAMES_ADMIN1_URL, timeout=30) as response:
        for raw_line in response.read().decode('utf-8', errors='ignore').splitlines():
            if not raw_line or raw_line.startswith('#'):
                continue
            parts = raw_line.split('\t')
            if len(parts) < 2:
                continue
            code = parts[0].strip()
            name = parts[1].strip()
            if not code or not name or '.' not in code:
                continue
            country_code, admin1 = code.split('.', 1)
            mapping[(country_code.upper(), admin1.upper())] = name
    return mapping


def update_state_coords(state_coords: dict[tuple[str, str], list[tuple[float, float]]], country_code: str, state_code: str, lat: float | None, lon: float | None):
    if not country_code or not state_code or lat is None or lon is None:
        return
    key = (country_code.upper(), state_code.upper())
    state_coords.setdefault(key, []).append((lat, lon))


def main() -> None:
    cities = load_json(CITIES_PATH)
    airports = load_json(AIRPORTS_PATH)
    admin1_names = fetch_admin1_names()

    state_coords: dict[tuple[str, str], list[tuple[float, float]]] = {}

    for city in cities:
        country_code = str(city.get('country_code') or '').strip().upper()
        state_code = str(city.get('admin1_code') or city.get('state_code') or '').strip().upper()
        lat = as_float(city.get('latitude'))
        lon = as_float(city.get('longitude'))
        update_state_coords(state_coords, country_code, state_code, lat, lon)

    for airport in airports:
        country_code = str(airport.get('iso_country') or '').strip().upper()
        region = str(airport.get('iso_region') or '').strip().upper()
        state_code = region.split('-', 1)[1] if '-' in region else ''
        lat = as_float(airport.get('latitude_deg'))
        lon = as_float(airport.get('longitude_deg'))
        update_state_coords(state_coords, country_code, state_code, lat, lon)

    regions = []
    for (iso2, state_code), points in sorted(state_coords.items()):
        if not iso2 or not state_code:
            continue
        name = admin1_names.get((iso2, state_code), state_code)
        avg_lat = mean(point[0] for point in points)
        avg_lon = mean(point[1] for point in points)
        regions.append(
            {
                'country_code': iso2,
                'state_code': state_code,
                'name': name,
                'lat': round(avg_lat, 6),
                'lon': round(avg_lon, 6),
                'source': 'geonames_admin1 + city/airport centroids',
            }
        )

    with OUTPUT_PATH.open('w', encoding='utf-8') as handle:
        json.dump(regions, handle, ensure_ascii=True, indent=2)
        handle.write('\n')

    print(f'Wrote {len(regions)} regions to {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
