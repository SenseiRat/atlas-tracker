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
from server.app.helpers import *  # noqa: F401,F403
from server.app.security import *  # noqa: F401,F403
from server.app.settings_store import *  # noqa: F401,F403
from server.app.data_sources import *  # noqa: F401,F403
from server.app.stats import *  # noqa: F401,F403
from server.app.auth import *  # noqa: F401,F403

router = APIRouter()


@router.get("/api/auth/session")
async def get_auth_session(request: Request) -> dict[str, Any]:
    with get_db() as conn:
        user = _optional_user(request, conn)
        local_users = _get_local_users(conn) if not OIDC_ENABLED else []
    return {
        "oidc_enabled": OIDC_ENABLED,
        "authenticated": bool(user),
        "auth_mode": "oidc" if OIDC_ENABLED else "local",
        "local_users_count": len(local_users),
        "has_local_users": len(local_users) > 0,
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


@router.put("/api/auth/account")
async def update_auth_account(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    with get_db() as conn:
        user = _require_user(request, conn)
        display_name = str(payload.get("display_name") or "").strip()
        if not display_name:
            raise HTTPException(status_code=400, detail="Display name is required")
        theme_preference = (
            str(payload.get("theme_preference") or user.get("theme_preference") or "dark")
            .strip()
            .lower()
        )
        if theme_preference not in {"light", "dark"}:
            raise HTTPException(status_code=400, detail="Theme must be light or dark")
        measurement_system = (
            str(payload.get("measurement_system") or user.get("measurement_system") or "imperial")
            .strip()
            .lower()
        )
        if measurement_system not in {"metric", "imperial"}:
            raise HTTPException(
                status_code=400, detail="Measurement system must be metric or imperial"
            )
        default_profile_raw = payload.get("default_profile_id")
        default_profile_id: int | None
        if default_profile_raw in {None, "", "null"}:
            default_profile_id = None
        else:
            try:
                default_profile_id = int(default_profile_raw)
            except (TypeError, ValueError) as exc:
                raise HTTPException(
                    status_code=400, detail="default_profile_id must be an integer or null"
                ) from exc
            _can_read_profile(conn, default_profile_id, int(user["id"]))

        username = user.get("username")
        if str(user.get("oidc_issuer") or "") == "local":
            username = _normalize_local_username(payload.get("username"))

        password = str(payload.get("password") or "")
        if password and str(user.get("oidc_issuer") or "") != "local":
            raise HTTPException(
                status_code=400, detail="Only local users can change passwords here"
            )

        try:
            conn.execute(
                "UPDATE users SET username = ?, display_name = ?, theme_preference = ?, measurement_system = ?, default_profile_id = ? WHERE id = ?",
                (
                    username,
                    display_name,
                    theme_preference,
                    measurement_system,
                    default_profile_id,
                    int(user["id"]),
                ),
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


@router.get("/api/auth/login")
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


@router.get("/api/auth/callback")
async def auth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
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
        token_response = _http_json(
            metadata["token_endpoint"], method="POST", payload=token_payload
        )
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
        str(
            claims.get("name") or claims.get("preferred_username") or claims.get("email") or ""
        ).strip()
        or None
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
    _set_signed_cookie(
        response, OIDC_SESSION_COOKIE, session_payload, max(OIDC_SESSION_TTL_SECONDS, 3600)
    )
    _clear_cookie(response, OIDC_LOGIN_COOKIE)
    return response


@router.post("/api/auth/logout")
async def auth_logout() -> Response:
    response = JSONResponse({"status": "ok"})
    _clear_cookie(response, OIDC_SESSION_COOKIE)
    _clear_cookie(response, OIDC_LOGIN_COOKIE)
    _clear_cookie(response, LOCAL_USER_COOKIE)
    return response


async def create_local_user(payload: dict[str, Any]) -> dict[str, Any]:
    if OIDC_ENABLED:
        raise HTTPException(status_code=404, detail="Local users are disabled when OIDC is enabled")
    username = _normalize_local_username(payload.get("username"))
    display_name = str(payload.get("display_name") or "").strip()
    password = str(payload.get("password") or "")
    if not display_name:
        raise HTTPException(status_code=400, detail="Display name is required")
    password_hash = _hash_password(password)
    subject = f"local-{slugify(username)}-{secrets.token_hex(4)}"
    now = current_timestamp()
    with get_db() as conn:
        local_user_count = int(
            conn.execute(
                "SELECT COUNT(*) as count FROM users WHERE oidc_issuer = 'local'"
            ).fetchone()["count"]
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
    return {
        "id": user_id,
        "username": username,
        "display_name": display_name,
        "role": role,
        "is_admin": role == "admin",
    }


@router.post("/api/auth/local/register")
async def register_local_user(payload: dict[str, Any]) -> Response:
    if OIDC_ENABLED:
        raise HTTPException(status_code=404, detail="Local users are disabled when OIDC is enabled")
    response_data = await create_local_user(payload)
    user_id = int(response_data["id"])
    response = JSONResponse({"status": "ok", "user_id": user_id})
    _set_local_session_cookie(response, user_id)
    return response


@router.post("/api/auth/local/login")
async def local_login(payload: dict[str, Any]) -> Response:
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
            (current_timestamp(), int(user["id"])),
        )
    response = JSONResponse({"status": "ok"})
    _set_local_session_cookie(response, int(user["id"]))
    return response


@router.get("/api/profiles")
async def get_profiles(request: Request) -> list[dict[str, Any]]:
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


def _mark_home_country_visited(conn, profile_id: int, home_country_code: str | None) -> None:
    """Seed a visit for the profile's home country: everyone has been there."""
    if not home_country_code:
        return
    code = str(home_country_code).strip().upper()
    row = conn.execute(
        "SELECT id FROM places WHERE type = 'country' AND (id = ? OR country_code = ?) LIMIT 1",
        (f"country-{code}", code),
    ).fetchone()
    if not row:
        return
    conn.execute(
        """
        INSERT INTO visits (profile_id, place_id, visited_at, trip_id, created_at)
        VALUES (?, ?, NULL, NULL, ?)
        ON CONFLICT (profile_id, place_id) DO NOTHING
        """,
        (profile_id, str(row["id"]), current_timestamp()),
    )


@router.post("/api/profiles")
async def create_profile(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    color = normalize_profile_color(payload.get("color"))
    home_country_code = normalize_profile_home_country_code(payload.get("home_country_code"))
    is_public = bool(payload.get("is_public"))
    now = current_timestamp()
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
        _mark_home_country_visited(conn, profile_id, home_country_code)
        row = conn.execute(
            "SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
    return _normalize_profile_row(row, int(owner_user_id))


@router.put("/api/profiles/{profile_id}")
async def update_profile(
    profile_id: int, payload: dict[str, Any], request: Request
) -> dict[str, Any]:
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
            home_country_code = normalize_profile_home_country_code(
                payload.get("home_country_code")
            )
        else:
            home_country_code = (
                normalize_profile_home_country_code(profile["home_country_code"])
                if profile["home_country_code"]
                else None
            )
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
        previous_home_code = (
            normalize_profile_home_country_code(profile["home_country_code"])
            if profile["home_country_code"]
            else None
        )
        if home_country_code and home_country_code != previous_home_code:
            _mark_home_country_visited(conn, profile_id, home_country_code)
        row = conn.execute(
            "SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
    return _normalize_profile_row(row, int(user["id"]))


@router.delete("/api/profiles/{profile_id}")
async def delete_profile(profile_id: int, request: Request) -> dict[str, Any]:
    with get_db() as conn:
        user = _require_user(request, conn)
        _require_profile_owner(conn, profile_id, user["id"])
        conn.execute(
            "UPDATE users SET default_profile_id = NULL WHERE default_profile_id = ?", (profile_id,)
        )
        conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
    return {"status": "ok"}


@router.get("/api/admin/users")
async def admin_get_users(request: Request) -> list[dict[str, Any]]:
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


@router.post("/api/admin/users")
async def admin_create_user(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    with get_db() as conn:
        _require_admin(request, conn)
    created = await create_local_user(payload)
    if bool(payload.get("is_admin")):
        with get_db() as conn:
            conn.execute("UPDATE users SET role = 'admin' WHERE id = ?", (int(created["id"]),))
        created["role"] = "admin"
        created["is_admin"] = True
    return created


@router.put("/api/admin/users/{user_id}")
async def admin_update_user(
    user_id: int, payload: dict[str, Any], request: Request
) -> dict[str, Any]:
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


@router.post("/api/admin/users/{user_id}/password")
async def admin_reset_user_password(
    user_id: int, payload: dict[str, Any], request: Request
) -> dict[str, Any]:
    password = str(payload.get("password") or "")
    if not password:
        raise HTTPException(status_code=400, detail="Password is required")
    with get_db() as conn:
        _require_admin(request, conn)
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?", (_hash_password(password), user_id)
        )
    return {"status": "ok"}


@router.delete("/api/admin/users/{user_id}")
async def admin_delete_user(user_id: int, request: Request) -> dict[str, Any]:
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


@router.get("/api/admin/profiles")
async def admin_get_profiles(request: Request) -> list[dict[str, Any]]:
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
    items: list[dict[str, Any]] = []
    for row in rows:
        item = _normalize_profile_row(row, None)
        item["owner_label"] = (
            row["display_name"]
            or row["username"]
            or (f"User {row['owner_user_id']}" if row["owner_user_id"] else "Unowned")
        )
        items.append(item)
    return items


@router.post("/api/admin/profiles")
async def admin_create_profile(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    owner_user_id = payload.get("owner_user_id")
    color = normalize_profile_color(payload.get("color"))
    home_country_code = normalize_profile_home_country_code(payload.get("home_country_code"))
    is_public = bool(payload.get("is_public"))
    if not isinstance(owner_user_id, int):
        raise HTTPException(status_code=400, detail="owner_user_id is required")
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    now = current_timestamp()
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
        _mark_home_country_visited(conn, profile_id, home_country_code)
        row = conn.execute(
            "SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
    return _normalize_profile_row(row, owner_user_id)


@router.put("/api/admin/profiles/{profile_id}")
async def admin_update_profile(
    profile_id: int, payload: dict[str, Any], request: Request
) -> dict[str, Any]:
    with get_db() as conn:
        _require_admin(request, conn)
        row = conn.execute(
            "SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Profile not found")
        name = str(payload.get("name") or row["name"]).strip()
        color = normalize_profile_color(
            payload.get("color") if "color" in payload else row["color"]
        )
        home_country_code = (
            normalize_profile_home_country_code(payload.get("home_country_code"))
            if "home_country_code" in payload
            else (
                normalize_profile_home_country_code(row["home_country_code"])
                if row["home_country_code"]
                else None
            )
        )
        is_public = (
            bool(payload.get("is_public")) if "is_public" in payload else bool(row["is_public"])
        )
        owner_user_id = payload.get("owner_user_id", row["owner_user_id"])
        if owner_user_id is not None and not isinstance(owner_user_id, int):
            raise HTTPException(status_code=400, detail="owner_user_id must be an integer or null")
        conn.execute(
            "UPDATE profiles SET name = ?, color = ?, home_country_code = ?, is_public = ?, owner_user_id = ? WHERE id = ?",
            (name, color, home_country_code, is_public, owner_user_id, profile_id),
        )
        previous_home_code = (
            normalize_profile_home_country_code(row["home_country_code"])
            if row["home_country_code"]
            else None
        )
        if home_country_code and home_country_code != previous_home_code:
            _mark_home_country_visited(conn, profile_id, home_country_code)
        updated = conn.execute(
            "SELECT id, name, color, home_country_code, is_public, owner_user_id FROM profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
    return _normalize_profile_row(
        updated, owner_user_id if isinstance(owner_user_id, int) else None
    )


@router.delete("/api/admin/profiles/{profile_id}")
async def admin_delete_profile(profile_id: int, request: Request) -> dict[str, Any]:
    with get_db() as conn:
        _require_admin(request, conn)
        row = conn.execute("SELECT id FROM profiles WHERE id = ?", (profile_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Profile not found")
        conn.execute(
            "UPDATE users SET default_profile_id = NULL WHERE default_profile_id = ?", (profile_id,)
        )
        conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
    return {"status": "ok"}


@router.get("/api/admin/settings")
async def admin_get_settings(request: Request) -> dict[str, Any]:
    with get_db() as conn:
        _require_admin(request, conn)
        return _masked_settings(_get_app_settings(conn))


@router.put("/api/admin/settings")
async def admin_update_settings(payload: dict[str, Any], request: Request) -> dict[str, Any]:
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
    if "preferred_db_backend" in updates and str(updates["preferred_db_backend"]) not in {
        "sqlite",
        "postgres",
    }:
        raise HTTPException(
            status_code=400, detail="preferred_db_backend must be sqlite or postgres"
        )
    if "auth_mode" in updates and str(updates["auth_mode"]) not in {"local", "oidc"}:
        raise HTTPException(status_code=400, detail="auth_mode must be local or oidc")
    with get_db() as conn:
        _require_admin(request, conn)
        updates = _resolve_secret_placeholders(updates, _get_app_settings(conn))
        _set_app_settings(conn, updates)
        settings = _masked_settings(_get_app_settings(conn))
    settings["restart_required"] = True
    return settings


@router.post("/api/admin/settings/migrate")
async def admin_migrate_settings(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    target_backend = str(payload.get("preferred_db_backend") or "").strip().lower()
    if target_backend not in {"sqlite", "postgres"}:
        raise HTTPException(
            status_code=400, detail="preferred_db_backend must be sqlite or postgres"
        )

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
        raise HTTPException(
            status_code=400,
            detail="Migration target must be different from the current active database",
        )

    with get_db() as source_conn:
        _require_admin(request, source_conn)
        updates = _resolve_secret_placeholders(updates, _get_app_settings(source_conn))
        _set_app_settings(source_conn, updates)
        current_settings = _get_app_settings(source_conn)
        current_settings.update(updates)
        snapshot = {
            "users": _list_table_rows(
                source_conn,
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
            ),
            "profiles": _list_table_rows(
                source_conn,
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
            ),
            "places": _list_table_rows(
                source_conn, "places", ["id", "type", "name", "country_code", "lat", "lon", "data"]
            ),
            "visits": _list_table_rows(
                source_conn,
                "visits",
                ["profile_id", "place_id", "visited_at", "trip_id", "created_at"],
            ),
            "trip_logs": _list_table_rows(
                source_conn,
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
            ),
            "place_source_state": _list_table_rows(
                source_conn,
                "place_source_state",
                ["place_id", "source_key", "content_hash", "is_active", "last_seen_at"],
            ),
            "app_settings": [
                {"key": str(key), "value": str(value)}
                for key, value in current_settings.items()
                if value is not None
            ],
        }

    _migrate_database_snapshot(target_backend, updates, snapshot)

    response = _masked_settings(current_settings)
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


@router.get("/api/places")
async def get_places(
    type: str = Query(...),
    query: str | None = None,
    country_code: str | None = None,
    major_only: bool = False,
    include_total: bool = True,
    limit: int = Query(1000, ge=1, le=20000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    if type not in VALID_PLACE_TYPES:
        raise HTTPException(status_code=400, detail="Invalid place type")
    params: list[Any] = [type, True]
    where = f"WHERE places.type = ? AND {_active_place_filter_sql()}"
    if query:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where += " AND places.name LIKE ? ESCAPE '\\'"
        params.append(f"%{escaped}%")
    country_codes = [
        str(code).strip().upper()
        for code in str(country_code or "").split(",")
        if str(code).strip()
    ]
    if country_codes:
        placeholders = ",".join("?" for _ in country_codes)
        where += f" AND places.country_code IN ({placeholders})"
        params.extend(country_codes)

    items: list[dict[str, Any]] = []
    total: int | None = None
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
                    allowed_type = airport_type in {
                        "regional_airport",
                        "medium_airport",
                        "large_airport",
                    }
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
                f"SELECT COUNT(*) as count FROM places {_active_place_join_sql()} {where}",
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


@router.get("/api/places/geojson")
async def get_places_geojson(type: str) -> dict[str, Any]:
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


@router.get("/api/visits")
async def get_visits(request: Request, profile_id: int | None = None) -> list[dict[str, Any]]:
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


@router.post("/api/visits/toggle")
async def toggle_visit(payload: dict[str, Any], request: Request) -> dict[str, Any]:
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
                        current_timestamp(),
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


@router.get("/api/trip-logs")
async def get_trip_logs(request: Request, profile_id: int | None = None) -> list[dict[str, Any]]:
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


@router.post("/api/trip-logs")
async def create_trip_log(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    profile_id = payload.get("profile_id")
    origin_place_id = str(payload.get("origin_place_id") or "").strip()
    destination_place_id = str(payload.get("destination_place_id") or "").strip()
    flown_on = payload.get("flown_on")
    layover_place_ids_raw = payload.get("layover_place_ids") or []

    if profile_id is None or not isinstance(profile_id, int):
        raise HTTPException(status_code=400, detail="profile_id is required")
    if not origin_place_id or not destination_place_id:
        raise HTTPException(
            status_code=400, detail="origin_place_id and destination_place_id are required"
        )
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
            estimated_miles += miles_between_points(
                start["lat"], start["lon"], end["lat"], end["lon"]
            )

        created_at = current_timestamp()
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


@router.delete("/api/trip-logs/{trip_log_id}")
async def delete_trip_log(trip_log_id: int, request: Request) -> dict[str, Any]:
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


@router.get("/api/stats")
async def get_stats(request: Request, profile_id: int | None = None) -> dict[str, Any]:
    with get_db() as conn:
        user = _optional_user(request, conn)
        user_id = int(user["id"]) if user else None
        selected_profile_public = False
        if profile_id is not None:
            profile = _can_read_profile(conn, profile_id, user_id)
            selected_profile_public = bool(profile.get("is_public"))

        total_counts = _total_place_counts(conn)
        total_continents = _total_continent_count(conn)
        site_rows = _all_site_rows(conn)
        stats = _compute_profile_stats(
            conn,
            profile_id=profile_id,
            user_id=user_id,
            total_counts=total_counts,
            total_continents=total_continents,
            site_rows=site_rows,
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
                    site_rows=site_rows,
                ),
            }
            for row in public_profile_rows
        ]

        stats["achievements"] = _apply_rarity_to_achievements(
            stats["achievements"], public_snapshots
        )
        stats["leaderboard"] = _build_leaderboard(
            stats, profile_id, selected_profile_public, public_snapshots
        )
        return stats


@router.get("/api/export")
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
    trip_log_items = []
    for row in trip_logs:
        item = dict(row)
        item["layover_place_ids"] = _parse_layover_place_ids(item.get("layover_place_ids"))
        trip_log_items.append(item)
    payload = {
        "profile_id": profile_id,
        "visits": [dict(row) for row in visits],
        "trip_logs": trip_log_items,
        "exported_at": current_timestamp(),
    }
    return JSONResponse(content=payload)


@router.post("/api/import")
async def import_data(
    profile_id: int, request: Request, file: UploadFile = File(...)
) -> dict[str, Any]:
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
                        current_timestamp(),
                    ),
                )
            for trip in trip_logs:
                origin_place_id = str(trip.get("origin_place_id") or "").strip()
                destination_place_id = str(trip.get("destination_place_id") or "").strip()
                layover_raw = trip.get("layover_place_ids") or []
                if not isinstance(layover_raw, (list, str)):
                    raise HTTPException(status_code=400, detail="Invalid trip log entry")
                layover_place_ids = _parse_layover_place_ids(layover_raw)
                if not origin_place_id or not destination_place_id:
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
                        current_timestamp(),
                    ),
                )
        except DB_INTEGRITY_ERRORS as exc:
            raise HTTPException(
                status_code=400, detail="Import contains invalid place IDs"
            ) from exc
    return {"status": "ok", "imported_visits": len(visits), "imported_trip_logs": len(trip_logs)}


__all__ = [
    "get_auth_session",
    "update_auth_account",
    "auth_login",
    "auth_callback",
    "auth_logout",
    "create_local_user",
    "register_local_user",
    "local_login",
    "get_profiles",
    "create_profile",
    "update_profile",
    "delete_profile",
    "admin_get_users",
    "admin_create_user",
    "admin_update_user",
    "admin_reset_user_password",
    "admin_delete_user",
    "admin_get_profiles",
    "admin_create_profile",
    "admin_update_profile",
    "admin_delete_profile",
    "admin_get_settings",
    "admin_update_settings",
    "admin_migrate_settings",
    "get_places",
    "get_places_geojson",
    "get_visits",
    "toggle_visit",
    "get_trip_logs",
    "create_trip_log",
    "delete_trip_log",
    "get_stats",
    "export_data",
    "import_data",
]
