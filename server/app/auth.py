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
from server.app.security import *  # noqa: F401,F403

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

_OIDC_METADATA_CACHE: Optional[Dict[str, Any]] = None

_OIDC_JWKS_CLIENT: Any = None

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

def _set_local_session_cookie(response: Response, user_id: int) -> None:
    ttl_seconds = max(OIDC_SESSION_TTL_SECONDS, 3600)
    payload = {
        "uid": int(user_id),
        "iss": "local",
        "exp": int(time.time()) + ttl_seconds,
    }
    _set_signed_cookie(response, LOCAL_USER_COOKIE, payload, ttl_seconds)

def _get_local_user_by_cookie(request: Request, conn: DBConnection) -> Optional[Dict[str, Any]]:
    payload = _read_signed_cookie(request.cookies.get(LOCAL_USER_COOKIE))
    if not payload or payload.get("iss") != "local":
        return None
    try:
        user_id = int(payload.get("uid"))
    except (TypeError, ValueError):
        return None
    user = conn.execute(
        """
        SELECT id, username, oidc_issuer, oidc_subject, email, display_name, role, theme_preference, measurement_system, default_profile_id
        FROM users
        WHERE id = ? AND oidc_issuer = 'local'
        """,
        (user_id,),
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
    now = current_timestamp()
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


__all__ = [
    '_serialize_user',
    '_OIDC_METADATA_CACHE',
    '_OIDC_JWKS_CLIENT',
    '_http_json',
    '_get_oidc_metadata',
    '_get_oidc_jwks_client',
    '_get_request_base_url',
    '_get_redirect_uri',
    '_get_local_users',
    '_set_local_session_cookie',
    '_get_local_user_by_cookie',
    '_require_user',
    '_optional_user',
    '_upsert_user',
    '_assign_legacy_profiles_if_needed',
    '_normalize_profile_row',
    '_can_read_profile',
    '_require_profile_owner',
    '_require_admin',
]
