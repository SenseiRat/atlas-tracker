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

def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")

def _base64url_decode(raw: str) -> bytes:
    padding = "=" * ((4 - len(raw) % 4) % 4)
    return base64.urlsafe_b64decode(raw + padding)

_SESSION_SECRET_CACHE: Optional[str] = None

def _get_session_secret() -> str:
    """Return the cookie-signing secret.

    Uses OIDC_SESSION_SECRET when configured; otherwise generates a random
    secret once and persists it in DATA_DIR so sessions survive restarts.
    """
    global _SESSION_SECRET_CACHE
    if OIDC_SESSION_SECRET:
        return OIDC_SESSION_SECRET
    if _SESSION_SECRET_CACHE:
        return _SESSION_SECRET_CACHE
    secret_path = DATA_DIR / "session_secret"
    secret = ""
    try:
        secret = secret_path.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    if not secret:
        secret = secrets.token_hex(32)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        secret_path.write_text(secret, encoding="utf-8")
        try:
            secret_path.chmod(0o600)
        except OSError:
            pass
    _SESSION_SECRET_CACHE = secret
    return secret

def _sign_payload(payload: Dict[str, Any]) -> str:
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_part = _base64url_encode(payload_json)
    signature = hmac.new(_get_session_secret().encode("utf-8"), payload_part.encode("utf-8"), hashlib.sha256).digest()
    return f"{payload_part}.{_base64url_encode(signature)}"

def _read_signed_cookie(raw_cookie: Optional[str]) -> Optional[Dict[str, Any]]:
    if not raw_cookie:
        return None
    try:
        payload_part, signature_part = raw_cookie.split(".", 1)
    except ValueError:
        return None
    expected_sig = hmac.new(
        _get_session_secret().encode("utf-8"),
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


__all__ = [
    '_hash_password',
    '_verify_password',
    '_base64url_encode',
    '_base64url_decode',
    '_SESSION_SECRET_CACHE',
    '_get_session_secret',
    '_sign_payload',
    '_read_signed_cookie',
    '_set_signed_cookie',
    '_clear_cookie',
]
