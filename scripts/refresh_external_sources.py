#!/usr/bin/env python3
from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data_sources"
AIRPORTS_PATH = DATA_DIR / "airports.json"
CITIES_PATH = DATA_DIR / "cities.json"

OURAIRPORTS_URL = "https://ourairports.com/data/airports.csv"
GEONAMES_CITIES15000_ZIP = "https://download.geonames.org/export/dump/cities15000.zip"

USER_AGENT = "places-been-data-refresh/1.0"
IATA_RE = re.compile(r"^[A-Z]{3}$")


def http_get(url: str, *, params: dict[str, str] | None = None, timeout: int = 60) -> bytes:
    query = f"{url}?{urlencode(params)}" if params else url
    request = Request(query, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_airports() -> list[dict]:
    raw = http_get(OURAIRPORTS_URL)
    rows = []
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8", errors="ignore")))
    for row in reader:
        airport_type = row.get("type", "")
        iata_code = (row.get("iata_code") or "").strip().upper()
        if airport_type not in {"large_airport", "medium_airport"}:
            continue
        if not IATA_RE.match(iata_code):
            continue
        rows.append(
            {
                "id": row.get("id") or row.get("ident") or iata_code,
                "ident": row.get("ident"),
                "type": airport_type,
                "name": row.get("name"),
                "latitude_deg": row.get("latitude_deg"),
                "longitude_deg": row.get("longitude_deg"),
                "elevation_ft": row.get("elevation_ft"),
                "iso_country": row.get("iso_country"),
                "iso_region": row.get("iso_region"),
                "municipality": row.get("municipality"),
                "scheduled_service": row.get("scheduled_service"),
                "gps_code": row.get("gps_code"),
                "iata_code": iata_code,
                "local_code": row.get("local_code"),
                "home_link": row.get("home_link"),
                "wikipedia_link": row.get("wikipedia_link"),
                "keywords": row.get("keywords"),
            }
        )
    return rows


def fetch_cities() -> list[dict]:
    raw_zip = http_get(GEONAMES_CITIES15000_ZIP)
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as archive:
        with archive.open("cities15000.txt", "r") as handle:
            text = handle.read().decode("utf-8", errors="ignore")

    cities: list[dict] = []
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 19:
            continue
        if parts[6] != "P":
            continue
        population = int(parts[14] or "0")
        if population < 10000:
            continue
        cities.append(
            {
                "geonameid": parts[0],
                "name": parts[1],
                "asciiname": parts[2],
                "alternatenames": parts[3],
                "latitude": parts[4],
                "longitude": parts[5],
                "feature_class": parts[6],
                "feature_code": parts[7],
                "country_code": parts[8],
                "cc2": parts[9],
                "admin1_code": parts[10],
                "admin2_code": parts[11],
                "admin3_code": parts[12],
                "admin4_code": parts[13],
                "population": parts[14],
                "elevation": parts[15],
                "dem": parts[16],
                "timezone": parts[17],
                "modification_date": parts[18],
            }
        )
    return cities



def write_json(path: Path, payload) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, indent=2)
        handle.write("\n")


def main() -> None:
    print("Refreshing airports...")
    airports = fetch_airports()
    write_json(AIRPORTS_PATH, airports)
    print(f"  airports: {len(airports)}")

    print("Refreshing cities...")
    cities = fetch_cities()
    write_json(CITIES_PATH, cities)
    print(f"  cities: {len(cities)}")
    print("Skipping split site datasets (managed via whc001.json, darksky.json, festivals.json, and michelin_restaurants.json).")
    print("Done. Re-run seed script to push changes into the database: python3 scripts/seed_db.py")


if __name__ == "__main__":
    main()
