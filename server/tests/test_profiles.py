"""Profile CRUD, ownership, and visibility."""

from __future__ import annotations

from conftest import create_profile, register_user


def test_create_and_list_profile(app_module):
    c = register_user(app_module)
    profile = create_profile(c, "My Travels", color="#123abc", home_country_code="ZAF")
    assert profile["name"] == "My Travels"
    assert profile["color"] == "#123abc"
    assert profile["home_country_code"] == "ZAF"
    assert profile["is_public"] is False
    assert profile["is_owned"] is True

    listed = c.get("/api/profiles").json()
    assert any(p["id"] == profile["id"] for p in listed)


def test_create_profile_requires_auth(anon_client):
    response = anon_client.post("/api/profiles", json={"name": "Nope"})
    assert response.status_code == 401


def test_create_profile_requires_name(app_module):
    c = register_user(app_module)
    assert c.post("/api/profiles", json={"name": "  "}).status_code == 400


def test_update_profile(app_module):
    c = register_user(app_module)
    profile = create_profile(c, "Before")
    response = c.put(
        f"/api/profiles/{profile['id']}",
        json={"name": "After", "is_public": True, "home_country_code": "au"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "After"
    assert body["is_public"] is True
    assert body["home_country_code"] == "AU"


def test_cannot_update_others_profile(app_module):
    owner = register_user(app_module)
    intruder = register_user(app_module)
    profile = create_profile(owner, "Private prof")
    response = intruder.put(f"/api/profiles/{profile['id']}", json={"name": "Hacked"})
    assert response.status_code in (403, 404)


def test_public_profile_visible_to_others(app_module):
    owner = register_user(app_module)
    viewer = register_user(app_module)
    profile = create_profile(owner, "Shared prof", is_public=True)
    listed = viewer.get("/api/profiles").json()
    match = [p for p in listed if p["id"] == profile["id"]]
    assert match and match[0]["is_owned"] is False


def test_private_profile_hidden_from_others(app_module):
    owner = register_user(app_module)
    viewer = register_user(app_module)
    profile = create_profile(owner, "Hidden prof")
    listed = viewer.get("/api/profiles").json()
    assert not any(p["id"] == profile["id"] for p in listed)


def test_delete_profile(app_module):
    c = register_user(app_module)
    profile = create_profile(c, "Doomed")
    assert c.delete(f"/api/profiles/{profile['id']}").status_code == 200
    listed = c.get("/api/profiles").json()
    assert not any(p["id"] == profile["id"] for p in listed)
