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
SITES_PATH = DATA_DIR / "sites.json"

OURAIRPORTS_URL = "https://ourairports.com/data/airports.csv"
GEONAMES_CITIES15000_ZIP = "https://download.geonames.org/export/dump/cities15000.zip"
WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

USER_AGENT = "places-been-data-refresh/1.0"
IATA_RE = re.compile(r"^[A-Z]{3}$")


def http_get(url: str, *, params: dict[str, str] | None = None, timeout: int = 60) -> bytes:
    query = f"{url}?{urlencode(params)}" if params else url
    request = Request(query, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def slug(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return text or "item"


def parse_point_literal(value: str) -> tuple[float, float] | None:
    match = re.match(r"^Point\(([-0-9.]+) ([-0-9.]+)\)$", value)
    if not match:
        return None
    lon = float(match.group(1))
    lat = float(match.group(2))
    return lat, lon


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


def sparql(query: str) -> list[dict]:
    raw = http_get(
        WIKIDATA_SPARQL_URL,
        params={"query": query, "format": "json"},
        timeout=90,
    )
    payload = json.loads(raw)
    return payload.get("results", {}).get("bindings", [])


def binding_value(binding: dict, key: str) -> str:
    return str(binding.get(key, {}).get("value", "")).strip()


def wikidata_sites(query: str, category: str, prefix: str) -> list[dict]:
    records = []
    for row in sparql(query):
        name = binding_value(row, "itemLabel")
        country_code = binding_value(row, "countryCode").upper() or None
        coord = parse_point_literal(binding_value(row, "coord"))
        if not name or not coord:
            continue
        lat, lon = coord
        records.append(
            {
                "id": f"{prefix}-{slug(name)}",
                "name": name,
                "country_code": country_code,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "category": category,
                "source": "wikidata",
            }
        )
    return records


def fetch_unesco_sites() -> list[dict]:
    query = """
    SELECT ?item ?itemLabel ?coord ?countryCode WHERE {
      ?item wdt:P1435 wd:Q9259;
            wdt:P625 ?coord.
      OPTIONAL {
        ?item wdt:P17 ?country.
        ?country wdt:P297 ?countryCode.
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    """
    return wikidata_sites(query, "heritage_unesco", "site-unesco")


def fetch_protected_areas() -> list[dict]:
    query = """
    SELECT ?item ?itemLabel ?coord ?countryCode WHERE {
      ?item wdt:P31/wdt:P279* wd:Q46169;
            wdt:P625 ?coord.
      OPTIONAL {
        ?item wdt:P17 ?country.
        ?country wdt:P297 ?countryCode.
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 2000
    """
    return wikidata_sites(query, "protected_area", "site-protected")


def fetch_michelin_restaurants() -> list[dict]:
    query = """
    SELECT ?item ?itemLabel ?coord ?countryCode WHERE {
      ?item wdt:P166 wd:Q17106741;
            wdt:P625 ?coord.
      OPTIONAL {
        ?item wdt:P17 ?country.
        ?country wdt:P297 ?countryCode.
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 2000
    """
    return wikidata_sites(query, "michelin_starred", "site-michelin")


def fetch_osm_famous_beverage_places() -> list[dict]:
    query = """
    [out:json][timeout:90];
    (
      nwr["craft"~"brewery|winery|distillery"]["wikidata"];
      nwr["industrial"~"brewery|winery|distillery"]["wikidata"];
      nwr["tourism"="vineyard"]["wikidata"];
    );
    out center qt 800;
    """
    raw = http_get(OVERPASS_URL, params={"data": query}, timeout=120)
    payload = json.loads(raw)
    rows = []
    for element in payload.get("elements", []):
        tags = element.get("tags", {})
        name = (tags.get("name") or "").strip()
        if not name:
            continue
        lat = element.get("lat") or element.get("center", {}).get("lat")
        lon = element.get("lon") or element.get("center", {}).get("lon")
        if lat is None or lon is None:
            continue
        rows.append(
            {
                "id": f"site-drink-{element.get('type', 'node')}-{element.get('id')}",
                "name": name,
                "lat": float(lat),
                "lon": float(lon),
                "country_code": (tags.get("addr:country") or "").upper() or None,
                "category": "brewery_winery_distillery",
                "source": "openstreetmap_overpass",
            }
        )
    return rows


def curated_wonders() -> list[dict]:
    return [
        {"id": "site-wonder-giza", "name": "Great Pyramid of Giza", "country_code": "EGY", "lat": 29.9792, "lon": 31.1342, "category": "wonder_ancient", "source": "curated"},
        {"id": "site-wonder-machu-picchu", "name": "Machu Picchu", "country_code": "PER", "lat": -13.1631, "lon": -72.545, "category": "wonder_modern", "source": "curated"},
        {"id": "site-wonder-petra", "name": "Petra", "country_code": "JOR", "lat": 30.3285, "lon": 35.4444, "category": "wonder_modern", "source": "curated"},
        {"id": "site-wonder-colosseum", "name": "Colosseum", "country_code": "ITA", "lat": 41.8902, "lon": 12.4922, "category": "wonder_modern", "source": "curated"},
        {"id": "site-wonder-victoria-falls", "name": "Victoria Falls", "country_code": "ZWE", "lat": -17.9243, "lon": 25.8572, "category": "wonder_natural", "source": "curated"},
        {"id": "site-wonder-grand-canyon", "name": "Grand Canyon", "country_code": "USA", "lat": 36.1069, "lon": -112.1129, "category": "wonder_natural", "source": "curated"},
        {"id": "site-wonder-great-barrier-reef", "name": "Great Barrier Reef", "country_code": "AUS", "lat": -18.2871, "lon": 147.6992, "category": "wonder_natural", "source": "curated"},
    ]


def curated_worlds_50_best() -> list[dict]:
    return [
        {"id": "site-50best-central", "name": "Central", "country_code": "PER", "lat": -12.132, "lon": -77.0308, "category": "worlds_50_best_restaurant", "source": "curated"},
        {"id": "site-50best-disfrutar", "name": "Disfrutar", "country_code": "ESP", "lat": 41.392, "lon": 2.1528, "category": "worlds_50_best_restaurant", "source": "curated"},
        {"id": "site-50best-asador", "name": "Asador Etxebarri", "country_code": "ESP", "lat": 43.1292, "lon": -2.6068, "category": "worlds_50_best_restaurant", "source": "curated"},
    ]


def dedupe_sites(rows: list[dict]) -> list[dict]:
    deduped: dict[str, dict] = {}
    for row in rows:
        row_id = str(row.get("id") or "").strip()
        if not row_id:
            continue
        deduped[row_id] = row
    return sorted(deduped.values(), key=lambda item: (str(item.get("category") or ""), item.get("name", "")))


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

    print("Refreshing sites...")
    sites: list[dict] = []
    sites.extend(fetch_unesco_sites())
    sites.extend(fetch_protected_areas())
    sites.extend(fetch_michelin_restaurants())
    sites.extend(fetch_osm_famous_beverage_places())
    sites.extend(curated_wonders())
    sites.extend(curated_worlds_50_best())

    existing_sites = []
    if SITES_PATH.exists():
        existing_sites = json.loads(SITES_PATH.read_text(encoding="utf-8"))

    merged = dedupe_sites([*existing_sites, *sites])
    write_json(SITES_PATH, merged)
    print(f"  sites: {len(merged)}")
    print("Done. Re-run seed script to push changes into the database: python3 scripts/seed_db.py")


if __name__ == "__main__":
    main()
