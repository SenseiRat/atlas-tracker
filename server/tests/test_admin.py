"""Admin endpoints: users, profiles, settings."""
from __future__ import annotations


from conftest import create_profile, register_user


def test_admin_endpoints_require_admin(user):
    assert user.get("/api/admin/users").status_code == 403
    assert user.get("/api/admin/profiles").status_code == 403
    assert user.get("/api/admin/settings").status_code == 403


def test_admin_endpoints_require_auth(anon_client):
    assert anon_client.get("/api/admin/users").status_code == 401
    assert anon_client.get("/api/admin/settings").status_code == 401


def test_admin_lists_users(admin, user):
    users = admin.get("/api/admin/users").json()
    usernames = {u["username"] for u in users}
    assert {admin.username, user.username} <= usernames


def test_admin_create_and_delete_user(admin):
    created = admin.post(
        "/api/admin/users",
        json={"username": "adminmade", "display_name": "Admin Made", "password": "pw123456"},
    ).json()
    assert created["role"] == "user"
    assert admin.delete(f"/api/admin/users/{created['id']}").status_code == 200


def test_admin_cannot_delete_self(admin):
    response = admin.delete(f"/api/admin/users/{admin.user_id}")
    assert response.status_code == 400


def test_admin_cannot_demote_self(admin):
    response = admin.put(
        f"/api/admin/users/{admin.user_id}",
        json={"role": "user", "display_name": "Admin"},
    )
    assert response.status_code == 400


def test_admin_password_reset(app_module, admin):
    from conftest import _fresh_client

    target = register_user(app_module)
    response = admin.post(
        f"/api/admin/users/{target.user_id}/password", json={"password": "new-pass"}
    )
    assert response.status_code == 200
    c = _fresh_client(app_module)
    assert (
        c.post(
            "/api/auth/local/login",
            json={"username": target.username, "password": "new-pass"},
        ).status_code
        == 200
    )


def test_admin_profiles_list_includes_owner_label(admin, app_module):
    someone = register_user(app_module, display_name="Owner Label Test")
    create_profile(someone, "Labelled prof")
    profiles = admin.get("/api/admin/profiles").json()
    match = [p for p in profiles if p["name"] == "Labelled prof"]
    assert match and match[0]["owner_label"] == "Owner Label Test"


def test_admin_settings_roundtrip(admin):
    settings = admin.get("/api/admin/settings").json()
    assert settings["configured_db_backend"] == "sqlite"

    updated = admin.put("/api/admin/settings", json={"db_host": "db.example.test"}).json()
    assert updated["db_host"] == "db.example.test"
    assert updated["restart_required"] is True
    # restore
    admin.put("/api/admin/settings", json={"db_host": ""})


def test_admin_settings_rejects_bad_backend(admin):
    response = admin.put("/api/admin/settings", json={"preferred_db_backend": "oracle"})
    assert response.status_code == 400


def test_admin_settings_do_not_echo_secrets(admin, app_module):
    updated = admin.put("/api/admin/settings", json={"db_password": "super-secret-pw"}).json()
    assert updated["db_password"] == app_module.SECRET_PLACEHOLDER
    settings = admin.get("/api/admin/settings").json()
    assert settings["db_password"] == app_module.SECRET_PLACEHOLDER
    # cleanup so later tests aren't affected
    admin.put("/api/admin/settings", json={"db_password": ""})


def test_admin_settings_placeholder_preserves_secret(admin, app_module):
    admin.put("/api/admin/settings", json={"oidc_client_secret": "keep-me"})
    # saving the masked form back must not overwrite the stored secret
    admin.put("/api/admin/settings", json={"oidc_client_secret": app_module.SECRET_PLACEHOLDER})

    with app_module.get_db() as conn:
        stored = app_module._get_app_settings(conn)
    assert stored["oidc_client_secret"] == "keep-me"

    # an explicit empty value clears it
    admin.put("/api/admin/settings", json={"oidc_client_secret": ""})
    with app_module.get_db() as conn:
        stored = app_module._get_app_settings(conn)
    assert stored["oidc_client_secret"] == ""
