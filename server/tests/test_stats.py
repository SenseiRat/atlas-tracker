"""Stats endpoint shape and counts."""

from __future__ import annotations

from conftest import create_profile, register_user


def test_stats_shape_and_counts(app_module):
    c = register_user(app_module)
    profile = create_profile(c, "Stats prof")
    for place_id in ("country-ZAF", "country-IND"):
        c.post(
            "/api/visits/toggle",
            json={"profile_id": profile["id"], "place_id": place_id, "visited": True},
        )

    stats = c.get("/api/stats", params={"profile_id": profile["id"]}).json()
    assert stats["countries"]["visited"] == 2
    assert stats["countries"]["total"] == 3
    assert stats["cities"]["visited"] == 0
    achievements = stats.get("achievements")
    assert isinstance(achievements, dict)
    assert isinstance(achievements.get("items"), list)
    assert achievements["earned"] >= 1  # "visit your first country"
    assert isinstance(stats.get("leaderboard"), dict)


def test_stats_anonymous_ok(anon_client):
    stats = anon_client.get("/api/stats").json()
    assert "countries" in stats
    assert stats["countries"]["total"] == 3


def test_stats_private_profile_denied_to_others(app_module):
    owner = register_user(app_module)
    profile = create_profile(owner, "Stats hidden prof")
    intruder = register_user(app_module)
    response = intruder.get("/api/stats", params={"profile_id": profile["id"]})
    assert response.status_code in (403, 404)


def test_public_profiles_in_leaderboard(app_module):
    c = register_user(app_module)
    profile = create_profile(c, "Leader prof", is_public=True)
    c.post(
        "/api/visits/toggle",
        json={"profile_id": profile["id"], "place_id": "country-AUS", "visited": True},
    )
    stats = c.get("/api/stats", params={"profile_id": profile["id"]}).json()
    leaderboard = stats["leaderboard"]
    blob = str(leaderboard)
    assert "Leader prof" in blob
