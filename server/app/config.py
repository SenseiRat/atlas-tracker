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

SQLITE_ENABLE_WAL = os.environ.get("SQLITE_ENABLE_WAL", "1").strip().lower() not in {
    "0",
    "false",
    "no",
}

IMPORT_MAX_BYTES = int(os.environ.get("IMPORT_MAX_BYTES", str(10 * 1024 * 1024)))

OIDC_ISSUER = os.environ.get("OIDC_ISSUER", "").strip()

OIDC_CLIENT_ID = os.environ.get("OIDC_CLIENT_ID", "").strip()

OIDC_CLIENT_SECRET = os.environ.get("OIDC_CLIENT_SECRET", "").strip()

OIDC_SCOPES = (
    os.environ.get("OIDC_SCOPES", "openid profile email").strip() or "openid profile email"
)

OIDC_REDIRECT_PATH = (
    os.environ.get("OIDC_REDIRECT_PATH", "/api/auth/callback").strip() or "/api/auth/callback"
)

OIDC_SESSION_SECRET = os.environ.get("OIDC_SESSION_SECRET", "").strip()

OIDC_SESSION_COOKIE = (
    os.environ.get("OIDC_SESSION_COOKIE", "world_tracker_session").strip()
    or "world_tracker_session"
)

OIDC_LOGIN_COOKIE = (
    os.environ.get("OIDC_LOGIN_COOKIE", "world_tracker_login").strip() or "world_tracker_login"
)

OIDC_SESSION_TTL_SECONDS = int(os.environ.get("OIDC_SESSION_TTL_SECONDS", str(7 * 24 * 60 * 60)))

OIDC_LOGIN_TTL_SECONDS = int(os.environ.get("OIDC_LOGIN_TTL_SECONDS", "600"))

OIDC_COOKIE_SECURE = os.environ.get("OIDC_COOKIE_SECURE", "0").strip().lower() in {
    "1",
    "true",
    "yes",
}

LOCAL_USER_COOKIE = (
    os.environ.get("LOCAL_USER_COOKIE", "world_tracker_local_user").strip()
    or "world_tracker_local_user"
)

PASSWORD_HASH_ITERATIONS = int(os.environ.get("PASSWORD_HASH_ITERATIONS", "260000"))

DATA_SYNC_INTERVAL_SECONDS = max(int(os.environ.get("DATA_SYNC_INTERVAL_SECONDS", "3600")), 0)

# v4: ISO_A2_EH + territory fallbacks so FR/NO/TW/etc. cities map to countries.
DATA_SYNC_SCHEMA_VERSION = 4

SourceCollector = Callable[[Any, dict[str, Any]], tuple[list[tuple], dict[str, tuple[str, str]]]]

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

logger = logging.getLogger("world_tracker")

VALID_PLACE_TYPES = {"country", "state", "city", "airport", "site"}

IATA_CODE_RE = re.compile(r"^[A-Z]{3}$")

HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

DEFAULT_PROFILE_COLOR = "#22c55e"

DATA_SYNC_THREAD_LOCK = threading.Lock()

DATA_SYNC_STOP_EVENT = threading.Event()

DATA_SYNC_THREAD: threading.Thread | None = None

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
    raise RuntimeError(
        "OIDC_SESSION_SECRET is required when OIDC_ISSUER and OIDC_CLIENT_ID are set"
    )

if OIDC_ENABLED and jwt is None:
    raise RuntimeError("PyJWT is required when OIDC authentication is enabled")


__all__ = [
    "DATA_DIR",
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
    "DB_SSLMODE",
    "SQLITE_DB_PATH_RAW",
    "DB_PATH",
    "DATA_SOURCES_DIR",
    "FRONTEND_DIST",
    "SQLITE_BUSY_TIMEOUT_MS",
    "SQLITE_ENABLE_WAL",
    "IMPORT_MAX_BYTES",
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_SCOPES",
    "OIDC_REDIRECT_PATH",
    "OIDC_SESSION_SECRET",
    "OIDC_SESSION_COOKIE",
    "OIDC_LOGIN_COOKIE",
    "OIDC_SESSION_TTL_SECONDS",
    "OIDC_LOGIN_TTL_SECONDS",
    "OIDC_COOKIE_SECURE",
    "LOCAL_USER_COOKIE",
    "PASSWORD_HASH_ITERATIONS",
    "DATA_SYNC_INTERVAL_SECONDS",
    "DATA_SYNC_SCHEMA_VERSION",
    "SourceCollector",
    "SOURCE_DATASET_DEFINITIONS",
    "logger",
    "VALID_PLACE_TYPES",
    "IATA_CODE_RE",
    "HEX_COLOR_RE",
    "DEFAULT_PROFILE_COLOR",
    "DATA_SYNC_THREAD_LOCK",
    "DATA_SYNC_STOP_EVENT",
    "DATA_SYNC_THREAD",
    "DB_BACKEND_ENV",
    "DB_BACKEND",
    "psycopg",
    "dict_row",
    "jwt",
    "OIDC_ENABLED",
]
