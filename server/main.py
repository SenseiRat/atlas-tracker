from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "app.db"
DATA_SOURCES_DIR = Path(os.environ.get("DATA_SOURCES_DIR", "data_sources"))
FRONTEND_DIST = Path(os.environ.get("FRONTEND_DIST", "frontend/dist"))

app = FastAPI(title="World Visited Tracker")
VALID_PLACE_TYPES = {"country", "city", "airport", "site"}


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    country_code TEXT,
    lat REAL,
    lon REAL,
    data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
    profile_id INTEGER NOT NULL,
    place_id TEXT NOT NULL,
    visited_at TEXT,
    trip_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, place_id),
    FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE,
    FOREIGN KEY (place_id) REFERENCES places (id) ON DELETE CASCADE
);
"""


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        conn.executescript(SCHEMA_SQL)


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def seed_profiles(conn: sqlite3.Connection) -> None:
    # Intentionally empty: first profile is now created via web UI on first run.
    _ = conn


def seed_places(conn: sqlite3.Connection) -> None:
    countries = load_json(DATA_SOURCES_DIR / "countries.geojson")
    cities = load_json(DATA_SOURCES_DIR / "cities.json")
    airports = load_json(DATA_SOURCES_DIR / "airports.json")
    sites = load_json(DATA_SOURCES_DIR / "sites.json")

    rows: List[tuple] = []

    for feature in countries.get("features", []):
        props = feature.get("properties", {})
        place_id = f"country-{props.get('ADM0_A3') or props.get('ISO_A3') or props.get('NAME')}"
        data = {"geometry": feature.get("geometry"), "properties": props}
        rows.append(
            (
                place_id,
                "country",
                props.get("NAME") or props.get("NAME_LONG") or props.get("ADMIN"),
                props.get("ADM0_A3") or props.get("ISO_A3"),
                None,
                None,
                json.dumps(data),
            )
        )

    for city in cities:
        rows.append(
            (
                city["id"],
                "city",
                city["name"],
                city.get("country_code"),
                city.get("lat"),
                city.get("lon"),
                json.dumps(city),
            )
        )

    for airport in airports:
        rows.append(
            (
                airport["id"],
                "airport",
                airport["name"],
                airport.get("country_code"),
                airport.get("lat"),
                airport.get("lon"),
                json.dumps(airport),
            )
        )

    for site in sites:
        rows.append(
            (
                site["id"],
                "site",
                site["name"],
                site.get("country_code"),
                site.get("lat"),
                site.get("lon"),
                json.dumps(site),
            )
        )

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


def seed_db() -> None:
    init_db()
    with get_db() as conn:
        seed_profiles(conn)
        seed_places(conn)


def count_by_type(conn: sqlite3.Connection, place_type: str, visited_ids: List[str]) -> int:
    if not visited_ids:
        return 0
    placeholders = ",".join("?" for _ in visited_ids)
    return conn.execute(
        f"SELECT COUNT(*) as count FROM places WHERE type = ? AND id IN ({placeholders})",
        [place_type, *visited_ids],
    ).fetchone()["count"]


@app.on_event("startup")
async def startup_event() -> None:
    seed_db()


@app.get("/api/profiles")
async def get_profiles() -> List[Dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute("SELECT id, name FROM profiles ORDER BY name").fetchall()
    return [dict(row) for row in rows]


@app.post("/api/profiles")
async def create_profile(payload: Dict[str, Any]) -> Dict[str, Any]:
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    now = datetime.utcnow().isoformat()
    with get_db() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO profiles (name, created_at) VALUES (?, ?)",
                (name, now),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=400, detail="Profile already exists") from exc
        profile_id = cursor.lastrowid
    return {"id": profile_id, "name": name}


@app.put("/api/profiles/{profile_id}")
async def update_profile(profile_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    with get_db() as conn:
        profile = conn.execute("SELECT id FROM profiles WHERE id = ?", (profile_id,)).fetchone()
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        try:
            conn.execute("UPDATE profiles SET name = ? WHERE id = ?", (name, profile_id))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=400, detail="Profile already exists") from exc
    return {"id": profile_id, "name": name}


@app.delete("/api/profiles/{profile_id}")
async def delete_profile(profile_id: int) -> Dict[str, Any]:
    with get_db() as conn:
        profile = conn.execute("SELECT id FROM profiles WHERE id = ?", (profile_id,)).fetchone()
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
    return {"status": "ok"}


@app.get("/api/places")
async def get_places(
    type: str = Query(...),
    query: Optional[str] = None,
    limit: int = 1000,
    offset: int = 0,
) -> Dict[str, Any]:
    if type not in VALID_PLACE_TYPES:
        raise HTTPException(status_code=400, detail="Invalid place type")
    params: List[Any] = [type]
    where = "WHERE type = ?"
    if query:
        where += " AND name LIKE ?"
        params.append(f"%{query}%")
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT id, name, country_code, lat, lon, data FROM places {where} ORDER BY name LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) as count FROM places {where}",
            params,
        ).fetchone()["count"]
    return {
        "items": [dict(row) for row in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.get("/api/places/geojson")
async def get_places_geojson(type: str) -> Dict[str, Any]:
    if type not in VALID_PLACE_TYPES:
        raise HTTPException(status_code=400, detail="Invalid place type")
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, country_code, lat, lon, data FROM places WHERE type = ?",
            (type,),
        ).fetchall()
    features = []
    for row in rows:
        data = json.loads(row["data"])
        if type == "country":
            geometry = data.get("geometry")
        else:
            geometry = {
                "type": "Point",
                "coordinates": [row["lon"], row["lat"]],
            }
        features.append(
            {
                "type": "Feature",
                "id": row["id"],
                "geometry": geometry,
                "properties": {
                    "name": row["name"],
                    "country_code": row["country_code"],
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


@app.get("/api/visits")
async def get_visits(profile_id: Optional[int] = None) -> List[Dict[str, Any]]:
    with get_db() as conn:
        if profile_id is None:
            rows = conn.execute(
                "SELECT profile_id, place_id, visited_at, trip_id FROM visits",
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT profile_id, place_id, visited_at, trip_id FROM visits WHERE profile_id = ?",
                (profile_id,),
            ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/visits/toggle")
async def toggle_visit(payload: Dict[str, Any]) -> Dict[str, Any]:
    profile_id = payload.get("profile_id")
    place_id = payload.get("place_id")
    visited = payload.get("visited")
    visited_at = payload.get("visited_at")
    trip_id = payload.get("trip_id")

    if profile_id is None or place_id is None or visited is None:
        raise HTTPException(status_code=400, detail="profile_id, place_id, visited required")

    with get_db() as conn:
        try:
            if visited:
                conn.execute(
                    "INSERT OR REPLACE INTO visits (profile_id, place_id, visited_at, trip_id, created_at) VALUES (?, ?, ?, ?, ?)",
                    (
                        profile_id,
                        place_id,
                        visited_at,
                        trip_id,
                        datetime.utcnow().isoformat(),
                    ),
                )
            else:
                conn.execute(
                    "DELETE FROM visits WHERE profile_id = ? AND place_id = ?",
                    (profile_id, place_id),
                )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=400, detail="Invalid profile_id or place_id") from exc
    return {"profile_id": profile_id, "place_id": place_id, "visited": visited}


@app.get("/api/stats")
async def get_stats(profile_id: Optional[int] = None) -> Dict[str, Any]:
    with get_db() as conn:
        total_countries = conn.execute(
            "SELECT COUNT(*) as count FROM places WHERE type = 'country'",
        ).fetchone()["count"]
        total_cities = conn.execute(
            "SELECT COUNT(*) as count FROM places WHERE type = 'city'",
        ).fetchone()["count"]
        total_airports = conn.execute(
            "SELECT COUNT(*) as count FROM places WHERE type = 'airport'",
        ).fetchone()["count"]
        total_sites = conn.execute(
            "SELECT COUNT(*) as count FROM places WHERE type = 'site'",
        ).fetchone()["count"]

        if profile_id is None:
            visited_rows = conn.execute("SELECT DISTINCT place_id FROM visits").fetchall()
        else:
            visited_rows = conn.execute(
                "SELECT place_id FROM visits WHERE profile_id = ?",
                (profile_id,),
            ).fetchall()

        visited_ids = [row["place_id"] for row in visited_rows]

        visited_countries = count_by_type(conn, "country", visited_ids)
        visited_cities = count_by_type(conn, "city", visited_ids)
        visited_airports = count_by_type(conn, "airport", visited_ids)
        visited_sites = count_by_type(conn, "site", visited_ids)

    world_percent = (visited_countries / total_countries * 100) if total_countries else 0

    return {
        "countries": {
            "visited": visited_countries,
            "total": total_countries,
            "percent": round(world_percent, 1),
        },
        "cities": {"visited": visited_cities, "total": total_cities},
        "airports": {"visited": visited_airports, "total": total_airports},
        "sites": {"visited": visited_sites, "total": total_sites},
    }


@app.get("/api/export")
async def export_data(profile_id: int) -> JSONResponse:
    with get_db() as conn:
        visits = conn.execute(
            "SELECT place_id, visited_at, trip_id FROM visits WHERE profile_id = ?",
            (profile_id,),
        ).fetchall()
    payload = {
        "profile_id": profile_id,
        "visits": [dict(row) for row in visits],
        "exported_at": datetime.utcnow().isoformat(),
    }
    return JSONResponse(content=payload)


@app.post("/api/import")
async def import_data(profile_id: int, file: UploadFile = File(...)) -> Dict[str, Any]:
    content = await file.read()
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON") from exc
    visits = payload.get("visits")
    if not isinstance(visits, list):
        raise HTTPException(status_code=400, detail="Invalid visits data")

    with get_db() as conn:
        try:
            conn.execute("DELETE FROM visits WHERE profile_id = ?", (profile_id,))
            for visit in visits:
                conn.execute(
                    "INSERT OR REPLACE INTO visits (profile_id, place_id, visited_at, trip_id, created_at) VALUES (?, ?, ?, ?, ?)",
                    (
                        profile_id,
                        visit.get("place_id"),
                        visit.get("visited_at"),
                        visit.get("trip_id"),
                        datetime.utcnow().isoformat(),
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=400, detail="Import contains invalid place IDs") from exc
    return {"status": "ok", "imported": len(visits)}


if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")


@app.get("/")
async def root() -> FileResponse:
    index_path = FRONTEND_DIST / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return FileResponse(str(Path(__file__).parent / "placeholder.html"))
