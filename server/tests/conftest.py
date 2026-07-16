"""Test harness for the World Visited Tracker API.

Configuration is read from the environment at import time in server.main,
so the fixture environment must be in place before the app module is
imported. Everything below therefore sets env vars first and imports the
app lazily inside the session fixture.
"""
from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

TESTS_DIR = Path(__file__).parent
SERVER_DIR = TESTS_DIR.parent
REPO_ROOT = SERVER_DIR.parent
FIXTURE_DATA_SOURCES = TESTS_DIR / "fixtures" / "data_sources"


@pytest.fixture(scope="session")
def app_module(tmp_path_factory):
    data_dir = tmp_path_factory.mktemp("data")
    env = {
        "DATA_DIR": str(data_dir),
        "DATA_SOURCES_DIR": str(FIXTURE_DATA_SOURCES),
        "DB_BACKEND": "sqlite",
        "DB_HOST": "",
        "DB_NAME": "",
        "SQLITE_DB_PATH": "",
        "DATA_SYNC_INTERVAL_SECONDS": "0",  # disables the background sync thread
        "FRONTEND_DIST": str(data_dir / "no-dist"),
        "OIDC_ISSUER": "",
        "OIDC_CLIENT_ID": "",
        "OIDC_SESSION_SECRET": "",
        # keep test runs fast; production default is 260k iterations
        "PASSWORD_HASH_ITERATIONS": "1000",
    }
    old_env = {key: os.environ.get(key) for key in env}
    os.environ.update(env)
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    for name in [m for m in sys.modules if m == "server.main" or m.startswith("server.")]:
        del sys.modules[name]
    module = importlib.import_module("server.main")
    yield module
    for key, value in old_env.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


@pytest.fixture(scope="session")
def client(app_module):
    """Session-wide client. Startup seeds places from the fixture datasets."""
    with TestClient(app_module.app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def _app_started(client):
    """Every test needs the app startup (schema + data seed) to have run."""
    _ = client


def _fresh_client(app_module) -> TestClient:
    return TestClient(app_module.app)


@pytest.fixture()
def anon_client(app_module, client):
    """A client with no cookies. Depends on `client` so startup has run."""
    with _fresh_client(app_module) as c:
        yield c


_user_counter = 0


def register_user(app_module, *, display_name: str | None = None) -> TestClient:
    """Register a new local user and return a logged-in client."""
    global _user_counter
    _user_counter += 1
    username = f"user{_user_counter}"
    c = _fresh_client(app_module)
    response = c.post(
        "/api/auth/local/register",
        json={
            "username": username,
            "display_name": display_name or f"User {_user_counter}",
            "password": "test-password",
        },
    )
    assert response.status_code == 200, response.text
    c.username = username  # type: ignore[attr-defined]
    c.user_id = int(response.json()["user_id"])  # type: ignore[attr-defined]
    return c


@pytest.fixture(scope="session")
def admin(app_module, client) -> TestClient:
    """First registered user; the app auto-assigns the admin role."""
    return register_user(app_module, display_name="Admin")


@pytest.fixture(scope="session")
def user(app_module, admin) -> TestClient:
    """A second, non-admin user (registered after `admin`)."""
    return register_user(app_module, display_name="Regular")


def create_profile(client: TestClient, name: str, **extra) -> dict:
    response = client.post("/api/profiles", json={"name": name, **extra})
    assert response.status_code == 200, response.text
    return response.json()
