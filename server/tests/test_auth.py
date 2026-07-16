"""Auth and session behavior."""
from __future__ import annotations


from conftest import _fresh_client, register_user


def test_session_anonymous(anon_client):
    data = anon_client.get("/api/auth/session").json()
    assert data["authenticated"] is False
    assert data["auth_mode"] == "local"
    assert data["oidc_enabled"] is False
    assert data["user"] is None


def test_register_sets_cookie_and_authenticates(app_module):
    c = register_user(app_module)
    data = c.get("/api/auth/session").json()
    assert data["authenticated"] is True
    assert data["user"]["username"] == c.username


def test_first_user_is_admin_second_is_not(admin, user):
    assert admin.get("/api/auth/session").json()["user"]["is_admin"] is True
    assert user.get("/api/auth/session").json()["user"]["is_admin"] is False


def test_login_with_password(app_module, admin):
    c = _fresh_client(app_module)
    response = c.post(
        "/api/auth/local/login",
        json={"username": admin.username, "password": "test-password"},
    )
    assert response.status_code == 200
    assert c.get("/api/auth/session").json()["authenticated"] is True


def test_login_wrong_password(app_module, admin):
    c = _fresh_client(app_module)
    response = c.post(
        "/api/auth/local/login",
        json={"username": admin.username, "password": "wrong"},
    )
    assert response.status_code == 401


def test_logout_clears_session(app_module):
    c = register_user(app_module)
    assert c.get("/api/auth/session").json()["authenticated"] is True
    c.post("/api/auth/logout")
    assert c.get("/api/auth/session").json()["authenticated"] is False


def test_session_does_not_leak_secrets(anon_client):
    """The session endpoint must never expose stored credentials."""
    data = anon_client.get("/api/auth/session").json()
    blob = str(data)
    assert "db_password" not in blob
    assert "oidc_client_secret" not in blob


def test_forged_raw_integer_cookie_rejected(app_module, admin, anon_client):
    """A bare user-id cookie (the legacy unsigned format) must not authenticate."""
    anon_client.cookies.set(app_module.LOCAL_USER_COOKIE, "1")
    data = anon_client.get("/api/auth/session").json()
    assert data["authenticated"] is False


def test_account_update(app_module):
    c = register_user(app_module)
    response = c.put(
        "/api/auth/account",
        json={
            "display_name": "Renamed",
            "theme_preference": "light",
            "measurement_system": "metric",
            "username": c.username,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["display_name"] == "Renamed"
    assert body["theme_preference"] == "light"
    assert body["measurement_system"] == "metric"


def test_account_update_requires_auth(anon_client):
    response = anon_client.put("/api/auth/account", json={"display_name": "X"})
    assert response.status_code == 401


def test_oidc_login_404_in_local_mode(anon_client):
    assert anon_client.get("/api/auth/login", follow_redirects=False).status_code == 404


def test_tampered_session_cookie_rejected(app_module):
    c = register_user(app_module)
    cookie = c.cookies.get(app_module.LOCAL_USER_COOKIE)
    assert cookie and "." in cookie
    payload_part, signature_part = cookie.split(".", 1)
    forged_payload = payload_part[:-2] + ("AA" if not payload_part.endswith("AA") else "BB")
    c.cookies.set(app_module.LOCAL_USER_COOKIE, f"{forged_payload}.{signature_part}")
    assert c.get("/api/auth/session").json()["authenticated"] is False


def test_legacy_user_endpoints_removed(anon_client):
    assert anon_client.get("/api/users/local").status_code in (404, 405)
    assert anon_client.post("/api/users/local", json={}).status_code in (404, 405)
    assert anon_client.post("/api/users/local/select", json={}).status_code in (404, 405)
