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
from server.app.db import *  # noqa: F401,F403


def _get_app_settings(conn: DBConnection) -> dict[str, Any]:
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


SECRET_SETTING_KEYS = ("db_password", "oidc_client_secret")

SECRET_PLACEHOLDER = "__secret_unchanged__"


def _masked_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Copy of settings with stored secrets replaced by a write-only sentinel."""
    masked = dict(settings)
    for key in SECRET_SETTING_KEYS:
        masked[key] = SECRET_PLACEHOLDER if masked.get(key) else ""
    return masked


def _resolve_secret_placeholders(updates: dict[str, Any], stored: dict[str, Any]) -> dict[str, Any]:
    """Replace the sentinel in incoming updates with the stored secret values."""
    resolved = dict(updates)
    for key in SECRET_SETTING_KEYS:
        if str(resolved.get(key, "")) == SECRET_PLACEHOLDER:
            resolved[key] = stored.get(key) or ""
    return resolved


def _set_app_settings(conn: DBConnection, settings: dict[str, Any]) -> None:
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


def _list_table_rows(conn: DBConnection, table: str, columns: list[str]) -> list[dict[str, Any]]:
    rows = conn.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall()
    return [dict(row) for row in rows]


def _same_backend_target(backend: str, settings: dict[str, Any]) -> bool:
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
    for table in (
        "visits",
        "trip_logs",
        "place_source_state",
        "profiles",
        "users",
        "places",
        "app_settings",
    ):
        conn.execute(f"DELETE FROM {table}")


# Columns declared BOOLEAN in the Postgres schema but stored as INTEGER (0/1) in
# SQLite. Postgres will not implicitly cast smallint -> boolean, so these values
# must be coerced to Python bool before insert. bool is a subclass of int, so this
# stays correct for a SQLite target as well.
BOOLEAN_COLUMNS: dict[str, set[str]] = {
    "profiles": {"is_public"},
    "place_source_state": {"is_active"},
}


def _coerce_value(table: str, column: str, value: Any) -> Any:
    if value is not None and column in BOOLEAN_COLUMNS.get(table, frozenset()):
        return bool(value)
    return value


def _copy_rows(
    conn: DBConnection, table: str, columns: list[str], rows: list[dict[str, Any]]
) -> None:
    if not rows:
        return
    placeholders = ",".join("?" for _ in columns)
    query = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})"
    conn.executemany(
        query,
        [
            tuple(_coerce_value(table, column, row.get(column)) for column in columns)
            for row in rows
        ],
    )


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


def _preflight_target_connection(target_backend: str, target_settings: dict[str, Any]) -> None:
    """Verify the migration target is reachable before copying any data.

    Opening the target connection first turns connection/auth failures into a
    clean 400 up front, instead of a 500 traceback surfacing mid-migration.
    The HTTPException raised by _connect_db for missing host/dbname is passed
    through unchanged.
    """
    try:
        with get_db_for_backend(target_backend, target_settings) as target_conn:
            target_conn.execute("SELECT 1").fetchone()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface any driver error as a 400
        logging.getLogger(__name__).warning(
            "Migration pre-flight to %s failed: %s", target_backend, exc
        )
        raise HTTPException(
            status_code=400,
            detail=f"Could not connect to the target {target_backend} database: {exc}",
        ) from exc


def _migrate_database_snapshot(
    target_backend: str, target_settings: dict[str, Any], snapshot: dict[str, list[dict[str, Any]]]
) -> None:
    with get_db_for_backend(target_backend, target_settings) as target_conn:
        _ensure_schema(target_conn, target_backend)
        _clear_target_tables(target_conn)
        _copy_rows(
            target_conn,
            "users",
            [
                "id",
                "username",
                "oidc_issuer",
                "oidc_subject",
                "email",
                "display_name",
                "password_hash",
                "role",
                "theme_preference",
                "measurement_system",
                "default_profile_id",
                "created_at",
                "last_login_at",
            ],
            snapshot["users"],
        )
        _copy_rows(
            target_conn,
            "profiles",
            [
                "id",
                "owner_user_id",
                "name",
                "color",
                "home_country_code",
                "is_public",
                "created_at",
            ],
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
            [
                "id",
                "profile_id",
                "flown_on",
                "origin_place_id",
                "destination_place_id",
                "layover_place_ids",
                "estimated_miles",
                "created_at",
            ],
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


__all__ = [
    "_get_app_settings",
    "SECRET_SETTING_KEYS",
    "SECRET_PLACEHOLDER",
    "_masked_settings",
    "_resolve_secret_placeholders",
    "_set_app_settings",
    "_list_table_rows",
    "_same_backend_target",
    "_clear_target_tables",
    "_copy_rows",
    "_reset_postgres_sequence",
    "_preflight_target_connection",
    "_migrate_database_snapshot",
]
