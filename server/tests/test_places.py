"""Place listing, search, and geojson endpoints (seeded from fixture datasets)."""
from __future__ import annotations



def test_places_seeded_from_fixtures(client):
    data = client.get("/api/places", params={"type": "country"}).json()
    names = {item["name"] for item in data["items"]}
    assert {"South Africa", "India", "Australia"} <= names
    assert data["total"] == 3


def test_place_types_all_present(client):
    for place_type in ("country", "state", "city", "airport", "site"):
        data = client.get("/api/places", params={"type": place_type}).json()
        assert data["items"], f"no {place_type} places seeded"


def test_invalid_place_type(client):
    assert client.get("/api/places", params={"type": "moon"}).status_code == 400


def test_search_by_name(client):
    data = client.get("/api/places", params={"type": "country", "query": "India"}).json()
    assert [item["name"] for item in data["items"]] == ["India"]


def test_search_wildcards_not_interpreted(client):
    """A literal % in the query must not act as a match-everything wildcard."""
    data = client.get("/api/places", params={"type": "country", "query": "%"}).json()
    assert data["items"] == []


def test_filter_by_country_code(client):
    data = client.get("/api/places", params={"type": "state", "country_code": "AUS"}).json()
    assert data["items"]
    assert all(item["country_code"] == "AUS" for item in data["items"])


def test_pagination(client):
    page1 = client.get("/api/places", params={"type": "city", "limit": 2, "offset": 0}).json()
    assert len(page1["items"]) == 2
    assert page1["has_more"] is True
    page2 = client.get(
        "/api/places", params={"type": "city", "limit": 2, "offset": page1["next_offset"]}
    ).json()
    ids1 = {item["id"] for item in page1["items"]}
    ids2 = {item["id"] for item in page2["items"]}
    assert not ids1 & ids2


def test_geojson_countries_are_polygons(client):
    data = client.get("/api/places/geojson", params={"type": "country"}).json()
    assert data["type"] == "FeatureCollection"
    assert len(data["features"]) == 3
    assert all(f["geometry"]["type"] in {"Polygon", "MultiPolygon"} for f in data["features"])


def test_geojson_airports_are_points(client):
    data = client.get("/api/places/geojson", params={"type": "airport"}).json()
    assert data["features"]
    assert all(f["geometry"]["type"] == "Point" for f in data["features"])
