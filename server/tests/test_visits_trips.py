"""Visit toggling and trip logs."""

from __future__ import annotations

from conftest import create_profile, register_user


def _airport_ids(client) -> list[str]:
    data = client.get("/api/places", params={"type": "airport"}).json()
    return [item["id"] for item in data["items"]]


def test_toggle_visit_on_and_off(app_module):
    c = register_user(app_module)
    profile = create_profile(c, "Visits prof")
    response = c.post(
        "/api/visits/toggle",
        json={"profile_id": profile["id"], "place_id": "country-ZAF", "visited": True},
    )
    assert response.status_code == 200

    visits = c.get("/api/visits", params={"profile_id": profile["id"]}).json()
    assert [v["place_id"] for v in visits] == ["country-ZAF"]

    c.post(
        "/api/visits/toggle",
        json={"profile_id": profile["id"], "place_id": "country-ZAF", "visited": False},
    )
    assert c.get("/api/visits", params={"profile_id": profile["id"]}).json() == []


def test_toggle_visit_is_idempotent(app_module):
    c = register_user(app_module)
    profile = create_profile(c, "Idem prof")
    for _ in range(2):
        response = c.post(
            "/api/visits/toggle",
            json={"profile_id": profile["id"], "place_id": "country-IND", "visited": True},
        )
        assert response.status_code == 200
    visits = c.get("/api/visits", params={"profile_id": profile["id"]}).json()
    assert len(visits) == 1


def test_toggle_visit_invalid_place(app_module):
    c = register_user(app_module)
    profile = create_profile(c, "Bad place prof")
    response = c.post(
        "/api/visits/toggle",
        json={"profile_id": profile["id"], "place_id": "country-XX", "visited": True},
    )
    assert response.status_code == 400


def test_cannot_toggle_on_others_profile(app_module):
    owner = register_user(app_module)
    intruder = register_user(app_module)
    profile = create_profile(owner, "Guarded prof")
    response = intruder.post(
        "/api/visits/toggle",
        json={"profile_id": profile["id"], "place_id": "country-ZAF", "visited": True},
    )
    assert response.status_code in (403, 404)


def test_visits_require_auth_for_private_profile(app_module, anon_client):
    owner = register_user(app_module)
    profile = create_profile(owner, "Anon-hidden prof")
    response = anon_client.get("/api/visits", params={"profile_id": profile["id"]})
    assert response.status_code in (403, 404)


def test_trip_log_lifecycle(app_module):
    c = register_user(app_module)
    profile = create_profile(c, "Trips prof")
    origin, layover, destination = _airport_ids(c)[:3]

    created = c.post(
        "/api/trip-logs",
        json={
            "profile_id": profile["id"],
            "origin_place_id": origin,
            "destination_place_id": destination,
            "layover_place_ids": [layover],
            "flown_on": "2026-01-15",
        },
    )
    assert created.status_code == 200, created.text
    trip = created.json()
    assert trip["origin_place_id"] == origin
    assert trip["destination_place_id"] == destination
    assert trip["layover_place_ids"] == [layover]
    assert trip["flown_on"] == "2026-01-15"
    assert trip["estimated_miles"] > 0
    # enrichment the frontend depends on
    assert trip["route_points"]
    assert trip["segments"]

    listed = c.get("/api/trip-logs", params={"profile_id": profile["id"]}).json()
    assert [t["id"] for t in listed] == [trip["id"]]

    assert c.delete(f"/api/trip-logs/{trip['id']}").status_code == 200
    assert c.get("/api/trip-logs", params={"profile_id": profile["id"]}).json() == []


def test_trip_log_unknown_airport(app_module):
    c = register_user(app_module)
    profile = create_profile(c, "Bad trip prof")
    response = c.post(
        "/api/trip-logs",
        json={
            "profile_id": profile["id"],
            "origin_place_id": "airport-does-not-exist",
            "destination_place_id": "airport-also-missing",
        },
    )
    assert response.status_code in (400, 404)


def test_cannot_delete_others_trip(app_module):
    owner = register_user(app_module)
    intruder = register_user(app_module)
    profile = create_profile(owner, "Trip guard prof")
    origin, _, destination = _airport_ids(owner)[:3]
    trip = owner.post(
        "/api/trip-logs",
        json={
            "profile_id": profile["id"],
            "origin_place_id": origin,
            "destination_place_id": destination,
        },
    ).json()
    assert intruder.delete(f"/api/trip-logs/{trip['id']}").status_code == 404
