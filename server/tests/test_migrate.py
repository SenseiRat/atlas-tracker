"""Database backend migration (sqlite -> sqlite copy)."""

from __future__ import annotations

import sqlite3


from conftest import create_profile, register_user


def _run_migration(app_module, admin, tmp_path):
    target_db = tmp_path / "migrated.db"
    response = admin.post(
        "/api/admin/settings/migrate",
        json={"preferred_db_backend": "sqlite", "sqlite_db_path": str(target_db)},
    )
    assert response.status_code == 200, response.text
    # migration persists target settings in app_settings; restore defaults so
    # later tests see a clean slate
    admin.put("/api/admin/settings", json={"sqlite_db_path": ""})
    return response.json(), target_db


def test_migration_copies_core_tables(app_module, admin, tmp_path):
    c = register_user(app_module)
    profile = create_profile(c, "Migrate prof", home_country_code="IND")
    c.post(
        "/api/visits/toggle",
        json={"profile_id": profile["id"], "place_id": "country-IND", "visited": True},
    )

    body, target_db = _run_migration(app_module, admin, tmp_path)
    assert body["migration_summary"]["target_backend"] == "sqlite"
    assert body["migration_summary"]["profiles"] >= 1
    assert body["migration_summary"]["places"] > 0

    conn = sqlite3.connect(target_db)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT name, home_country_code FROM profiles WHERE id = ?", (profile["id"],)
    ).fetchone()
    visits = conn.execute(
        "SELECT place_id FROM visits WHERE profile_id = ?", (profile["id"],)
    ).fetchall()
    conn.close()

    assert row is not None
    assert row["name"] == "Migrate prof"
    assert [v["place_id"] for v in visits] == ["country-IND"]


def test_migration_preserves_home_country_code(app_module, admin, tmp_path):
    c = register_user(app_module)
    profile = create_profile(c, "Home cc prof", home_country_code="ZAF")

    _, target_db = _run_migration(app_module, admin, tmp_path)

    conn = sqlite3.connect(target_db)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT home_country_code FROM profiles WHERE id = ?", (profile["id"],)
    ).fetchone()
    conn.close()
    assert row["home_country_code"] == "ZAF"


def test_migration_to_same_database_rejected(admin, app_module):
    response = admin.post(
        "/api/admin/settings/migrate",
        json={"preferred_db_backend": "sqlite", "sqlite_db_path": str(app_module.DB_PATH)},
    )
    assert response.status_code == 400
