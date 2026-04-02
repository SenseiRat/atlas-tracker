from __future__ import annotations

import json
import base64
import hashlib
import html
import hmac
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
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Set, Tuple

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_HOST = os.environ.get("DB_HOST", "").strip()
DB_PORT = int(os.environ.get("DB_PORT", "5432"))
DB_NAME = os.environ.get("DB_NAME", "").strip()
DB_USER = os.environ.get("DB_USER", "postgres").strip()
DB_PASSWORD = os.environ.get("DB_PASSWORD", "").strip()
DB_SSLMODE = os.environ.get("DB_SSLMODE", "prefer").strip()
SQLITE_DB_PATH_RAW = os.environ.get("SQLITE_DB_PATH", "").strip()
DB_PATH = Path(SQLITE_DB_PATH_RAW).expanduser() if SQLITE_DB_PATH_RAW else (DATA_DIR / "app.db")
DATA_SOURCES_DIR = Path(os.environ.get("DATA_SOURCES_DIR", "data_sources"))
FRONTEND_DIST = Path(os.environ.get("FRONTEND_DIST", "frontend/dist"))
SQLITE_BUSY_TIMEOUT_MS = int(os.environ.get("SQLITE_BUSY_TIMEOUT_MS", "5000"))
SQLITE_ENABLE_WAL = os.environ.get("SQLITE_ENABLE_WAL", "1").strip().lower() not in {"0", "false", "no"}
IMPORT_MAX_BYTES = int(os.environ.get("IMPORT_MAX_BYTES", str(10 * 1024 * 1024)))
OIDC_ISSUER = os.environ.get("OIDC_ISSUER", "").strip()
OIDC_CLIENT_ID = os.environ.get("OIDC_CLIENT_ID", "").strip()
OIDC_CLIENT_SECRET = os.environ.get("OIDC_CLIENT_SECRET", "").strip()
OIDC_SCOPES = os.environ.get("OIDC_SCOPES", "openid profile email").strip() or "openid profile email"
OIDC_REDIRECT_PATH = os.environ.get("OIDC_REDIRECT_PATH", "/api/auth/callback").strip() or "/api/auth/callback"
OIDC_SESSION_SECRET = os.environ.get("OIDC_SESSION_SECRET", "").strip()
OIDC_SESSION_COOKIE = os.environ.get("OIDC_SESSION_COOKIE", "world_tracker_session").strip() or "world_tracker_session"
OIDC_LOGIN_COOKIE = os.environ.get("OIDC_LOGIN_COOKIE", "world_tracker_login").strip() or "world_tracker_login"
OIDC_SESSION_TTL_SECONDS = int(os.environ.get("OIDC_SESSION_TTL_SECONDS", str(7 * 24 * 60 * 60)))
OIDC_LOGIN_TTL_SECONDS = int(os.environ.get("OIDC_LOGIN_TTL_SECONDS", "600"))
OIDC_COOKIE_SECURE = os.environ.get("OIDC_COOKIE_SECURE", "0").strip().lower() in {"1", "true", "yes"}
LOCAL_USER_COOKIE = os.environ.get("LOCAL_USER_COOKIE", "world_tracker_local_user").strip() or "world_tracker_local_user"
PASSWORD_HASH_ITERATIONS = int(os.environ.get("PASSWORD_HASH_ITERATIONS", "260000"))
DATA_SYNC_INTERVAL_SECONDS = max(int(os.environ.get("DATA_SYNC_INTERVAL_SECONDS", "3600")), 0)
DATA_SYNC_SCHEMA_VERSION = 3
SourceCollector = Callable[[Any, Dict[str, Any]], Tuple[List[tuple], Dict[str, Tuple[str, str]]]]

SOURCE_DATASET_DEFINITIONS = {
    "countries": {"filename": "countries.geojson", "required": True, "auto_sync": True},
    "state_regions": {"filename": "state_regions.geojson", "required": False, "auto_sync": True},
    "cities": {"filename": "cities.json", "required": True, "auto_sync": True},
    "airports": {"filename": "airports.json", "required": True, "auto_sync": True},
    "sites": {
        "filenames": ["whc001.json", "darksky.json", "festivals.json", "michelin_restaurants.json"],
        "required": True,
        "auto_sync": True,
        "empty_payload": [],
    },
}

app = FastAPI(title="World Visited Tracker")
VALID_PLACE_TYPES = {"country", "state", "city", "airport", "site"}
IATA_CODE_RE = re.compile(r"^[A-Z]{3}$")
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_PROFILE_COLOR = "#22c55e"
DATA_SYNC_THREAD_LOCK = threading.Lock()
DATA_SYNC_STOP_EVENT = threading.Event()
DATA_SYNC_THREAD: Optional[threading.Thread] = None
DB_BACKEND_ENV = os.environ.get("DB_BACKEND", "auto").strip().lower()
if DB_BACKEND_ENV in {"postgres", "postgresql"}:
    DB_BACKEND = "postgres"
elif DB_BACKEND_ENV in {"sqlite", "auto", ""}:
    DB_BACKEND = "postgres" if (DB_HOST and DB_NAME) else "sqlite"
else:
    raise RuntimeError("DB_BACKEND must be one of: auto, sqlite, postgres")

if DB_BACKEND == "postgres" and (not DB_HOST or not DB_NAME):
    raise RuntimeError("DB_HOST and DB_NAME are required when DB_BACKEND is postgres")

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    psycopg = None
    dict_row = None

try:
    import jwt
except ImportError:
    jwt = None

OIDC_ENABLED = bool(OIDC_ISSUER and OIDC_CLIENT_ID)
if OIDC_ENABLED and not OIDC_SESSION_SECRET:
    raise RuntimeError("OIDC_SESSION_SECRET is required when OIDC_ISSUER and OIDC_CLIENT_ID are set")
if OIDC_ENABLED and jwt is None:
    raise RuntimeError("PyJWT is required when OIDC authentication is enabled")


SQLITE_SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        oidc_issuer TEXT NOT NULL,
        oidc_subject TEXT NOT NULL,
        email TEXT,
        display_name TEXT,
        password_hash TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        theme_preference TEXT NOT NULL DEFAULT 'dark',
        measurement_system TEXT NOT NULL DEFAULT 'imperial',
        default_profile_id INTEGER,
        created_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL,
        UNIQUE (oidc_issuer, oidc_subject)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id INTEGER,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#22c55e',
        home_country_code TEXT,
        is_public INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
        ,
        FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS places (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        country_code TEXT,
        lat REAL,
        lon REAL,
        data TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS visits (
        profile_id INTEGER NOT NULL,
        place_id TEXT NOT NULL,
        visited_at TEXT,
        trip_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, place_id),
        FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE,
        FOREIGN KEY (place_id) REFERENCES places (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS trip_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        flown_on TEXT,
        origin_place_id TEXT NOT NULL,
        destination_place_id TEXT NOT NULL,
        layover_place_ids TEXT NOT NULL DEFAULT '[]',
        estimated_miles REAL NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE,
        FOREIGN KEY (origin_place_id) REFERENCES places (id) ON DELETE CASCADE,
        FOREIGN KEY (destination_place_id) REFERENCES places (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS place_source_state (
        place_id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (place_id) REFERENCES places (id) ON DELETE CASCADE
    )
    """,
]

SQLITE_INDEX_STATEMENTS = [
    "CREATE INDEX IF NOT EXISTS idx_places_type_name_id ON places (type, name, id)",
    "CREATE INDEX IF NOT EXISTS idx_places_type_country_name_id ON places (type, country_code, name, id)",
    "CREATE INDEX IF NOT EXISTS idx_visits_profile_id ON visits (profile_id)",
    "CREATE INDEX IF NOT EXISTS idx_visits_place_id ON visits (place_id)",
    "CREATE INDEX IF NOT EXISTS idx_trip_logs_profile_id ON trip_logs (profile_id)",
]

POSTGRES_SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        oidc_issuer TEXT NOT NULL,
        oidc_subject TEXT NOT NULL,
        email TEXT,
        display_name TEXT,
        password_hash TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        theme_preference TEXT NOT NULL DEFAULT 'dark',
        measurement_system TEXT NOT NULL DEFAULT 'imperial',
        default_profile_id BIGINT,
        created_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL,
        UNIQUE (oidc_issuer, oidc_subject)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS profiles (
        id BIGSERIAL PRIMARY KEY,
        owner_user_id BIGINT REFERENCES users (id) ON DELETE CASCADE,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#22c55e',
        home_country_code TEXT,
        is_public BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS places (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        country_code TEXT,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION,
        data TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS visits (
        profile_id BIGINT NOT NULL,
        place_id TEXT NOT NULL,
        visited_at TEXT,
        trip_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, place_id),
        FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE,
        FOREIGN KEY (place_id) REFERENCES places (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS trip_logs (
        id BIGSERIAL PRIMARY KEY,
        profile_id BIGINT NOT NULL,
        flown_on TEXT,
        origin_place_id TEXT NOT NULL,
        destination_place_id TEXT NOT NULL,
        layover_place_ids TEXT NOT NULL DEFAULT '[]',
        estimated_miles DOUBLE PRECISION NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE,
        FOREIGN KEY (origin_place_id) REFERENCES places (id) ON DELETE CASCADE,
        FOREIGN KEY (destination_place_id) REFERENCES places (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS place_source_state (
        place_id TEXT PRIMARY KEY REFERENCES places (id) ON DELETE CASCADE,
        source_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        last_seen_at TEXT NOT NULL
    )
    """,
]

POSTGRES_INDEX_STATEMENTS = [
    "CREATE INDEX IF NOT EXISTS idx_places_type_name_id ON places (type, name, id)",
    "CREATE INDEX IF NOT EXISTS idx_places_type_country_name_id ON places (type, country_code, name, id)",
    "CREATE INDEX IF NOT EXISTS idx_visits_profile_id ON visits (profile_id)",
    "CREATE INDEX IF NOT EXISTS idx_visits_place_id ON visits (place_id)",
    "CREATE INDEX IF NOT EXISTS idx_trip_logs_profile_id ON trip_logs (profile_id)",
]


class DBResult:
    def __init__(self, cursor: Any):
        self._cursor = cursor

    @property
    def lastrowid(self) -> Optional[int]:
        if hasattr(self._cursor, "lastrowid"):
            return self._cursor.lastrowid
        if hasattr(self._cursor, "fetchone"):
            row = self._cursor.fetchone()
            if row:
                if isinstance(row, dict):
                    return int(row["id"])
                return int(row[0])
        return None

    def fetchone(self) -> Any:
        return self._cursor.fetchone()

    def fetchall(self) -> List[Any]:
        return self._cursor.fetchall()


class DBConnection:
    def __init__(self, conn: Any, backend: str):
        self._conn = conn
        self._backend = backend

    def _format_query(self, query: str) -> str:
        if self._backend == "postgres":
            return query.replace("?", "%s")
        return query

    def execute(self, query: str, params: Tuple[Any, ...] | List[Any] = ()) -> DBResult:
        if self._backend == "postgres":
            cursor = self._conn.cursor()
            cursor.execute(self._format_query(query), params)
            return DBResult(cursor)
        return DBResult(self._conn.execute(query, params))

    def executemany(self, query: str, params_seq: List[Tuple[Any, ...]]) -> None:
        if self._backend == "postgres":
            cursor = self._conn.cursor()
            cursor.executemany(self._format_query(query), params_seq)
            return
        self._conn.executemany(query, params_seq)


DB_INTEGRITY_ERRORS = (sqlite3.IntegrityError,)
if psycopg is not None:
    DB_INTEGRITY_ERRORS = (sqlite3.IntegrityError, psycopg.IntegrityError)


def _connect_db(backend: str, settings: Optional[Dict[str, Any]] = None) -> Any:
    config = settings or {}
    if backend == "postgres":
        if psycopg is None:
            raise RuntimeError("psycopg is required when using postgres")
        port_raw = str(config.get("db_port") or DB_PORT).strip()
        conn_kwargs: Dict[str, Any] = {
            "host": str(config.get("db_host") or DB_HOST).strip(),
            "port": int(port_raw or DB_PORT),
            "dbname": str(config.get("db_name") or DB_NAME).strip(),
            "user": str(config.get("db_user") or DB_USER).strip(),
            "sslmode": str(config.get("db_sslmode") or DB_SSLMODE or "prefer").strip() or "prefer",
            "row_factory": dict_row,
        }
        password = str(config.get("db_password") or DB_PASSWORD)
        if password:
            conn_kwargs["password"] = password
        if not conn_kwargs["host"] or not conn_kwargs["dbname"]:
            raise HTTPException(status_code=400, detail="Postgres host and database name are required")
        return psycopg.connect(**conn_kwargs)

    sqlite_path_raw = str(config.get("sqlite_db_path") or DB_PATH).strip()
    sqlite_path = Path(sqlite_path_raw).expanduser()
    sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(sqlite_path, timeout=max(SQLITE_BUSY_TIMEOUT_MS, 0) / 1000)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(f"PRAGMA busy_timeout = {max(SQLITE_BUSY_TIMEOUT_MS, 0)}")
    if SQLITE_ENABLE_WAL:
        conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


@contextmanager
def get_db() -> Iterator[DBConnection]:
    conn = _connect_db(DB_BACKEND)
    try:
        yield DBConnection(conn, DB_BACKEND)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@contextmanager
def get_db_for_backend(backend: str, settings: Optional[Dict[str, Any]] = None) -> Iterator[DBConnection]:
    conn = _connect_db(backend, settings)
    try:
        yield DBConnection(conn, backend)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _ensure_schema(conn: DBConnection, backend: str) -> None:
    schema_statements = POSTGRES_SCHEMA_STATEMENTS if backend == "postgres" else SQLITE_SCHEMA_STATEMENTS
    index_statements = POSTGRES_INDEX_STATEMENTS if backend == "postgres" else SQLITE_INDEX_STATEMENTS
    for statement in schema_statements:
        conn.execute(statement)
    for statement in index_statements:
        conn.execute(statement)

    if backend == "postgres":
        user_columns_rows = conn.execute(
            """
            SELECT column_name AS name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'users'
            """
        ).fetchall()
        profile_columns_rows = conn.execute(
            """
            SELECT column_name AS name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'profiles'
            """
        ).fetchall()
    else:
        user_columns_rows = conn.execute("PRAGMA table_info(users)").fetchall()
        profile_columns_rows = conn.execute("PRAGMA table_info(profiles)").fetchall()

    user_columns = {row["name"] for row in user_columns_rows}
    if "username" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN username TEXT")
    if "password_hash" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
    if "role" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
    if "theme_preference" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN theme_preference TEXT NOT NULL DEFAULT 'dark'")
    if "measurement_system" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN measurement_system TEXT NOT NULL DEFAULT 'imperial'")
    if "default_profile_id" not in user_columns:
        if backend == "postgres":
            conn.execute("ALTER TABLE users ADD COLUMN default_profile_id BIGINT")
        else:
            conn.execute("ALTER TABLE users ADD COLUMN default_profile_id INTEGER")

    profile_columns = {row["name"] for row in profile_columns_rows}
    if "color" not in profile_columns:
        conn.execute(
            f"ALTER TABLE profiles ADD COLUMN color TEXT NOT NULL DEFAULT '{DEFAULT_PROFILE_COLOR}'"
        )
    if "owner_user_id" not in profile_columns:
        conn.execute("ALTER TABLE profiles ADD COLUMN owner_user_id INTEGER")
    if "home_country_code" not in profile_columns:
        conn.execute("ALTER TABLE profiles ADD COLUMN home_country_code TEXT")
    if "is_public" not in profile_columns:
        if backend == "postgres":
            conn.execute("ALTER TABLE profiles ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE")
        else:
            conn.execute("ALTER TABLE profiles ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0")
    conn.execute(
        "UPDATE profiles SET color = ? WHERE color IS NULL OR TRIM(color) = ''",
        (DEFAULT_PROFILE_COLOR,),
    )
    conn.execute("UPDATE users SET role = 'user' WHERE role IS NULL OR TRIM(role) = ''")
    conn.execute(
        "UPDATE users SET theme_preference = 'dark' WHERE theme_preference IS NULL OR TRIM(theme_preference) = ''"
    )
    conn.execute(
        "UPDATE users SET measurement_system = 'imperial' WHERE measurement_system IS NULL OR TRIM(measurement_system) = ''"
    )


def init_db() -> None:
    if DB_BACKEND == "sqlite":
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        _ensure_schema(conn, DB_BACKEND)


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


def _hash_password(password: str) -> str:
    normalized = str(password or "")
    if len(normalized) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    iterations = max(PASSWORD_HASH_ITERATIONS, 120000)
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", normalized.encode("utf-8"), salt, iterations)
    return (
        f"pbkdf2_sha256${iterations}$"
        f"{base64.urlsafe_b64encode(salt).decode('utf-8')}$"
        f"{base64.urlsafe_b64encode(digest).decode('utf-8')}"
    )


def _verify_password(password: str, password_hash: Optional[str]) -> bool:
    if not password_hash:
        return False
    parts = str(password_hash).split("$")
    if len(parts) != 4 or parts[0] != "pbkdf2_sha256":
        return False
    try:
        iterations = int(parts[1])
        salt = base64.urlsafe_b64decode(parts[2].encode("utf-8"))
        expected = base64.urlsafe_b64decode(parts[3].encode("utf-8"))
    except Exception:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", str(password or "").encode("utf-8"), salt, max(iterations, 1))
    return hmac.compare_digest(digest, expected)


def _serialize_user(row: Any) -> Dict[str, Any]:
    return {
        "id": int(row["id"]),
        "username": row.get("username") if isinstance(row, dict) else row["username"],
        "email": row.get("email") if isinstance(row, dict) else row["email"],
        "display_name": row.get("display_name") if isinstance(row, dict) else row["display_name"],
        "role": str((row.get("role") if isinstance(row, dict) else row["role"]) or "user"),
        "is_admin": str((row.get("role") if isinstance(row, dict) else row["role"]) or "user") == "admin",
        "theme_preference": str((row.get("theme_preference") if isinstance(row, dict) else row["theme_preference"]) or "dark"),
        "measurement_system": str((row.get("measurement_system") if isinstance(row, dict) else row["measurement_system"]) or "imperial"),
        "default_profile_id": (
            int((row.get("default_profile_id") if isinstance(row, dict) else row["default_profile_id"]))
            if (row.get("default_profile_id") if isinstance(row, dict) else row["default_profile_id"]) is not None
            else None
        ),
    }


def _get_app_settings(conn: DBConnection) -> Dict[str, Any]:
    rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
    settings = {str(row["key"]): str(row["value"]) for row in rows}
    return {
        "preferred_db_backend": settings.get("preferred_db_backend", DB_BACKEND),
        "configured_db_backend": DB_BACKEND,
        "auth_mode": settings.get("auth_mode", "oidc" if OIDC_ENABLED else "local"),
        "oidc_enabled": OIDC_ENABLED,
        "oidc_issuer": settings.get("oidc_issuer", OIDC_ISSUER),
        "oidc_client_id": settings.get("oidc_client_id", OIDC_CLIENT_ID),
        "oidc_client_secret": settings.get("oidc_client_secret", OIDC_CLIENT_SECRET),
        "db_host": settings.get("db_host", DB_HOST),
        "db_port": settings.get("db_port", str(DB_PORT)),
        "db_name": settings.get("db_name", DB_NAME),
        "db_user": settings.get("db_user", DB_USER),
        "db_password": settings.get("db_password", DB_PASSWORD),
        "sqlite_db_path": settings.get("sqlite_db_path", str(DB_PATH)),
    }


def _set_app_settings(conn: DBConnection, settings: Dict[str, Any]) -> None:
    rows = [(str(key), str(value)) for key, value in settings.items()]
    if not rows:
        return
    conn.executemany(
        """
        INSERT INTO app_settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        rows,
    )


def _list_table_rows(conn: DBConnection, table: str, columns: List[str]) -> List[Dict[str, Any]]:
    rows = conn.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall()
    return [dict(row) for row in rows]


def _same_backend_target(backend: str, settings: Dict[str, Any]) -> bool:
    if backend != DB_BACKEND:
        return False
    if backend == "sqlite":
        current_path = Path(str(DB_PATH)).expanduser().resolve()
        target_path = Path(str(settings.get("sqlite_db_path") or DB_PATH)).expanduser().resolve()
        return current_path == target_path
    return (
        str(settings.get("db_host") or DB_HOST).strip() == DB_HOST
        and str(settings.get("db_name") or DB_NAME).strip() == DB_NAME
        and str(settings.get("db_user") or DB_USER).strip() == DB_USER
        and str(settings.get("db_port") or DB_PORT).strip() == str(DB_PORT)
    )


def _clear_target_tables(conn: DBConnection) -> None:
    for table in ("visits", "trip_logs", "place_source_state", "profiles", "users", "places", "app_settings"):
        conn.execute(f"DELETE FROM {table}")


def _copy_rows(conn: DBConnection, table: str, columns: List[str], rows: List[Dict[str, Any]]) -> None:
    if not rows:
        return
    placeholders = ",".join("?" for _ in columns)
    query = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})"
    conn.executemany(query, [tuple(row.get(column) for column in columns) for row in rows])


def _reset_postgres_sequence(conn: DBConnection, table: str, column: str) -> None:
    conn.execute(
        f"""
        SELECT setval(
            pg_get_serial_sequence('{table}', '{column}'),
            COALESCE((SELECT MAX({column}) FROM {table}), 1),
            EXISTS(SELECT 1 FROM {table})
        )
        """
    )


def _migrate_database_snapshot(target_backend: str, target_settings: Dict[str, Any], snapshot: Dict[str, List[Dict[str, Any]]]) -> None:
    with get_db_for_backend(target_backend, target_settings) as target_conn:
        _ensure_schema(target_conn, target_backend)
        _clear_target_tables(target_conn)
        _copy_rows(
            target_conn,
            "users",
            ["id", "username", "oidc_issuer", "oidc_subject", "email", "display_name", "password_hash", "role", "theme_preference", "measurement_system", "default_profile_id", "created_at", "last_login_at"],
            snapshot["users"],
        )
        _copy_rows(
            target_conn,
            "profiles",
            ["id", "owner_user_id", "name", "color", "is_public", "created_at"],
            snapshot["profiles"],
        )
        _copy_rows(
            target_conn,
            "places",
            ["id", "type", "name", "country_code", "lat", "lon", "data"],
            snapshot["places"],
        )
        _copy_rows(
            target_conn,
            "visits",
            ["profile_id", "place_id", "visited_at", "trip_id", "created_at"],
            snapshot["visits"],
        )
        _copy_rows(
            target_conn,
            "trip_logs",
            ["id", "profile_id", "flown_on", "origin_place_id", "destination_place_id", "layover_place_ids", "estimated_miles", "created_at"],
            snapshot["trip_logs"],
        )
        _copy_rows(
            target_conn,
            "place_source_state",
            ["place_id", "source_key", "content_hash", "is_active", "last_seen_at"],
            snapshot["place_source_state"],
        )
        _copy_rows(target_conn, "app_settings", ["key", "value"], snapshot["app_settings"])
        if target_backend == "postgres":
            _reset_postgres_sequence(target_conn, "users", "id")
            _reset_postgres_sequence(target_conn, "profiles", "id")
            _reset_postgres_sequence(target_conn, "trip_logs", "id")


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
    return datetime.utcnow().isoformat()


def _normalize_local_username(raw: Any) -> str:
    username = str(raw or "").strip().lower()
    if not username or not re.match(r"^[a-z0-9_.-]{3,40}$", username):
        raise HTTPException(status_code=400, detail="Username must be 3-40 chars: letters, numbers, ., _, -")
    return username


def seed_profiles(conn: DBConnection) -> None:
    # Intentionally empty: first profile is now created via web UI on first run.
    _ = conn


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
        seed_profiles(conn)
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
        print(
            f"[data-sync] synced {result['place_count']} places from {len(result['source_digests'])} sources"
            f" (reason={reason})"
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
        except Exception as exc:
            print(f"[data-sync] poll failed: {exc}")


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


def _active_place_join_sql(place_alias: str = "places", state_alias: str = "pss") -> str:
    return f"LEFT JOIN place_source_state {state_alias} ON {state_alias}.place_id = {place_alias}.id"


def _active_place_filter_sql(state_alias: str = "pss") -> str:
    return f"({state_alias}.place_id IS NULL OR {state_alias}.is_active = ?)"


def count_by_type(conn: DBConnection, place_type: str, visited_ids: List[str], *, active_only: bool = True) -> int:
    if not visited_ids:
        return 0
    placeholders = ",".join("?" for _ in visited_ids)
    query = f"SELECT COUNT(*) as count FROM places WHERE type = ? AND id IN ({placeholders})"
    params: List[Any] = [place_type, *visited_ids]
    if active_only:
        query = (
            "SELECT COUNT(*) as count "
            f"FROM places {_active_place_join_sql()} "
            f"WHERE places.type = ? AND places.id IN ({placeholders}) AND {_active_place_filter_sql()}"
        )
        params.append(True)
    return conn.execute(query, params).fetchone()["count"]


def get_place_by_id(conn: DBConnection, place_id: str) -> Any:
    place = conn.execute(
        "SELECT id, name, lat, lon, country_code FROM places WHERE id = ?",
        (place_id,),
    ).fetchone()
    if not place:
        raise HTTPException(status_code=400, detail=f"Place not found: {place_id}")
    if place["lat"] is None or place["lon"] is None:
        raise HTTPException(status_code=400, detail=f"Place missing coordinates: {place_id}")
    return place


def miles_between_points(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_miles = 3958.8
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius_miles * c


def build_trip_log_payload(conn: DBConnection, row: Any) -> Dict[str, Any]:
    layover_ids_raw = row["layover_place_ids"] or "[]"
    try:
        layover_ids = json.loads(layover_ids_raw)
    except json.JSONDecodeError:
        layover_ids = []
    if not isinstance(layover_ids, list):
        layover_ids = []

    route_ids: List[str] = [row["origin_place_id"], *[str(item) for item in layover_ids], row["destination_place_id"]]
    placeholders = ",".join("?" for _ in route_ids)
    place_rows = conn.execute(
        f"SELECT id, name, lat, lon, country_code FROM places WHERE id IN ({placeholders})",
        route_ids,
    ).fetchall()
    places_by_id = {place["id"]: place for place in place_rows}

    route_points: List[Dict[str, Any]] = []
    for place_id in route_ids:
        place = places_by_id.get(place_id)
        if not place:
            continue
        route_points.append(
            {
                "id": place["id"],
                "name": place["name"],
                "lat": place["lat"],
                "lon": place["lon"],
                "country_code": place["country_code"],
            }
        )

    segments: List[Dict[str, Any]] = []
    for index in range(1, len(route_points)):
        start = route_points[index - 1]
        end = route_points[index]
        segment_miles = miles_between_points(start["lat"], start["lon"], end["lat"], end["lon"])
        segments.append(
            {
                "from_place_id": start["id"],
                "to_place_id": end["id"],
                "from_name": start["name"],
                "to_name": end["name"],
                "miles": round(segment_miles, 1),
            }
        )

    return {
        "id": row["id"],
        "profile_id": row["profile_id"],
        "flown_on": row["flown_on"],
        "origin_place_id": row["origin_place_id"],
        "destination_place_id": row["destination_place_id"],
        "layover_place_ids": layover_ids,
        "estimated_miles": round(float(row["estimated_miles"]), 1),
        "created_at": row["created_at"],
        "route_points": route_points,
        "segments": segments,
    }


def _total_place_counts(conn: DBConnection) -> Dict[str, int]:
    totals: Dict[str, int] = {}
    for place_type in ("country", "state", "city", "airport", "site"):
        totals[place_type] = int(
            conn.execute(
                "SELECT COUNT(*) as count "
                f"FROM places {_active_place_join_sql()} "
                f"WHERE places.type = ? AND {_active_place_filter_sql()}",
                (place_type, True),
            ).fetchone()["count"]
        )
    return totals


def _total_continent_count(conn: DBConnection) -> int:
    continent_rows = conn.execute(
        "SELECT data "
        f"FROM places {_active_place_join_sql()} "
        f"WHERE places.type = 'country' AND {_active_place_filter_sql()}",
        (True,),
    ).fetchall()
    continents: Set[str] = set()
    for row in continent_rows:
        continent = get_continent_from_country_data(row["data"])
        if continent:
            continents.add(continent)
    return len(continents)


def _visited_rows_for_profile(conn: DBConnection, profile_id: Optional[int], user_id: Optional[int]) -> List[Any]:
    if profile_id is None:
        filter_sql, filter_params = _accessible_profile_filter_sql("p", user_id)
        return conn.execute(
            f"""
            SELECT DISTINCT v.place_id
            FROM visits v
            JOIN profiles p ON p.id = v.profile_id
            WHERE {filter_sql}
            """,
            filter_params,
        ).fetchall()
    return conn.execute("SELECT place_id FROM visits WHERE profile_id = ?", (profile_id,)).fetchall()


def _trip_rows_for_profile(conn: DBConnection, profile_id: Optional[int], user_id: Optional[int]) -> List[Any]:
    if profile_id is None:
        filter_sql, filter_params = _accessible_profile_filter_sql("p", user_id)
        return conn.execute(
            f"""
            SELECT t.id, t.estimated_miles, t.layover_place_ids, t.flown_on, t.created_at,
                   t.origin_place_id, t.destination_place_id
            FROM trip_logs t
            JOIN profiles p ON p.id = t.profile_id
            WHERE {filter_sql}
            """,
            filter_params,
        ).fetchall()
    return conn.execute(
        """
        SELECT id, estimated_miles, layover_place_ids, flown_on, created_at, origin_place_id, destination_place_id
        FROM trip_logs
        WHERE profile_id = ?
        """,
        (profile_id,),
    ).fetchall()


def _place_rows_by_ids(conn: DBConnection, place_ids: List[str], *, active_only: bool = False) -> List[Any]:
    if not place_ids:
        return []
    placeholders = ",".join("?" for _ in place_ids)
    query = f"SELECT id, name, type, lat, lon, country_code, data FROM places WHERE id IN ({placeholders})"
    params: List[Any] = list(place_ids)
    if active_only:
        query = (
            "SELECT places.id, places.name, places.type, places.lat, places.lon, places.country_code, places.data "
            f"FROM places {_active_place_join_sql()} "
            f"WHERE places.id IN ({placeholders}) AND {_active_place_filter_sql()}"
        )
        params.append(True)
    return conn.execute(query, params).fetchall()


def _build_achievements(context: Dict[str, Any]) -> Dict[str, Any]:
    site_categories = context["site_categories"]
    heritage_visited = int(site_categories.get("heritage", {}).get("visited", 0))
    achievements = [
        {"id": "first_country", "title": "First Stamp", "description": "Visit your first country.", "category": "coverage", "current": int(context["visited_countries"]), "target": 1, "points": 10},
        {"id": "continent_hopper", "title": "Continent Hopper", "description": "Reach three continents.", "category": "coverage", "current": int(context["visited_continents"]), "target": 3, "points": 18},
        {"id": "global_six", "title": "Global Six", "description": "Visit all six inhabited continents in the dataset.", "category": "coverage", "current": int(context["visited_continents"]), "target": min(6, int(context["total_continents"])), "points": 35},
        {"id": "regional_runner", "title": "Regional Runner", "description": "Log visits to ten states or regions.", "category": "coverage", "current": int(context["visited_states"]), "target": 10, "points": 14},
        {"id": "city_collector", "title": "City Collector", "description": "Visit twenty-five cities.", "category": "coverage", "current": int(context["visited_cities"]), "target": 25, "points": 14},
        {"id": "jetsetter", "title": "Jet Setter", "description": "Check into ten airports.", "category": "travel", "current": int(context["visited_airports"]), "target": 10, "points": 12},
        {"id": "trip_logger", "title": "Trip Logger", "description": "Record ten trip logs.", "category": "travel", "current": int(context["trip_count"]), "target": 10, "points": 12},
        {"id": "marathon_miles", "title": "Marathon Miles", "description": "Accumulate 25,000 estimated flight miles.", "category": "travel", "current": int(round(context["total_estimated_miles"])), "target": 25000, "points": 24},
        {"id": "timezone_tracker", "title": "Timezone Tracker", "description": "Visit twelve time zones.", "category": "travel", "current": int(context["timezones_visited"]), "target": 12, "points": 18},
        {"id": "north_south", "title": "Hemisphere Crosser", "description": "Reach both the northern and southern hemispheres.", "category": "geography", "current": 1 if context["north_south_overlap"] else 0, "target": 1, "points": 16},
        {"id": "east_west", "title": "Meridian Breaker", "description": "Reach both the eastern and western hemispheres.", "category": "geography", "current": 1 if context["east_west_overlap"] else 0, "target": 1, "points": 16},
        {"id": "quadrant_master", "title": "Quadrant Master", "description": "Visit all four world quadrants.", "category": "geography", "current": 1 if context["all_four_quadrants"] else 0, "target": 1, "points": 28},
        {"id": "summit_seeker", "title": "Summit Seeker", "description": "Visit a place at or above 2,500 meters.", "category": "geography", "current": int(round(max(0.0, context["highest_elevation_value"]))), "target": 2500, "points": 18},
        {"id": "heritage_hunter", "title": "Heritage Hunter", "description": "Visit five heritage-category sites.", "category": "lists", "current": heritage_visited, "target": 5, "points": 18},
    ]
    items: List[Dict[str, Any]] = []
    earned_count = 0
    score = 0
    for item in achievements:
        target = max(int(item["target"]), 1)
        current = max(int(item["current"]), 0)
        earned = current >= target
        progress = min(current, target)
        if earned:
            earned_count += 1
            score += int(item["points"])
        items.append({**item, "earned": earned, "progress_current": progress, "progress_target": target, "progress_percent": round((progress / target) * 100, 1), "progress_label": f"{progress:,} / {target:,}"})
    return {"earned": earned_count, "total": len(items), "score": score, "items": items}


def _build_measurements(context: Dict[str, Any]) -> List[Dict[str, Any]]:
    measurements: List[Dict[str, Any]] = []
    if context["highest_elevation"]:
        measurements.append(metric_entry("highest_elevation", "Highest elevation", context["highest_elevation"][0], round(context["highest_elevation"][1], 1), f"{round(context['highest_elevation'][1]):,} m"))
    if context["lowest_elevation"]:
        measurements.append(metric_entry("lowest_elevation", "Lowest elevation", context["lowest_elevation"][0], round(context["lowest_elevation"][1], 1), f"{round(context['lowest_elevation'][1]):,} m"))
    if context["largest_city"]:
        measurements.append(metric_entry("largest_city", "Largest city visited", context["largest_city"][0], int(context["largest_city"][1]), f"{int(context['largest_city'][1]):,} people"))
    if context["largest_country"]:
        measurements.append(metric_entry("largest_country", "Most populous country visited", context["largest_country"][0], int(context["largest_country"][1]), f"{int(context['largest_country'][1]):,} people", detail=context["largest_country"][2]))
    if context["largest_state"]:
        measurements.append(metric_entry("largest_state", "Largest region visited", context["largest_state"][0], round(context["largest_state"][1], 1), f"{round(context['largest_state'][1]):,} sq km"))
    if context["highest_airport"]:
        measurements.append(metric_entry("highest_airport", "Highest airport visited", context["highest_airport"][0], round(context["highest_airport"][1], 1), f"{round(context['highest_airport'][1]):,} m"))
    if context["longest_trip"]:
        measurements.append(metric_entry("longest_trip", "Longest trip logged", context["longest_trip"][0], round(context["longest_trip"][1], 1), f"{round(context['longest_trip'][1]):,} mi", detail=context["longest_trip"][2]))
    if context["most_connected_airport"]:
        measurements.append(metric_entry("most_connected_airport", "Most used airport", context["most_connected_airport"][0], int(context["most_connected_airport"][1]), f"{int(context['most_connected_airport'][1]):,} trip touches"))
    return measurements


def _compute_profile_stats(
    conn: DBConnection,
    *,
    profile_id: Optional[int],
    user_id: Optional[int],
    total_counts: Dict[str, int],
    total_continents: int,
) -> Dict[str, Any]:
    visited_rows = _visited_rows_for_profile(conn, profile_id, user_id)
    visited_ids = [str(row["place_id"]) for row in visited_rows]
    trip_log_rows = _trip_rows_for_profile(conn, profile_id, user_id)
    visited_place_rows = _place_rows_by_ids(conn, visited_ids, active_only=True)
    site_rows = conn.execute(
        "SELECT places.id, places.data "
        f"FROM places {_active_place_join_sql()} "
        f"WHERE places.type = 'site' AND {_active_place_filter_sql()}",
        (True,),
    ).fetchall()

    trip_place_ids: List[str] = []
    total_estimated_miles = 0.0
    total_legs = 0
    repeated_airport_counts: Dict[str, int] = {}
    trip_dates: Set[str] = set()
    for row in trip_log_rows:
        total_estimated_miles += float(row["estimated_miles"] or 0.0)
        date_value = str(row["flown_on"] or row["created_at"] or "")[:10]
        if date_value:
            trip_dates.add(date_value)
        layover_ids: List[str] = []
        try:
            loaded = json.loads(row["layover_place_ids"] or "[]")
            if isinstance(loaded, list):
                layover_ids = [str(item) for item in loaded]
        except json.JSONDecodeError:
            layover_ids = []
        total_legs += max(0, len(layover_ids) + 1)
        route_ids = [str(row["origin_place_id"]), *layover_ids, str(row["destination_place_id"])]
        trip_place_ids.extend(route_ids)
        for airport_id in route_ids:
            if airport_id.startswith("airport-"):
                repeated_airport_counts[airport_id] = repeated_airport_counts.get(airport_id, 0) + 1

    trip_place_rows = _place_rows_by_ids(conn, sorted(set(trip_place_ids)))
    trip_place_names = {str(row["id"]): str(row["name"]) for row in trip_place_rows}

    hemisphere_counts = {"north": 0, "south": 0, "east": 0, "west": 0}
    hemisphere_quadrants = {"ne": 0, "nw": 0, "se": 0, "sw": 0}
    farthest_north: Optional[Tuple[str, float]] = None
    farthest_south: Optional[Tuple[str, float]] = None
    easternmost: Optional[Tuple[str, float]] = None
    westernmost: Optional[Tuple[str, float]] = None
    highest_elevation: Optional[Tuple[str, float]] = None
    lowest_elevation: Optional[Tuple[str, float]] = None
    largest_city: Optional[Tuple[str, int]] = None
    largest_country: Optional[Tuple[str, int, str]] = None
    largest_state: Optional[Tuple[str, float]] = None
    highest_airport: Optional[Tuple[str, float]] = None
    timezone_set: Set[str] = set()
    currency_set: Set[str] = set()
    visited_continents_set: Set[str] = set()

    for row in visited_place_rows:
        lat = as_float(row["lat"])
        lon = as_float(row["lon"])
        place_name = str(row["name"] or row["id"])
        data = parse_json_object(row["data"])
        lat_side: Optional[str] = None
        lon_side: Optional[str] = None
        if lat is not None:
            if lat >= 0:
                hemisphere_counts["north"] += 1
                lat_side = "n"
            else:
                hemisphere_counts["south"] += 1
                lat_side = "s"
            if farthest_north is None or lat > farthest_north[1]:
                farthest_north = (place_name, lat)
            if farthest_south is None or lat < farthest_south[1]:
                farthest_south = (place_name, lat)
        if lon is not None:
            if lon >= 0:
                hemisphere_counts["east"] += 1
                lon_side = "e"
            else:
                hemisphere_counts["west"] += 1
                lon_side = "w"
            if easternmost is None or lon > easternmost[1]:
                easternmost = (place_name, lon)
            if westernmost is None or lon < westernmost[1]:
                westernmost = (place_name, lon)
        if lat_side and lon_side:
            hemisphere_quadrants[f"{lat_side}{lon_side}"] = hemisphere_quadrants.get(f"{lat_side}{lon_side}", 0) + 1

        timezone = extract_timezone(data)
        if timezone:
            timezone_set.add(timezone)

        elevation_m = extract_elevation_meters(data)
        if elevation_m is not None:
            if highest_elevation is None or elevation_m > highest_elevation[1]:
                highest_elevation = (place_name, elevation_m)
            if lowest_elevation is None or elevation_m < lowest_elevation[1]:
                lowest_elevation = (place_name, elevation_m)

        if row["type"] == "country":
            continent = get_continent_from_country_data(row["data"])
            if continent:
                visited_continents_set.add(continent)
            currency_code = extract_country_currency(data)
            if currency_code:
                currency_set.add(currency_code)
            population = extract_population(data)
            economy = extract_country_economy(data) or "Country"
            if population is not None and (largest_country is None or population > largest_country[1]):
                largest_country = (place_name, population, economy)
        elif row["type"] == "city":
            population = extract_population(data)
            if population is not None and (largest_city is None or population > largest_city[1]):
                largest_city = (place_name, population)
        elif row["type"] == "state":
            area_sqkm = extract_area_sqkm(data)
            if area_sqkm is not None and (largest_state is None or area_sqkm > largest_state[1]):
                largest_state = (place_name, area_sqkm)
        elif row["type"] == "airport" and elevation_m is not None:
            if highest_airport is None or elevation_m > highest_airport[1]:
                highest_airport = (place_name, elevation_m)

    longest_streak = 0
    current_streak = 0
    previous_day: Optional[datetime] = None
    for date_text in sorted(trip_dates):
        try:
            current_day = datetime.strptime(date_text, "%Y-%m-%d")
        except ValueError:
            continue
        if previous_day and (current_day - previous_day).days == 1:
            current_streak += 1
        else:
            current_streak = 1
        longest_streak = max(longest_streak, current_streak)
        previous_day = current_day

    site_category_totals: Dict[str, int] = {}
    site_category_visited: Dict[str, int] = {}
    for row in site_rows:
        payload = parse_json_object(row["data"])
        category = str(payload.get("category") or "heritage").strip().lower()
        site_category_totals[category] = site_category_totals.get(category, 0) + 1
        if row["id"] in visited_ids:
            site_category_visited[category] = site_category_visited.get(category, 0) + 1
    site_categories = {
        category: {"visited": site_category_visited.get(category, 0), "total": total}
        for category, total in sorted(site_category_totals.items())
    }

    longest_trip: Optional[Tuple[str, float, str]] = None
    for row in trip_log_rows:
        distance = float(row["estimated_miles"] or 0.0)
        if longest_trip is not None and distance <= longest_trip[1]:
            continue
        origin_name = trip_place_names.get(str(row["origin_place_id"]), str(row["origin_place_id"]))
        destination_name = trip_place_names.get(str(row["destination_place_id"]), str(row["destination_place_id"]))
        route_label = f"{origin_name} -> {destination_name}"
        date_label = str(row["flown_on"] or row["created_at"] or "")[:10]
        longest_trip = (route_label, distance, date_label or "Date unavailable")

    most_connected_airport: Optional[Tuple[str, int]] = None
    for airport_id, count in repeated_airport_counts.items():
        airport_name = trip_place_names.get(airport_id, airport_id)
        if most_connected_airport is None or count > most_connected_airport[1]:
            most_connected_airport = (airport_name, count)

    visited_countries = count_by_type(conn, "country", visited_ids)
    visited_states = count_by_type(conn, "state", visited_ids)
    visited_cities = count_by_type(conn, "city", visited_ids)
    visited_airports = count_by_type(conn, "airport", visited_ids)
    visited_sites = count_by_type(conn, "site", visited_ids)
    world_percent = (visited_countries / total_counts["country"] * 100) if total_counts["country"] else 0

    context = {
        "visited_countries": visited_countries,
        "visited_states": visited_states,
        "visited_cities": visited_cities,
        "visited_airports": visited_airports,
        "visited_sites": visited_sites,
        "visited_continents": len(visited_continents_set),
        "total_continents": total_continents,
        "trip_count": len(trip_log_rows),
        "total_estimated_miles": total_estimated_miles,
        "timezones_visited": len(timezone_set),
        "site_categories": site_categories,
        "north_south_overlap": hemisphere_counts["north"] > 0 and hemisphere_counts["south"] > 0,
        "east_west_overlap": hemisphere_counts["east"] > 0 and hemisphere_counts["west"] > 0,
        "all_four_quadrants": all(count > 0 for count in hemisphere_quadrants.values()),
        "highest_elevation_value": highest_elevation[1] if highest_elevation else 0.0,
        "highest_elevation": highest_elevation,
        "lowest_elevation": lowest_elevation,
        "largest_city": largest_city,
        "largest_country": largest_country,
        "largest_state": largest_state,
        "highest_airport": highest_airport,
        "longest_trip": longest_trip,
        "most_connected_airport": most_connected_airport,
    }
    achievements = _build_achievements(context)
    measurements = _build_measurements(context)
    overall_score = round(
        visited_countries * 12
        + len(visited_continents_set) * 28
        + visited_states * 2
        + visited_cities * 0.5
        + visited_airports * 1.5
        + visited_sites * 3
        + len(trip_log_rows) * 4
        + (total_estimated_miles / 400)
        + len(timezone_set) * 5
        + achievements["score"] * 1.75,
        1,
    )

    return {
        "continents": {"visited": len(visited_continents_set), "total": total_continents},
        "countries": {"visited": visited_countries, "total": total_counts["country"], "percent": round(world_percent, 1)},
        "states": {"visited": visited_states, "total": total_counts["state"]},
        "cities": {"visited": visited_cities, "total": total_counts["city"]},
        "airports": {"visited": visited_airports, "total": total_counts["airport"]},
        "sites": {"visited": visited_sites, "total": total_counts["site"]},
        "trip_logs": {
            "count": len(trip_log_rows),
            "flight_legs": total_legs,
            "estimated_miles": round(total_estimated_miles, 1),
            "average_miles_per_trip": round(total_estimated_miles / len(trip_log_rows), 1) if trip_log_rows else 0.0,
        },
        "site_categories": site_categories,
        "hemispheres": {
            **hemisphere_counts,
            "quadrants": hemisphere_quadrants,
            "overlap": {
                "north_south": hemisphere_counts["north"] > 0 and hemisphere_counts["south"] > 0,
                "east_west": hemisphere_counts["east"] > 0 and hemisphere_counts["west"] > 0,
                "all_four_quadrants": all(count > 0 for count in hemisphere_quadrants.values()),
            },
        },
        "geo_extremes": {
            "farthest_north": {"name": farthest_north[0], "lat": round(farthest_north[1], 4)} if farthest_north else None,
            "farthest_south": {"name": farthest_south[0], "lat": round(farthest_south[1], 4)} if farthest_south else None,
            "easternmost": {"name": easternmost[0], "lon": round(easternmost[1], 4)} if easternmost else None,
            "westernmost": {"name": westernmost[0], "lon": round(westernmost[1], 4)} if westernmost else None,
            "highest_elevation": {"name": highest_elevation[0], "elevation_m": round(highest_elevation[1], 1)} if highest_elevation else None,
            "lowest_elevation": {"name": lowest_elevation[0], "elevation_m": round(lowest_elevation[1], 1)} if lowest_elevation else None,
        },
        "travel": {
            "distance_miles": round(total_estimated_miles, 1),
            "distance_km": round(total_estimated_miles * 1.60934, 1),
            "timezones_visited": len(timezone_set),
            "currencies_used": len(currency_set),
            "longest_trip_streak_days": longest_streak,
            "repeated_airports": sum(1 for count in repeated_airport_counts.values() if count > 1),
        },
        "measurements": measurements,
        "achievements": achievements,
        "scorecard": {"overall_score": overall_score, "achievement_score": achievements["score"]},
    }


def _apply_rarity_to_achievements(achievements: Dict[str, Any], public_snapshots: List[Dict[str, Any]]) -> Dict[str, Any]:
    total_public = len(public_snapshots)
    earned_counts: Dict[str, int] = {}
    for snapshot in public_snapshots:
        for item in snapshot["stats"]["achievements"]["items"]:
            if item["earned"]:
                earned_counts[item["id"]] = earned_counts.get(item["id"], 0) + 1
    return {
        **achievements,
        "items": [
            {
                **item,
                "earned_by_public_profiles": earned_counts.get(item["id"], 0),
                "rarity_percent": round((earned_counts.get(item["id"], 0) / total_public) * 100, 1) if total_public else 0.0,
            }
            for item in achievements["items"]
        ],
    }


def _build_leaderboard(
    selected_stats: Dict[str, Any],
    selected_profile_id: Optional[int],
    selected_profile_public: bool,
    public_snapshots: List[Dict[str, Any]],
) -> Dict[str, Any]:
    def rank_entries(metric_key: str, label: str) -> Dict[str, Any]:
        sorted_entries = sorted(public_snapshots, key=lambda item: (-float(item["metrics"][metric_key]), str(item["name"]).lower(), int(item["id"])))
        return {
            "id": metric_key,
            "label": label,
            "leaders": [
                {"profile_id": int(item["id"]), "name": item["name"], "color": item["color"], "value": item["metrics"][metric_key]}
                for item in sorted_entries[:5]
            ],
        }

    for snapshot in public_snapshots:
        snapshot["metrics"] = {
            "overall_score": float(snapshot["stats"]["scorecard"]["overall_score"]),
            "countries": int(snapshot["stats"]["countries"]["visited"]),
            "continents": int(snapshot["stats"]["continents"]["visited"]),
            "miles": float(snapshot["stats"]["trip_logs"]["estimated_miles"]),
            "achievements": int(snapshot["stats"]["achievements"]["earned"]),
        }

    sorted_overall = sorted(public_snapshots, key=lambda item: (-float(item["metrics"]["overall_score"]), str(item["name"]).lower(), int(item["id"])))
    top_overall = [
        {
            "profile_id": int(item["id"]),
            "name": item["name"],
            "color": item["color"],
            "overall_score": item["metrics"]["overall_score"],
            "countries": item["metrics"]["countries"],
            "continents": item["metrics"]["continents"],
            "miles": item["metrics"]["miles"],
            "achievements": item["metrics"]["achievements"],
        }
        for item in sorted_overall[:10]
    ]

    selected_summary: Optional[Dict[str, Any]] = None
    if selected_profile_id is not None:
        metric_ranks: Dict[str, Optional[int]] = {}
        leading_categories: List[str] = []
        for metric_key in ("overall_score", "countries", "continents", "miles", "achievements"):
            metric_sorted = sorted(public_snapshots, key=lambda item: (-float(item["metrics"][metric_key]), str(item["name"]).lower(), int(item["id"])))
            rank = next((index + 1 for index, item in enumerate(metric_sorted) if int(item["id"]) == selected_profile_id), None)
            metric_ranks[metric_key] = rank
            if rank == 1:
                leading_categories.append(metric_key)
        selected_summary = {
            "eligible": selected_profile_public,
            "profile_id": selected_profile_id,
            "overall_rank": metric_ranks["overall_score"],
            "country_rank": metric_ranks["countries"],
            "continent_rank": metric_ranks["continents"],
            "miles_rank": metric_ranks["miles"],
            "achievement_rank": metric_ranks["achievements"],
            "leader_categories": leading_categories,
            "overall_score": selected_stats["scorecard"]["overall_score"],
        }

    return {
        "public_profile_count": len(public_snapshots),
        "current_profile": selected_summary,
        "top_overall": top_overall,
        "categories": [
            rank_entries("countries", "Countries visited"),
            rank_entries("continents", "Continents visited"),
            rank_entries("miles", "Flight miles"),
            rank_entries("achievements", "Achievements earned"),
        ],
    }


_OIDC_METADATA_CACHE: Optional[Dict[str, Any]] = None
_OIDC_JWKS_CLIENT: Any = None


def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _base64url_decode(raw: str) -> bytes:
    padding = "=" * ((4 - len(raw) % 4) % 4)
    return base64.urlsafe_b64decode(raw + padding)


def _sign_payload(payload: Dict[str, Any]) -> str:
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_part = _base64url_encode(payload_json)
    signature = hmac.new(OIDC_SESSION_SECRET.encode("utf-8"), payload_part.encode("utf-8"), hashlib.sha256).digest()
    return f"{payload_part}.{_base64url_encode(signature)}"


def _read_signed_cookie(raw_cookie: Optional[str]) -> Optional[Dict[str, Any]]:
    if not raw_cookie:
        return None
    try:
        payload_part, signature_part = raw_cookie.split(".", 1)
    except ValueError:
        return None
    expected_sig = hmac.new(
        OIDC_SESSION_SECRET.encode("utf-8"),
        payload_part.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    try:
        provided_sig = _base64url_decode(signature_part)
    except Exception:
        return None
    if not hmac.compare_digest(expected_sig, provided_sig):
        return None
    try:
        payload = json.loads(_base64url_decode(payload_part).decode("utf-8"))
    except Exception:
        return None
    expires_at = int(payload.get("exp") or 0)
    if expires_at < int(time.time()):
        return None
    return payload


def _set_signed_cookie(response: Response, cookie_name: str, payload: Dict[str, Any], ttl_seconds: int) -> None:
    value = _sign_payload(payload)
    response.set_cookie(
        key=cookie_name,
        value=value,
        max_age=max(ttl_seconds, 1),
        httponly=True,
        secure=OIDC_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def _clear_cookie(response: Response, cookie_name: str) -> None:
    response.delete_cookie(cookie_name, path="/")


def _http_json(
    url: str,
    method: str = "GET",
    payload: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    data: Optional[bytes] = None
    req_headers = {"Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    if payload is not None:
        data = urllib.parse.urlencode(payload).encode("utf-8")
        req_headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url=url, data=data, method=method, headers=req_headers)
    with urllib.request.urlopen(req, timeout=15) as response:
        body = response.read().decode("utf-8")
    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail="Unexpected response from OIDC provider")
    return parsed


def _get_oidc_metadata() -> Dict[str, Any]:
    global _OIDC_METADATA_CACHE
    if _OIDC_METADATA_CACHE is not None:
        return _OIDC_METADATA_CACHE
    issuer = OIDC_ISSUER.rstrip("/")
    if issuer.endswith("/.well-known/openid-configuration"):
        metadata_url = issuer
    else:
        metadata_url = f"{issuer}/.well-known/openid-configuration"
    metadata = _http_json(metadata_url)
    required = {"authorization_endpoint", "token_endpoint", "jwks_uri", "issuer"}
    if not required.issubset(metadata):
        raise HTTPException(status_code=500, detail="OIDC discovery missing required endpoints")
    _OIDC_METADATA_CACHE = metadata
    return metadata


def _get_oidc_jwks_client() -> Any:
    global _OIDC_JWKS_CLIENT
    if _OIDC_JWKS_CLIENT is None:
        metadata = _get_oidc_metadata()
        _OIDC_JWKS_CLIENT = jwt.PyJWKClient(metadata["jwks_uri"])
    return _OIDC_JWKS_CLIENT


def _get_request_base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


def _get_redirect_uri(request: Request) -> str:
    if OIDC_REDIRECT_PATH.startswith("http://") or OIDC_REDIRECT_PATH.startswith("https://"):
        return OIDC_REDIRECT_PATH
    return f"{_get_request_base_url(request)}{OIDC_REDIRECT_PATH}"


def _serialize_place_item(row: Any, place_type: str) -> Optional[Dict[str, Any]]:
    item = dict(row)
    try:
        data = json.loads(item.get("data") or "{}")
    except json.JSONDecodeError:
        data = {}
    if place_type == "airport" and is_duplicate_airport_record(data):
        return None

    state_code = extract_state_code(data)
    municipality = str(data.get("municipality") or data.get("city") or "").strip() or None
    country_text = str(item.get("country_code") or "").strip()
    location_parts = [part for part in [municipality, state_code, country_text] if part]
    country_codes = data.get("country_codes")
    alternate_names = [str(value).strip() for value in (data.get("alternateNames") or []) if str(value).strip()]
    tags = [str(value).strip() for value in (data.get("tags") or []) if str(value).strip()]
    country_or_countries = [
        str(value).strip() for value in (data.get("countryOrCountries") or []) if str(value).strip()
    ]

    item["state_code"] = state_code
    item["category"] = str(data.get("category") or "").strip() or None
    item["type"] = str(data.get("type") or "").strip() or None
    item["airport_code"] = extract_airport_code(data)
    item["airport_type"] = str(data.get("type") or "").strip().lower() or None
    item["municipality"] = municipality
    item["location"] = ", ".join(location_parts)
    item["search_location"] = " ".join(location_parts).lower()
    item["timezone"] = extract_timezone(data)
    item["elevation_m"] = extract_elevation_meters(data)
    item["feature_code"] = str(data.get("feature_code") or "").strip() or None
    item["feature_class"] = str(data.get("feature_class") or "").strip() or None
    item["population"] = extract_population(data)
    item["area_sqkm"] = extract_area_sqkm(data)
    item["continent"] = extract_continent_name(data) if place_type == "country" else None
    item["country_codes"] = [str(code).strip().upper() for code in country_codes if str(code).strip()] if isinstance(country_codes, list) else None
    item["source"] = str(data.get("source") or data.get("source_dataset") or "").strip() or None
    item["sourceType"] = str(data.get("sourceType") or "").strip() or None
    item["alternateNames"] = alternate_names
    item["countryOrCountries"] = country_or_countries
    item["region"] = str(data.get("region") or "").strip() or None
    item["cityOrLocality"] = str(data.get("cityOrLocality") or "").strip() or municipality
    item["latitude"] = as_float(data.get("latitude", item.get("lat")))
    item["longitude"] = as_float(data.get("longitude", item.get("lon")))
    item["summary"] = str(data.get("summary") or data.get("short_description") or "").strip() or None
    item["tags"] = tags
    item["metadata"] = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}

    if place_type == "state" and not str(item.get("name") or "").strip():
        fallback_code = state_code or str(item.get("id") or "").split("-")[-1].upper()
        item["name"] = fallback_code or "Unknown"

    item.pop("data", None)
    return item


def _get_local_users(conn: DBConnection) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, username, email, display_name, role, theme_preference, measurement_system, default_profile_id
        FROM users
        WHERE oidc_issuer = 'local'
        ORDER BY LOWER(COALESCE(display_name, username, email, ''))
        """,
    ).fetchall()
    return [_serialize_user(row) for row in rows]


def _get_local_user_by_cookie(request: Request, conn: DBConnection) -> Optional[Dict[str, Any]]:
    raw_user_id = str(request.cookies.get(LOCAL_USER_COOKIE) or "").strip()
    if not raw_user_id.isdigit():
        return None
    user = conn.execute(
        """
        SELECT id, username, oidc_issuer, oidc_subject, email, display_name, role, theme_preference, measurement_system, default_profile_id
        FROM users
        WHERE id = ? AND oidc_issuer = 'local'
        """,
        (int(raw_user_id),),
    ).fetchone()
    return dict(user) if user else None


def _require_user(request: Request, conn: DBConnection) -> Dict[str, Any]:
    if OIDC_ENABLED:
        token = request.cookies.get(OIDC_SESSION_COOKIE)
        payload = _read_signed_cookie(token)
        if not payload:
            raise HTTPException(status_code=401, detail="Authentication required")
        user_id = int(payload.get("uid") or 0)
        issuer = str(payload.get("iss") or "")
        subject = str(payload.get("sub") or "")
        if not user_id or not issuer or not subject:
            raise HTTPException(status_code=401, detail="Invalid session")
        user = conn.execute(
            """
            SELECT id, username, oidc_issuer, oidc_subject, email, display_name, role, theme_preference, measurement_system, default_profile_id
            FROM users
            WHERE id = ? AND oidc_issuer = ? AND oidc_subject = ?
            """,
            (user_id, issuer, subject),
        ).fetchone()
        if not user:
            raise HTTPException(status_code=401, detail="Session user not found")
        return dict(user)

    local_user = _get_local_user_by_cookie(request, conn)
    if local_user:
        return local_user
    local_users = _get_local_users(conn)
    if not local_users:
        raise HTTPException(status_code=401, detail="Create your first user in Settings")
    raise HTTPException(status_code=401, detail="Select a user in Settings")


def _optional_user(request: Request, conn: DBConnection) -> Optional[Dict[str, Any]]:
    if OIDC_ENABLED:
        token = request.cookies.get(OIDC_SESSION_COOKIE)
        payload = _read_signed_cookie(token)
        if not payload:
            return None
        user_id = int(payload.get("uid") or 0)
        issuer = str(payload.get("iss") or "")
        subject = str(payload.get("sub") or "")
        if not user_id or not issuer or not subject:
            return None
        user = conn.execute(
            """
            SELECT id, username, oidc_issuer, oidc_subject, email, display_name, role, theme_preference, measurement_system, default_profile_id
            FROM users
            WHERE id = ? AND oidc_issuer = ? AND oidc_subject = ?
            """,
            (user_id, issuer, subject),
        ).fetchone()
        return dict(user) if user else None
    return _get_local_user_by_cookie(request, conn)


def _upsert_user(conn: DBConnection, issuer: str, subject: str, email: Optional[str], display_name: Optional[str]) -> int:
    now = datetime.utcnow().isoformat()
    existing = conn.execute(
        "SELECT id FROM users WHERE oidc_issuer = ? AND oidc_subject = ?",
        (issuer, subject),
    ).fetchone()
    if existing:
        user_id = int(existing["id"])
        conn.execute(
            "UPDATE users SET email = ?, display_name = ?, last_login_at = ? WHERE id = ?",
            (email, display_name, now, user_id),
        )
        return user_id

    user_count = int(conn.execute("SELECT COUNT(*) as count FROM users").fetchone()["count"])
    role = "admin" if user_count == 0 else "user"
    inserted = conn.execute(
        """
        INSERT INTO users (oidc_issuer, oidc_subject, email, display_name, role, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id
        """,
        (issuer, subject, email, display_name, role, now, now),
    ).fetchone()
    return int(inserted["id"] if isinstance(inserted, dict) else inserted[0])


def _assign_legacy_profiles_if_needed(conn: DBConnection, user_id: int) -> None:
    owned_count = conn.execute("SELECT COUNT(*) as count FROM profiles WHERE owner_user_id IS NOT NULL").fetchone()["count"]
    if int(owned_count) > 0:
        return
    conn.execute("UPDATE profiles SET owner_user_id = ? WHERE owner_user_id IS NULL", (user_id,))


def _normalize_profile_row(row: Any, viewer_user_id: Optional[int]) -> Dict[str, Any]:
    owner_user_id = row["owner_user_id"]
    is_owned = viewer_user_id is not None and owner_user_id is not None and int(owner_user_id) == int(viewer_user_id)
    return {
        "id": row["id"],
        "name": row["name"],
        "color": normalize_profile_color(row["color"]),
        "home_country_code": normalize_profile_home_country_code(row["home_country_code"]) if row["home_country_code"] else None,
        "is_public": bool(row["is_public"]),
        "owner_user_id": owner_user_id,
        "is_owned": is_owned,
    }


def _accessible_profile_filter_sql(profile_alias: str, user_id: Optional[int]) -> Tuple[str, Tuple[Any, ...]]:
    prefix = f"{profile_alias}." if profile_alias else ""
    if user_id is None:
        return f"{prefix}is_public = ?", (True,)
    return f"({prefix}is_public = ? OR {prefix}owner_user_id = ?)", (True, user_id)


def _can_read_profile(conn: DBConnection, profile_id: int, user_id: Optional[int]) -> Dict[str, Any]:
    profile = conn.execute(
        "SELECT id, owner_user_id, is_public FROM profiles WHERE id = ?",
        (profile_id,),
    ).fetchone()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    owner_user_id = profile["owner_user_id"]
    if bool(profile["is_public"]):
        return dict(profile)
    if user_id is not None and owner_user_id is not None and int(owner_user_id) == int(user_id):
        return dict(profile)
    raise HTTPException(status_code=404, detail="Profile not found")


def _require_profile_owner(conn: DBConnection, profile_id: int, user_id: int) -> Dict[str, Any]:
    profile = conn.execute(
        "SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?",
        (profile_id,),
    ).fetchone()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    owner_user_id = profile["owner_user_id"]
    if owner_user_id is None or int(owner_user_id) != int(user_id):
        raise HTTPException(status_code=404, detail="Profile not found")
    return dict(profile)


def _require_admin(request: Request, conn: DBConnection) -> Dict[str, Any]:
    user = _require_user(request, conn)
    if str(user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


@app.on_event("startup")
async def startup_event() -> None:
    sync_data_sources_if_needed(reason="startup")
    start_data_sync_thread()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    stop_data_sync_thread()


@app.get("/api/auth/session")
async def get_auth_session(request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        user = _optional_user(request, conn)
        local_users = _get_local_users(conn) if not OIDC_ENABLED else []
        app_settings = _get_app_settings(conn)
    return {
        "oidc_enabled": OIDC_ENABLED,
        "authenticated": bool(user),
        "auth_mode": "oidc" if OIDC_ENABLED else "local",
        "local_users_count": len(local_users),
        "has_local_users": len(local_users) > 0,
        "app_settings": app_settings,
        "user": {
            "id": user["id"],
            "username": user.get("username"),
            "email": user.get("email"),
            "display_name": user.get("display_name"),
            "role": user.get("role", "user"),
            "is_admin": str(user.get("role") or "user") == "admin",
        }
        if user
        else None,
    }


@app.put("/api/auth/account")
async def update_auth_account(payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        user = _require_user(request, conn)
        display_name = str(payload.get("display_name") or "").strip()
        if not display_name:
            raise HTTPException(status_code=400, detail="Display name is required")
        theme_preference = str(payload.get("theme_preference") or user.get("theme_preference") or "dark").strip().lower()
        if theme_preference not in {"light", "dark"}:
            raise HTTPException(status_code=400, detail="Theme must be light or dark")
        measurement_system = str(payload.get("measurement_system") or user.get("measurement_system") or "imperial").strip().lower()
        if measurement_system not in {"metric", "imperial"}:
            raise HTTPException(status_code=400, detail="Measurement system must be metric or imperial")
        default_profile_raw = payload.get("default_profile_id")
        default_profile_id: Optional[int]
        if default_profile_raw in {None, "", "null"}:
            default_profile_id = None
        else:
            try:
                default_profile_id = int(default_profile_raw)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail="default_profile_id must be an integer or null") from exc
            _can_read_profile(conn, default_profile_id, int(user["id"]))

        username = user.get("username")
        if str(user.get("oidc_issuer") or "") == "local":
            username = _normalize_local_username(payload.get("username"))

        password = str(payload.get("password") or "")
        if password and str(user.get("oidc_issuer") or "") != "local":
            raise HTTPException(status_code=400, detail="Only local users can change passwords here")

        try:
            conn.execute(
                "UPDATE users SET username = ?, display_name = ?, theme_preference = ?, measurement_system = ?, default_profile_id = ? WHERE id = ?",
                (username, display_name, theme_preference, measurement_system, default_profile_id, int(user["id"])),
            )
        except DB_INTEGRITY_ERRORS as exc:
            raise HTTPException(status_code=400, detail="Username already exists") from exc

        if password:
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (_hash_password(password), int(user["id"])),
            )

        updated = conn.execute(
            "SELECT id, username, email, display_name, role, theme_preference, measurement_system, default_profile_id FROM users WHERE id = ?",
            (int(user["id"]),),
        ).fetchone()
    return _serialize_user(updated)


@app.get("/api/auth/login")
async def auth_login(request: Request) -> Response:
    if not OIDC_ENABLED:
        raise HTTPException(status_code=404, detail="OIDC authentication is not enabled")
    metadata = _get_oidc_metadata()
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    login_payload = {
        "state": state,
        "nonce": nonce,
        "exp": int(time.time()) + max(OIDC_LOGIN_TTL_SECONDS, 60),
    }
    params = {
        "response_type": "code",
        "client_id": OIDC_CLIENT_ID,
        "redirect_uri": _get_redirect_uri(request),
        "scope": OIDC_SCOPES,
        "state": state,
        "nonce": nonce,
    }
    authorization_url = f"{metadata['authorization_endpoint']}?{urllib.parse.urlencode(params)}"
    response = RedirectResponse(url=authorization_url, status_code=302)
    _set_signed_cookie(response, OIDC_LOGIN_COOKIE, login_payload, max(OIDC_LOGIN_TTL_SECONDS, 60))
    return response


@app.get("/api/auth/callback")
async def auth_callback(
    request: Request,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    error_description: Optional[str] = None,
) -> Response:
    if not OIDC_ENABLED:
        raise HTTPException(status_code=404, detail="OIDC authentication is not enabled")
    if error:
        raise HTTPException(status_code=400, detail=error_description or error)
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state")
    login_payload = _read_signed_cookie(request.cookies.get(OIDC_LOGIN_COOKIE))
    if not login_payload or login_payload.get("state") != state:
        raise HTTPException(status_code=400, detail="Invalid login state")

    metadata = _get_oidc_metadata()
    token_payload = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": OIDC_CLIENT_ID,
        "redirect_uri": _get_redirect_uri(request),
    }
    if OIDC_CLIENT_SECRET:
        token_payload["client_secret"] = OIDC_CLIENT_SECRET
    try:
        token_response = _http_json(metadata["token_endpoint"], method="POST", payload=token_payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="OIDC token exchange failed") from exc
    id_token = token_response.get("id_token")
    if not id_token:
        raise HTTPException(status_code=400, detail="OIDC response missing id_token")

    try:
        signing_key = _get_oidc_jwks_client().get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256", "ES256", "PS256"],
            audience=OIDC_CLIENT_ID,
            issuer=metadata["issuer"],
            options={"require": ["sub", "iss", "exp", "iat"]},
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid id_token") from exc

    if claims.get("nonce") != login_payload.get("nonce"):
        raise HTTPException(status_code=400, detail="Invalid nonce")

    issuer = str(claims.get("iss") or "").strip()
    subject = str(claims.get("sub") or "").strip()
    email = str(claims.get("email") or "").strip() or None
    display_name = (
        str(claims.get("name") or claims.get("preferred_username") or claims.get("email") or "").strip() or None
    )
    if not issuer or not subject:
        raise HTTPException(status_code=400, detail="OIDC identity is missing issuer/subject")

    with get_db() as conn:
        user_id = _upsert_user(conn, issuer, subject, email, display_name)
        _assign_legacy_profiles_if_needed(conn, user_id)

    session_payload = {
        "uid": user_id,
        "iss": issuer,
        "sub": subject,
        "exp": int(time.time()) + max(OIDC_SESSION_TTL_SECONDS, 3600),
    }
    response = RedirectResponse(url="/", status_code=302)
    _set_signed_cookie(response, OIDC_SESSION_COOKIE, session_payload, max(OIDC_SESSION_TTL_SECONDS, 3600))
    _clear_cookie(response, OIDC_LOGIN_COOKIE)
    return response


@app.post("/api/auth/logout")
async def auth_logout() -> Response:
    response = JSONResponse({"status": "ok"})
    _clear_cookie(response, OIDC_SESSION_COOKIE)
    _clear_cookie(response, OIDC_LOGIN_COOKIE)
    _clear_cookie(response, LOCAL_USER_COOKIE)
    return response


@app.get("/api/users/local")
async def get_local_users() -> List[Dict[str, Any]]:
    if OIDC_ENABLED:
        raise HTTPException(status_code=404, detail="Local users are disabled when OIDC is enabled")
    with get_db() as conn:
        users = _get_local_users(conn)
    return users


@app.post("/api/users/local")
async def create_local_user(payload: Dict[str, Any]) -> Dict[str, Any]:
    if OIDC_ENABLED:
        raise HTTPException(status_code=404, detail="Local users are disabled when OIDC is enabled")
    username = _normalize_local_username(payload.get("username"))
    display_name = str(payload.get("display_name") or "").strip()
    password = str(payload.get("password") or "")
    if not display_name:
        raise HTTPException(status_code=400, detail="Display name is required")
    password_hash = _hash_password(password)
    subject = f"local-{slugify(username)}-{secrets.token_hex(4)}"
    now = datetime.utcnow().isoformat()
    with get_db() as conn:
        local_user_count = int(
            conn.execute("SELECT COUNT(*) as count FROM users WHERE oidc_issuer = 'local'").fetchone()["count"]
        )
        role = "admin" if local_user_count == 0 else "user"
        try:
            inserted = conn.execute(
                """
                INSERT INTO users (username, oidc_issuer, oidc_subject, email, display_name, password_hash, role, created_at, last_login_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id
                """,
                (username, "local", subject, None, display_name, password_hash, role, now, now),
            ).fetchone()
        except DB_INTEGRITY_ERRORS as exc:
            raise HTTPException(status_code=400, detail="Username already exists") from exc
        user_id = int(inserted["id"] if isinstance(inserted, dict) else inserted[0])
        _assign_legacy_profiles_if_needed(conn, user_id)
    return {"id": user_id, "username": username, "display_name": display_name, "role": role, "is_admin": role == "admin"}


@app.post("/api/auth/local/register")
async def register_local_user(payload: Dict[str, Any]) -> Response:
    if OIDC_ENABLED:
        raise HTTPException(status_code=404, detail="Local users are disabled when OIDC is enabled")
    response_data = await create_local_user(payload)
    user_id = int(response_data["id"])
    response = JSONResponse({"status": "ok", "user_id": user_id})
    response.set_cookie(
        key=LOCAL_USER_COOKIE,
        value=str(user_id),
        max_age=max(OIDC_SESSION_TTL_SECONDS, 3600),
        httponly=True,
        secure=OIDC_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return response


@app.post("/api/auth/local/login")
async def local_login(payload: Dict[str, Any]) -> Response:
    if OIDC_ENABLED:
        raise HTTPException(status_code=404, detail="Local users are disabled when OIDC is enabled")
    username = str(payload.get("username") or "").strip().lower()
    password = str(payload.get("password") or "")
    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password are required")
    with get_db() as conn:
        user = conn.execute(
            """
            SELECT id, password_hash
            FROM users
            WHERE oidc_issuer = 'local' AND LOWER(COALESCE(username, '')) = ?
            """,
            (username,),
        ).fetchone()
        if not user or not _verify_password(password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid username or password")
        conn.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), int(user["id"])),
        )
    response = JSONResponse({"status": "ok"})
    response.set_cookie(
        key=LOCAL_USER_COOKIE,
        value=str(int(user["id"])),
        max_age=max(OIDC_SESSION_TTL_SECONDS, 3600),
        httponly=True,
        secure=OIDC_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return response


@app.post("/api/users/local/select")
async def select_local_user(payload: Dict[str, Any]) -> Response:
    _ = payload
    raise HTTPException(status_code=410, detail="User switching by id is disabled. Use /api/auth/local/login")


@app.get("/api/profiles")
async def get_profiles(request: Request) -> List[Dict[str, Any]]:
    with get_db() as conn:
        user = _optional_user(request, conn)
        user_id = int(user["id"]) if user else None
        filter_sql, filter_params = _accessible_profile_filter_sql("", user_id)
        rows = conn.execute(
            f"""
            SELECT id, name, color, home_country_code, is_public, owner_user_id
            FROM profiles
            WHERE {filter_sql}
            ORDER BY CASE WHEN owner_user_id = ? THEN 0 ELSE 1 END, LOWER(name)
            """,
            (*filter_params, user_id if user_id is not None else -1),
        ).fetchall()
    return [_normalize_profile_row(row, user_id) for row in rows]


@app.post("/api/profiles")
async def create_profile(payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    color = normalize_profile_color(payload.get("color"))
    home_country_code = normalize_profile_home_country_code(payload.get("home_country_code"))
    is_public = bool(payload.get("is_public"))
    now = datetime.utcnow().isoformat()
    with get_db() as conn:
        owner_user_id = _require_user(request, conn)["id"]
        try:
            cursor = conn.execute(
                "INSERT INTO profiles (owner_user_id, name, color, home_country_code, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
                (owner_user_id, name, color, home_country_code, is_public, now),
            )
        except DB_INTEGRITY_ERRORS as exc:
            raise HTTPException(status_code=400, detail="Profile already exists") from exc
        inserted_row = cursor.fetchone()
        profile_id = int(inserted_row["id"] if isinstance(inserted_row, dict) else inserted_row[0])
        row = conn.execute(
            "SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
    return _normalize_profile_row(row, int(owner_user_id))


@app.put("/api/profiles/{profile_id}")
async def update_profile(profile_id: int, payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        user = _require_user(request, conn)
        profile = _require_profile_owner(conn, profile_id, user["id"])

        if "name" in payload:
            name = str(payload.get("name") or "").strip()
        else:
            name = str(profile["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name is required")

        if "color" in payload:
            color = normalize_profile_color(payload.get("color"))
        else:
            color = normalize_profile_color(profile["color"])
        if "home_country_code" in payload:
            home_country_code = normalize_profile_home_country_code(payload.get("home_country_code"))
        else:
            home_country_code = normalize_profile_home_country_code(profile["home_country_code"]) if profile["home_country_code"] else None
        if "is_public" in payload:
            is_public = bool(payload.get("is_public"))
        else:
            is_public = bool(profile.get("is_public"))
        try:
            conn.execute(
                "UPDATE profiles SET name = ?, color = ?, home_country_code = ?, is_public = ? WHERE id = ?",
                (name, color, home_country_code, is_public, profile_id),
            )
        except DB_INTEGRITY_ERRORS as exc:
            raise HTTPException(status_code=400, detail="Profile already exists") from exc
        row = conn.execute(
            "SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
    return _normalize_profile_row(row, int(user["id"]))


@app.delete("/api/profiles/{profile_id}")
async def delete_profile(profile_id: int, request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        user = _require_user(request, conn)
        _require_profile_owner(conn, profile_id, user["id"])
        conn.execute("UPDATE users SET default_profile_id = NULL WHERE default_profile_id = ?", (profile_id,))
        conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
    return {"status": "ok"}


@app.get("/api/admin/users")
async def admin_get_users(request: Request) -> List[Dict[str, Any]]:
    with get_db() as conn:
        _require_admin(request, conn)
        rows = conn.execute(
            """
            SELECT id, username, email, display_name, role, theme_preference, measurement_system, default_profile_id
            FROM users
            ORDER BY LOWER(COALESCE(display_name, username, email, '')), id
            """
        ).fetchall()
    return [_serialize_user(row) for row in rows]


@app.post("/api/admin/users")
async def admin_create_user(payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        _require_admin(request, conn)
    created = await create_local_user(payload)
    if bool(payload.get("is_admin")):
        with get_db() as conn:
            conn.execute("UPDATE users SET role = 'admin' WHERE id = ?", (int(created["id"]),))
        created["role"] = "admin"
        created["is_admin"] = True
    return created


@app.put("/api/admin/users/{user_id}")
async def admin_update_user(user_id: int, payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        admin_user = _require_admin(request, conn)
        row = conn.execute(
            "SELECT id, username, display_name, oidc_issuer, role, theme_preference, measurement_system, default_profile_id FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        next_role = str(payload.get("role") or row["role"] or "user").strip().lower()
        if next_role not in {"admin", "user"}:
            raise HTTPException(status_code=400, detail="Role must be admin or user")
        if int(admin_user["id"]) == int(user_id) and next_role != "admin":
            raise HTTPException(status_code=400, detail="You cannot demote yourself")
        next_display_name = str(payload.get("display_name") or row["display_name"] or "").strip()
        if not next_display_name:
            raise HTTPException(status_code=400, detail="Display name is required")
        next_username = row["username"]
        if str(row["oidc_issuer"] or "") == "local":
            next_username = _normalize_local_username(payload.get("username") or row["username"])
        try:
            conn.execute(
                "UPDATE users SET username = ?, display_name = ?, role = ? WHERE id = ?",
                (next_username, next_display_name, next_role, user_id),
            )
        except DB_INTEGRITY_ERRORS as exc:
            raise HTTPException(status_code=400, detail="Username already exists") from exc
        updated = conn.execute(
            "SELECT id, username, email, display_name, role, theme_preference, measurement_system, default_profile_id FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return _serialize_user(updated)


@app.post("/api/admin/users/{user_id}/password")
async def admin_reset_user_password(user_id: int, payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    password = str(payload.get("password") or "")
    if not password:
        raise HTTPException(status_code=400, detail="Password is required")
    with get_db() as conn:
        _require_admin(request, conn)
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (_hash_password(password), user_id))
    return {"status": "ok"}


@app.delete("/api/admin/users/{user_id}")
async def admin_delete_user(user_id: int, request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        admin_user = _require_admin(request, conn)
        if int(admin_user["id"]) == int(user_id):
            raise HTTPException(status_code=400, detail="You cannot delete yourself")
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        conn.execute(
            "UPDATE users SET default_profile_id = NULL WHERE default_profile_id IN (SELECT id FROM profiles WHERE owner_user_id = ?)",
            (user_id,),
        )
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return {"status": "ok"}


@app.get("/api/admin/profiles")
async def admin_get_profiles(request: Request) -> List[Dict[str, Any]]:
    with get_db() as conn:
        _require_admin(request, conn)
        rows = conn.execute(
            """
            SELECT p.id, p.name, p.color, p.home_country_code, p.is_public, p.owner_user_id, u.display_name, u.username
            FROM profiles p
            LEFT JOIN users u ON u.id = p.owner_user_id
            ORDER BY LOWER(p.name), p.id
            """
        ).fetchall()
    items: List[Dict[str, Any]] = []
    for row in rows:
        item = _normalize_profile_row(row, None)
        item["owner_label"] = row["display_name"] or row["username"] or (f"User {row['owner_user_id']}" if row["owner_user_id"] else "Unowned")
        items.append(item)
    return items


@app.post("/api/admin/profiles")
async def admin_create_profile(payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    owner_user_id = payload.get("owner_user_id")
    color = normalize_profile_color(payload.get("color"))
    home_country_code = normalize_profile_home_country_code(payload.get("home_country_code"))
    is_public = bool(payload.get("is_public"))
    if not isinstance(owner_user_id, int):
        raise HTTPException(status_code=400, detail="owner_user_id is required")
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    now = datetime.utcnow().isoformat()
    with get_db() as conn:
        _require_admin(request, conn)
        owner = conn.execute("SELECT id FROM users WHERE id = ?", (owner_user_id,)).fetchone()
        if not owner:
            raise HTTPException(status_code=404, detail="Owner user not found")
        try:
            inserted = conn.execute(
                "INSERT INTO profiles (owner_user_id, name, color, home_country_code, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
                (owner_user_id, name, color, home_country_code, is_public, now),
            ).fetchone()
        except DB_INTEGRITY_ERRORS as exc:
            raise HTTPException(status_code=400, detail="Profile already exists") from exc
        profile_id = int(inserted["id"] if isinstance(inserted, dict) else inserted[0])
        row = conn.execute("SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    return _normalize_profile_row(row, owner_user_id)


@app.put("/api/admin/profiles/{profile_id}")
async def admin_update_profile(profile_id: int, payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        _require_admin(request, conn)
        row = conn.execute("SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?", (profile_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Profile not found")
        name = str(payload.get("name") or row["name"]).strip()
        color = normalize_profile_color(payload.get("color") if "color" in payload else row["color"])
        home_country_code = normalize_profile_home_country_code(payload.get("home_country_code")) if "home_country_code" in payload else (normalize_profile_home_country_code(row["home_country_code"]) if row["home_country_code"] else None)
        is_public = bool(payload.get("is_public")) if "is_public" in payload else bool(row["is_public"])
        owner_user_id = payload.get("owner_user_id", row["owner_user_id"])
        if owner_user_id is not None and not isinstance(owner_user_id, int):
            raise HTTPException(status_code=400, detail="owner_user_id must be an integer or null")
        conn.execute(
            "UPDATE profiles SET name = ?, color = ?, home_country_code = ?, is_public = ?, owner_user_id = ? WHERE id = ?",
            (name, color, home_country_code, is_public, owner_user_id, profile_id),
        )
        updated = conn.execute("SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    return _normalize_profile_row(updated, owner_user_id if isinstance(owner_user_id, int) else None)


@app.delete("/api/admin/profiles/{profile_id}")
async def admin_delete_profile(profile_id: int, request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        _require_admin(request, conn)
        row = conn.execute("SELECT id FROM profiles WHERE id = ?", (profile_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Profile not found")
        conn.execute("UPDATE users SET default_profile_id = NULL WHERE default_profile_id = ?", (profile_id,))
        conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
    return {"status": "ok"}


@app.get("/api/admin/settings")
async def admin_get_settings(request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        _require_admin(request, conn)
        return _get_app_settings(conn)


@app.put("/api/admin/settings")
async def admin_update_settings(payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    allowed = {
        "preferred_db_backend",
        "auth_mode",
        "oidc_issuer",
        "oidc_client_id",
        "oidc_client_secret",
        "db_host",
        "db_port",
        "db_name",
        "db_user",
        "db_password",
        "sqlite_db_path",
    }
    updates = {key: payload[key] for key in allowed if key in payload}
    if "preferred_db_backend" in updates and str(updates["preferred_db_backend"]) not in {"sqlite", "postgres"}:
        raise HTTPException(status_code=400, detail="preferred_db_backend must be sqlite or postgres")
    if "auth_mode" in updates and str(updates["auth_mode"]) not in {"local", "oidc"}:
        raise HTTPException(status_code=400, detail="auth_mode must be local or oidc")
    with get_db() as conn:
        _require_admin(request, conn)
        _set_app_settings(conn, updates)
        settings = _get_app_settings(conn)
    settings["restart_required"] = True
    return settings


@app.post("/api/admin/settings/migrate")
async def admin_migrate_settings(payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    target_backend = str(payload.get("preferred_db_backend") or "").strip().lower()
    if target_backend not in {"sqlite", "postgres"}:
        raise HTTPException(status_code=400, detail="preferred_db_backend must be sqlite or postgres")

    updates = {
        "preferred_db_backend": target_backend,
        "auth_mode": str(payload.get("auth_mode") or "local").strip().lower(),
        "oidc_issuer": str(payload.get("oidc_issuer") or "").strip(),
        "oidc_client_id": str(payload.get("oidc_client_id") or "").strip(),
        "oidc_client_secret": str(payload.get("oidc_client_secret") or "").strip(),
        "db_host": str(payload.get("db_host") or "").strip(),
        "db_port": str(payload.get("db_port") or "").strip(),
        "db_name": str(payload.get("db_name") or "").strip(),
        "db_user": str(payload.get("db_user") or "").strip(),
        "db_password": str(payload.get("db_password") or "").strip(),
        "sqlite_db_path": str(payload.get("sqlite_db_path") or "").strip(),
    }
    if updates["auth_mode"] not in {"local", "oidc"}:
        raise HTTPException(status_code=400, detail="auth_mode must be local or oidc")
    if _same_backend_target(target_backend, updates):
        raise HTTPException(status_code=400, detail="Migration target must be different from the current active database")

    with get_db() as source_conn:
        _require_admin(request, source_conn)
        _set_app_settings(source_conn, updates)
        current_settings = _get_app_settings(source_conn)
        current_settings.update(updates)
        snapshot = {
            "users": _list_table_rows(
                source_conn,
                "users",
                ["id", "username", "oidc_issuer", "oidc_subject", "email", "display_name", "password_hash", "role", "theme_preference", "measurement_system", "default_profile_id", "created_at", "last_login_at"],
            ),
            "profiles": _list_table_rows(source_conn, "profiles", ["id", "owner_user_id", "name", "color", "home_country_code", "is_public", "created_at"]),
            "places": _list_table_rows(source_conn, "places", ["id", "type", "name", "country_code", "lat", "lon", "data"]),
            "visits": _list_table_rows(source_conn, "visits", ["profile_id", "place_id", "visited_at", "trip_id", "created_at"]),
            "trip_logs": _list_table_rows(
                source_conn,
                "trip_logs",
                ["id", "profile_id", "flown_on", "origin_place_id", "destination_place_id", "layover_place_ids", "estimated_miles", "created_at"],
            ),
            "place_source_state": _list_table_rows(
                source_conn,
                "place_source_state",
                ["place_id", "source_key", "content_hash", "is_active", "last_seen_at"],
            ),
            "app_settings": [{"key": str(key), "value": str(value)} for key, value in current_settings.items() if value is not None],
        }

    _migrate_database_snapshot(target_backend, updates, snapshot)

    response = dict(current_settings)
    response["restart_required"] = True
    response["migration_summary"] = {
        "target_backend": target_backend,
        "users": len(snapshot["users"]),
        "profiles": len(snapshot["profiles"]),
        "places": len(snapshot["places"]),
        "visits": len(snapshot["visits"]),
        "trip_logs": len(snapshot["trip_logs"]),
    }
    return response


@app.get("/api/places")
async def get_places(
    type: str = Query(...),
    query: Optional[str] = None,
    country_code: Optional[str] = None,
    major_only: bool = False,
    include_total: bool = True,
    limit: int = Query(1000, ge=1, le=20000),
    offset: int = Query(0, ge=0),
) -> Dict[str, Any]:
    if type not in VALID_PLACE_TYPES:
        raise HTTPException(status_code=400, detail="Invalid place type")
    params: List[Any] = [type, True]
    where = f"WHERE places.type = ? AND {_active_place_filter_sql()}"
    if query:
        where += " AND places.name LIKE ?"
        params.append(f"%{query}%")
    country_codes = [str(code).strip().upper() for code in str(country_code or "").split(",") if str(code).strip()]
    if country_codes:
        placeholders = ",".join("?" for _ in country_codes)
        where += f" AND places.country_code IN ({placeholders})"
        params.extend(country_codes)

    items: List[Dict[str, Any]] = []
    total: Optional[int] = None
    has_more = False
    next_offset = offset

    with get_db() as conn:
        if type == "airport" and major_only:
            scan_offset = offset
            chunk_size = max(limit, 1000)
            while len(items) < limit:
                rows = conn.execute(
                    "SELECT places.id, places.name, places.country_code, places.lat, places.lon, places.data "
                    f"FROM places {_active_place_join_sql()} {where} ORDER BY places.name LIMIT ? OFFSET ?",
                    params + [chunk_size, scan_offset],
                ).fetchall()
                if not rows:
                    has_more = False
                    break
                scan_offset += len(rows)
                for row in rows:
                    item = _serialize_place_item(row, type)
                    if not item:
                        continue
                    airport_type = str(item.get("airport_type") or "").strip().lower()
                    airport_name = str(item.get("name") or "").lower()
                    allowed_type = airport_type in {"regional_airport", "medium_airport", "large_airport"}
                    allowed_name = "regional" in airport_name
                    if not item.get("airport_code") or not (allowed_type or allowed_name):
                        continue
                    items.append(item)
                    if len(items) >= limit:
                        break
                has_more = len(rows) == chunk_size
                if len(rows) < chunk_size:
                    break
            next_offset = scan_offset
        else:
            rows = conn.execute(
                "SELECT places.id, places.name, places.country_code, places.lat, places.lon, places.data "
                f"FROM places {_active_place_join_sql()} {where} ORDER BY places.name LIMIT ? OFFSET ?",
                params + [limit + 1, offset],
            ).fetchall()
            has_more = len(rows) > limit
            rows = rows[:limit]
            next_offset = offset + len(rows)
            for row in rows:
                item = _serialize_place_item(row, type)
                if not item:
                    continue
                items.append(item)
        if include_total:
            total = conn.execute(
                "SELECT COUNT(*) as count "
                f"FROM places {_active_place_join_sql()} {where}",
                params,
            ).fetchone()["count"]
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": has_more,
        "next_offset": next_offset,
    }


@app.get("/api/places/geojson")
async def get_places_geojson(type: str) -> Dict[str, Any]:
    if type not in VALID_PLACE_TYPES:
        raise HTTPException(status_code=400, detail="Invalid place type")
    with get_db() as conn:
        rows = conn.execute(
            "SELECT places.id, places.name, places.country_code, places.lat, places.lon, places.data "
            f"FROM places {_active_place_join_sql()} "
            f"WHERE places.type = ? AND {_active_place_filter_sql()}",
            (type, True),
        ).fetchall()
    features = []
    for row in rows:
        try:
            data = json.loads(row["data"] or "{}")
        except json.JSONDecodeError:
            data = {}
        if type == "country":
            geometry = data.get("geometry")
        elif type == "state":
            geometry = data.get("geometry")
            if not geometry and row["lat"] is not None and row["lon"] is not None:
                geometry = {
                    "type": "Point",
                    "coordinates": [row["lon"], row["lat"]],
                }
        else:
            if row["lat"] is None or row["lon"] is None:
                continue
            geometry = {
                "type": "Point",
                "coordinates": [row["lon"], row["lat"]],
            }
        if not geometry:
            continue
        features.append(
            {
                "type": "Feature",
                "id": row["id"],
                "geometry": geometry,
                "properties": {
                    "name": row["name"],
                    "country_code": row["country_code"],
                    "state_code": extract_state_code(data),
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


@app.get("/api/visits")
async def get_visits(request: Request, profile_id: Optional[int] = None) -> List[Dict[str, Any]]:
    with get_db() as conn:
        user = _optional_user(request, conn)
        user_id = int(user["id"]) if user else None
        if profile_id is None:
            filter_sql, filter_params = _accessible_profile_filter_sql("p", user_id)
            rows = conn.execute(
                f"""
                SELECT v.profile_id, v.place_id, v.visited_at, v.trip_id
                FROM visits v
                JOIN profiles p ON p.id = v.profile_id
                WHERE {filter_sql}
                """,
                filter_params,
            ).fetchall()
        else:
            _can_read_profile(conn, profile_id, user_id)
            rows = conn.execute(
                "SELECT profile_id, place_id, visited_at, trip_id FROM visits WHERE profile_id = ?",
                (profile_id,),
            ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/visits/toggle")
async def toggle_visit(payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    profile_id = payload.get("profile_id")
    place_id = payload.get("place_id")
    visited = payload.get("visited")
    visited_at = payload.get("visited_at")
    trip_id = payload.get("trip_id")

    if profile_id is None or place_id is None or visited is None:
        raise HTTPException(status_code=400, detail="profile_id, place_id, visited required")

    with get_db() as conn:
        user = _require_user(request, conn)
        _require_profile_owner(conn, int(profile_id), user["id"])
        try:
            if visited:
                conn.execute(
                    """
                    INSERT INTO visits (profile_id, place_id, visited_at, trip_id, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (profile_id, place_id) DO UPDATE SET
                        visited_at = excluded.visited_at,
                        trip_id = excluded.trip_id,
                        created_at = excluded.created_at
                    """,
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
        except DB_INTEGRITY_ERRORS as exc:
            raise HTTPException(status_code=400, detail="Invalid profile_id or place_id") from exc
    return {"profile_id": profile_id, "place_id": place_id, "visited": visited}


@app.get("/api/trip-logs")
async def get_trip_logs(request: Request, profile_id: Optional[int] = None) -> List[Dict[str, Any]]:
    with get_db() as conn:
        user = _optional_user(request, conn)
        user_id = int(user["id"]) if user else None
        if profile_id is None:
            filter_sql, filter_params = _accessible_profile_filter_sql("p", user_id)
            rows = conn.execute(
                f"""
                SELECT t.id, t.profile_id, t.flown_on, t.origin_place_id, t.destination_place_id, t.layover_place_ids, t.estimated_miles, t.created_at
                FROM trip_logs t
                JOIN profiles p ON p.id = t.profile_id
                WHERE {filter_sql}
                ORDER BY COALESCE(t.flown_on, t.created_at) DESC, t.id DESC
                """,
                filter_params,
            ).fetchall()
        else:
            _can_read_profile(conn, profile_id, user_id)
            rows = conn.execute(
                """
                SELECT id, profile_id, flown_on, origin_place_id, destination_place_id, layover_place_ids, estimated_miles, created_at
                FROM trip_logs
                WHERE profile_id = ?
                ORDER BY COALESCE(flown_on, created_at) DESC, id DESC
                """,
                (profile_id,),
            ).fetchall()
        return [build_trip_log_payload(conn, row) for row in rows]


@app.post("/api/trip-logs")
async def create_trip_log(payload: Dict[str, Any], request: Request) -> Dict[str, Any]:
    profile_id = payload.get("profile_id")
    origin_place_id = str(payload.get("origin_place_id") or "").strip()
    destination_place_id = str(payload.get("destination_place_id") or "").strip()
    flown_on = payload.get("flown_on")
    layover_place_ids_raw = payload.get("layover_place_ids") or []

    if profile_id is None or not isinstance(profile_id, int):
        raise HTTPException(status_code=400, detail="profile_id is required")
    if not origin_place_id or not destination_place_id:
        raise HTTPException(status_code=400, detail="origin_place_id and destination_place_id are required")
    if not isinstance(layover_place_ids_raw, list):
        raise HTTPException(status_code=400, detail="layover_place_ids must be a list")

    layover_place_ids = [str(item).strip() for item in layover_place_ids_raw if str(item).strip()]
    route_ids = [origin_place_id, *layover_place_ids, destination_place_id]

    with get_db() as conn:
        user = _require_user(request, conn)
        _require_profile_owner(conn, profile_id, user["id"])

        place_rows = [get_place_by_id(conn, place_id) for place_id in route_ids]
        estimated_miles = 0.0
        for index in range(1, len(place_rows)):
            start = place_rows[index - 1]
            end = place_rows[index]
            estimated_miles += miles_between_points(start["lat"], start["lon"], end["lat"], end["lon"])

        created_at = datetime.utcnow().isoformat()
        cursor = conn.execute(
            """
            INSERT INTO trip_logs (
                profile_id, flown_on, origin_place_id, destination_place_id, layover_place_ids, estimated_miles, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            (
                profile_id,
                flown_on or None,
                origin_place_id,
                destination_place_id,
                json.dumps(layover_place_ids),
                estimated_miles,
                created_at,
            ),
        )
        inserted_row = cursor.fetchone()
        trip_id = int(inserted_row["id"] if isinstance(inserted_row, dict) else inserted_row[0])
        row = conn.execute(
            """
            SELECT id, profile_id, flown_on, origin_place_id, destination_place_id, layover_place_ids, estimated_miles, created_at
            FROM trip_logs
            WHERE id = ?
            """,
            (trip_id,),
        ).fetchone()
        return build_trip_log_payload(conn, row)


@app.delete("/api/trip-logs/{trip_log_id}")
async def delete_trip_log(trip_log_id: int, request: Request) -> Dict[str, Any]:
    with get_db() as conn:
        user = _require_user(request, conn)
        row = conn.execute(
            """
            SELECT t.id
            FROM trip_logs t
            JOIN profiles p ON p.id = t.profile_id
            WHERE t.id = ? AND p.owner_user_id = ?
            """,
            (trip_log_id, user["id"]),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Trip log not found")
        conn.execute("DELETE FROM trip_logs WHERE id = ?", (trip_log_id,))
    return {"status": "ok"}


@app.get("/api/stats")
async def get_stats(request: Request, profile_id: Optional[int] = None) -> Dict[str, Any]:
    with get_db() as conn:
        user = _optional_user(request, conn)
        user_id = int(user["id"]) if user else None
        selected_profile_public = False
        if profile_id is not None:
            profile = _can_read_profile(conn, profile_id, user_id)
            selected_profile_public = bool(profile.get("is_public"))

        total_counts = _total_place_counts(conn)
        total_continents = _total_continent_count(conn)
        stats = _compute_profile_stats(
            conn,
            profile_id=profile_id,
            user_id=user_id,
            total_counts=total_counts,
            total_continents=total_continents,
        )

        public_profile_rows = conn.execute(
            "SELECT id, name, color, is_public FROM profiles WHERE is_public = ? ORDER BY LOWER(name), id",
            (True,),
        ).fetchall()
        public_snapshots = [
            {
                "id": int(row["id"]),
                "name": str(row["name"]),
                "color": normalize_profile_color(row["color"]),
                "is_public": bool(row["is_public"]),
                "stats": _compute_profile_stats(
                    conn,
                    profile_id=int(row["id"]),
                    user_id=user_id,
                    total_counts=total_counts,
                    total_continents=total_continents,
                ),
            }
            for row in public_profile_rows
        ]

        stats["achievements"] = _apply_rarity_to_achievements(stats["achievements"], public_snapshots)
        stats["leaderboard"] = _build_leaderboard(stats, profile_id, selected_profile_public, public_snapshots)
        return stats


@app.get("/api/export")
async def export_data(profile_id: int, request: Request) -> JSONResponse:
    with get_db() as conn:
        user = _require_user(request, conn)
        _require_profile_owner(conn, profile_id, user["id"])
        visits = conn.execute(
            "SELECT place_id, visited_at, trip_id FROM visits WHERE profile_id = ?",
            (profile_id,),
        ).fetchall()
        trip_logs = conn.execute(
            """
            SELECT flown_on, origin_place_id, destination_place_id, layover_place_ids, estimated_miles
            FROM trip_logs
            WHERE profile_id = ?
            ORDER BY COALESCE(flown_on, created_at), id
            """,
            (profile_id,),
        ).fetchall()
    payload = {
        "profile_id": profile_id,
        "visits": [dict(row) for row in visits],
        "trip_logs": [dict(row) for row in trip_logs],
        "exported_at": datetime.utcnow().isoformat(),
    }
    return JSONResponse(content=payload)


@app.post("/api/import")
async def import_data(profile_id: int, request: Request, file: UploadFile = File(...)) -> Dict[str, Any]:
    content = await file.read(IMPORT_MAX_BYTES + 1)
    if len(content) > IMPORT_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Import file exceeds maximum size of {IMPORT_MAX_BYTES} bytes",
        )
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON") from exc
    visits = payload.get("visits")
    if not isinstance(visits, list):
        raise HTTPException(status_code=400, detail="Invalid visits data")
    trip_logs = payload.get("trip_logs") or []
    if not isinstance(trip_logs, list):
        raise HTTPException(status_code=400, detail="Invalid trip_logs data")

    with get_db() as conn:
        user = _require_user(request, conn)
        _require_profile_owner(conn, profile_id, user["id"])
        try:
            conn.execute("DELETE FROM visits WHERE profile_id = ?", (profile_id,))
            conn.execute("DELETE FROM trip_logs WHERE profile_id = ?", (profile_id,))
            for visit in visits:
                conn.execute(
                    """
                    INSERT INTO visits (profile_id, place_id, visited_at, trip_id, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (profile_id, place_id) DO UPDATE SET
                        visited_at = excluded.visited_at,
                        trip_id = excluded.trip_id,
                        created_at = excluded.created_at
                    """,
                    (
                        profile_id,
                        visit.get("place_id"),
                        visit.get("visited_at"),
                        visit.get("trip_id"),
                        datetime.utcnow().isoformat(),
                    ),
                )
            for trip in trip_logs:
                origin_place_id = str(trip.get("origin_place_id") or "").strip()
                destination_place_id = str(trip.get("destination_place_id") or "").strip()
                layover_place_ids = trip.get("layover_place_ids") or []
                if not origin_place_id or not destination_place_id or not isinstance(layover_place_ids, list):
                    raise HTTPException(status_code=400, detail="Invalid trip log entry")
                conn.execute(
                    """
                    INSERT INTO trip_logs (
                        profile_id, flown_on, origin_place_id, destination_place_id, layover_place_ids, estimated_miles, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        profile_id,
                        trip.get("flown_on"),
                        origin_place_id,
                        destination_place_id,
                        json.dumps(layover_place_ids),
                        float(trip.get("estimated_miles") or 0.0),
                        datetime.utcnow().isoformat(),
                    ),
                )
        except DB_INTEGRITY_ERRORS as exc:
            raise HTTPException(status_code=400, detail="Import contains invalid place IDs") from exc
    return {"status": "ok", "imported_visits": len(visits), "imported_trip_logs": len(trip_logs)}


if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")


@app.get("/")
async def root() -> FileResponse:
    index_path = FRONTEND_DIST / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return FileResponse(str(Path(__file__).parent / "placeholder.html"))
