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
from typing import Any, Dict, List, Optional, Set, Tuple
from collections.abc import Callable, Iterator

from fastapi import APIRouter, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from server.app.config import *  # noqa: F401,F403

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
    def lastrowid(self) -> int | None:
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

    def fetchall(self) -> list[Any]:
        return self._cursor.fetchall()


class DBConnection:
    def __init__(self, conn: Any, backend: str):
        self._conn = conn
        self._backend = backend

    def _format_query(self, query: str) -> str:
        if self._backend == "postgres":
            return query.replace("?", "%s")
        return query

    def execute(self, query: str, params: tuple[Any, ...] | list[Any] = ()) -> DBResult:
        if self._backend == "postgres":
            cursor = self._conn.cursor()
            cursor.execute(self._format_query(query), params)
            return DBResult(cursor)
        return DBResult(self._conn.execute(query, params))

    def executemany(self, query: str, params_seq: list[tuple[Any, ...]]) -> None:
        if self._backend == "postgres":
            cursor = self._conn.cursor()
            cursor.executemany(self._format_query(query), params_seq)
            return
        self._conn.executemany(query, params_seq)


DB_INTEGRITY_ERRORS = (sqlite3.IntegrityError,)

if psycopg is not None:
    DB_INTEGRITY_ERRORS = (sqlite3.IntegrityError, psycopg.IntegrityError)


def _connect_db(backend: str, settings: dict[str, Any] | None = None) -> Any:
    config = settings or {}
    if backend == "postgres":
        if psycopg is None:
            raise RuntimeError("psycopg is required when using postgres")
        port_raw = str(config.get("db_port") or DB_PORT).strip()
        conn_kwargs: dict[str, Any] = {
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
            raise HTTPException(
                status_code=400, detail="Postgres host and database name are required"
            )
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
def get_db_for_backend(
    backend: str, settings: dict[str, Any] | None = None
) -> Iterator[DBConnection]:
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
    schema_statements = (
        POSTGRES_SCHEMA_STATEMENTS if backend == "postgres" else SQLITE_SCHEMA_STATEMENTS
    )
    index_statements = (
        POSTGRES_INDEX_STATEMENTS if backend == "postgres" else SQLITE_INDEX_STATEMENTS
    )
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
        conn.execute(
            "ALTER TABLE users ADD COLUMN measurement_system TEXT NOT NULL DEFAULT 'imperial'"
        )
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


def _accessible_profile_filter_sql(
    profile_alias: str, user_id: int | None
) -> tuple[str, tuple[Any, ...]]:
    prefix = f"{profile_alias}." if profile_alias else ""
    if user_id is None:
        return f"{prefix}is_public = ?", (True,)
    return f"({prefix}is_public = ? OR {prefix}owner_user_id = ?)", (True, user_id)


__all__ = [
    "SQLITE_SCHEMA_STATEMENTS",
    "SQLITE_INDEX_STATEMENTS",
    "POSTGRES_SCHEMA_STATEMENTS",
    "POSTGRES_INDEX_STATEMENTS",
    "DBResult",
    "DBConnection",
    "DB_INTEGRITY_ERRORS",
    "_connect_db",
    "get_db",
    "get_db_for_backend",
    "_ensure_schema",
    "init_db",
    "_accessible_profile_filter_sql",
]
