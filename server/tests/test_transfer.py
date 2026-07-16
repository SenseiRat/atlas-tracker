"""Export / import round trip."""
from __future__ import annotations

import itertools
import json


from conftest import create_profile, register_user

_seq = itertools.count(1)


def _airport_ids(client) -> list[str]:
    data = client.get("/api/places", params={"type": "airport"}).json()
    return [item["id"] for item in data["items"]]


def _setup_profile_with_data(app_module):
    c = register_user(app_module)
    profile = create_profile(c, f"Transfer prof {next(_seq)}")
    for place_id in ("country-ZAF", "country-AUS"):
        c.post(
            "/api/visits/toggle",
            json={"profile_id": profile["id"], "place_id": place_id, "visited": True},
        )
    origin, layover, destination = _airport_ids(c)[:3]
    c.post(
        "/api/trip-logs",
        json={
            "profile_id": profile["id"],
            "origin_place_id": origin,
            "destination_place_id": destination,
            "layover_place_ids": [layover],
            "flown_on": "2025-06-01",
        },
    )
    return c, profile


def test_export_import_round_trip(app_module):
    c, profile = _setup_profile_with_data(app_module)

    exported = c.get("/api/export", params={"profile_id": profile["id"]})
    assert exported.status_code == 200
    payload = exported.json()
    assert len(payload["visits"]) == 2
    assert len(payload["trip_logs"]) == 1

    # wipe by importing an empty payload, then restore from the export
    empty = json.dumps({"visits": [], "trip_logs": []}).encode()
    wiped = c.post(
        "/api/import",
        params={"profile_id": profile["id"]},
        files={"file": ("empty.json", empty, "application/json")},
    )
    assert wiped.status_code == 200
    assert c.get("/api/visits", params={"profile_id": profile["id"]}).json() == []

    restored = c.post(
        "/api/import",
        params={"profile_id": profile["id"]},
        files={"file": ("backup.json", json.dumps(payload).encode(), "application/json")},
    )
    assert restored.status_code == 200
    body = restored.json()
    assert body["imported_visits"] == 2
    assert body["imported_trip_logs"] == 1

    visits = c.get("/api/visits", params={"profile_id": profile["id"]}).json()
    assert {v["place_id"] for v in visits} == {"country-ZAF", "country-AUS"}
    trips = c.get("/api/trip-logs", params={"profile_id": profile["id"]}).json()
    assert len(trips) == 1
    assert trips[0]["flown_on"] == "2025-06-01"


def test_import_rejects_invalid_json(app_module):
    c, profile = _setup_profile_with_data(app_module)
    response = c.post(
        "/api/import",
        params={"profile_id": profile["id"]},
        files={"file": ("bad.json", b"not json", "application/json")},
    )
    assert response.status_code == 400


def test_import_rejects_unknown_place_ids(app_module):
    c, profile = _setup_profile_with_data(app_module)
    bad = json.dumps({"visits": [{"place_id": "country-XX"}], "trip_logs": []}).encode()
    response = c.post(
        "/api/import",
        params={"profile_id": profile["id"]},
        files={"file": ("bad.json", bad, "application/json")},
    )
    assert response.status_code == 400
    # original data must survive a failed import
    visits = c.get("/api/visits", params={"profile_id": profile["id"]}).json()
    assert len(visits) == 2


def test_export_requires_ownership(app_module):
    c, profile = _setup_profile_with_data(app_module)
    intruder = register_user(app_module)
    response = intruder.get("/api/export", params={"profile_id": profile["id"]})
    assert response.status_code in (401, 403, 404)
