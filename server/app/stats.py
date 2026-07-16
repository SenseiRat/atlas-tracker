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
from server.app.db import *  # noqa: F401,F403
from server.app.helpers import *  # noqa: F401,F403

def _active_place_join_sql(place_alias: str = "places", state_alias: str = "pss") -> str:
    return f"LEFT JOIN place_source_state {state_alias} ON {state_alias}.place_id = {place_alias}.id"

def _active_place_filter_sql(state_alias: str = "pss") -> str:
    return f"({state_alias}.place_id IS NULL OR {state_alias}.is_active = ?)"

def count_by_type(conn: DBConnection, place_type: str, visited_ids: List[str], *, active_only: bool = True) -> int:
    if not visited_ids:
        return 0
    placeholders = ",".join("?" for _ in visited_ids)
    query = f"SELECT COUNT(*) as count FROM places WHERE type = ? AND id IN ({placeholders})"
    params: List[Any] = [place_type, *visited_ids]
    if active_only:
        query = (
            "SELECT COUNT(*) as count "
            f"FROM places {_active_place_join_sql()} "
            f"WHERE places.type = ? AND places.id IN ({placeholders}) AND {_active_place_filter_sql()}"
        )
        params.append(True)
    return conn.execute(query, params).fetchone()["count"]

def get_place_by_id(conn: DBConnection, place_id: str) -> Any:
    place = conn.execute(
        "SELECT id, name, lat, lon, country_code FROM places WHERE id = ?",
        (place_id,),
    ).fetchone()
    if not place:
        raise HTTPException(status_code=400, detail=f"Place not found: {place_id}")
    if place["lat"] is None or place["lon"] is None:
        raise HTTPException(status_code=400, detail=f"Place missing coordinates: {place_id}")
    return place

def miles_between_points(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_miles = 3958.8
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius_miles * c

def _parse_layover_place_ids(raw: Any) -> List[str]:
    """Normalize layover ids that may be a list or the DB's JSON-string form."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except json.JSONDecodeError:
            return []
    if not isinstance(raw, list):
        return []
    return [str(item).strip() for item in raw if str(item).strip()]

def build_trip_log_payload(conn: DBConnection, row: Any) -> Dict[str, Any]:
    layover_ids = _parse_layover_place_ids(row["layover_place_ids"])
    route_ids: List[str] = [row["origin_place_id"], *layover_ids, row["destination_place_id"]]
    placeholders = ",".join("?" for _ in route_ids)
    place_rows = conn.execute(
        f"SELECT id, name, lat, lon, country_code FROM places WHERE id IN ({placeholders})",
        route_ids,
    ).fetchall()
    places_by_id = {place["id"]: place for place in place_rows}

    route_points: List[Dict[str, Any]] = []
    for place_id in route_ids:
        place = places_by_id.get(place_id)
        if not place:
            continue
        route_points.append(
            {
                "id": place["id"],
                "name": place["name"],
                "lat": place["lat"],
                "lon": place["lon"],
                "country_code": place["country_code"],
            }
        )

    segments: List[Dict[str, Any]] = []
    for index in range(1, len(route_points)):
        start = route_points[index - 1]
        end = route_points[index]
        segment_miles = miles_between_points(start["lat"], start["lon"], end["lat"], end["lon"])
        segments.append(
            {
                "from_place_id": start["id"],
                "to_place_id": end["id"],
                "from_name": start["name"],
                "to_name": end["name"],
                "miles": round(segment_miles, 1),
            }
        )

    return {
        "id": row["id"],
        "profile_id": row["profile_id"],
        "flown_on": row["flown_on"],
        "origin_place_id": row["origin_place_id"],
        "destination_place_id": row["destination_place_id"],
        "layover_place_ids": layover_ids,
        "estimated_miles": round(float(row["estimated_miles"]), 1),
        "created_at": row["created_at"],
        "route_points": route_points,
        "segments": segments,
    }

def _total_place_counts(conn: DBConnection) -> Dict[str, int]:
    totals: Dict[str, int] = {}
    for place_type in ("country", "state", "city", "airport", "site"):
        totals[place_type] = int(
            conn.execute(
                "SELECT COUNT(*) as count "
                f"FROM places {_active_place_join_sql()} "
                f"WHERE places.type = ? AND {_active_place_filter_sql()}",
                (place_type, True),
            ).fetchone()["count"]
        )
    return totals

def _total_continent_count(conn: DBConnection) -> int:
    continent_rows = conn.execute(
        "SELECT data "
        f"FROM places {_active_place_join_sql()} "
        f"WHERE places.type = 'country' AND {_active_place_filter_sql()}",
        (True,),
    ).fetchall()
    continents: Set[str] = set()
    for row in continent_rows:
        continent = get_continent_from_country_data(row["data"])
        if continent:
            continents.add(continent)
    return len(continents)

def _visited_rows_for_profile(conn: DBConnection, profile_id: Optional[int], user_id: Optional[int]) -> List[Any]:
    if profile_id is None:
        filter_sql, filter_params = _accessible_profile_filter_sql("p", user_id)
        return conn.execute(
            f"""
            SELECT DISTINCT v.place_id
            FROM visits v
            JOIN profiles p ON p.id = v.profile_id
            WHERE {filter_sql}
            """,
            filter_params,
        ).fetchall()
    return conn.execute("SELECT place_id FROM visits WHERE profile_id = ?", (profile_id,)).fetchall()

def _trip_rows_for_profile(conn: DBConnection, profile_id: Optional[int], user_id: Optional[int]) -> List[Any]:
    if profile_id is None:
        filter_sql, filter_params = _accessible_profile_filter_sql("p", user_id)
        return conn.execute(
            f"""
            SELECT t.id, t.estimated_miles, t.layover_place_ids, t.flown_on, t.created_at,
                   t.origin_place_id, t.destination_place_id
            FROM trip_logs t
            JOIN profiles p ON p.id = t.profile_id
            WHERE {filter_sql}
            """,
            filter_params,
        ).fetchall()
    return conn.execute(
        """
        SELECT id, estimated_miles, layover_place_ids, flown_on, created_at, origin_place_id, destination_place_id
        FROM trip_logs
        WHERE profile_id = ?
        """,
        (profile_id,),
    ).fetchall()

def _place_rows_by_ids(conn: DBConnection, place_ids: List[str], *, active_only: bool = False) -> List[Any]:
    if not place_ids:
        return []
    placeholders = ",".join("?" for _ in place_ids)
    query = f"SELECT id, name, type, lat, lon, country_code, data FROM places WHERE id IN ({placeholders})"
    params: List[Any] = list(place_ids)
    if active_only:
        query = (
            "SELECT places.id, places.name, places.type, places.lat, places.lon, places.country_code, places.data "
            f"FROM places {_active_place_join_sql()} "
            f"WHERE places.id IN ({placeholders}) AND {_active_place_filter_sql()}"
        )
        params.append(True)
    return conn.execute(query, params).fetchall()

def _build_achievements(context: Dict[str, Any]) -> Dict[str, Any]:
    site_categories = context["site_categories"]
    heritage_visited = int(site_categories.get("heritage", {}).get("visited", 0))
    achievements = [
        {"id": "first_country", "title": "First Stamp", "description": "Visit your first country.", "category": "coverage", "current": int(context["visited_countries"]), "target": 1, "points": 10},
        {"id": "continent_hopper", "title": "Continent Hopper", "description": "Reach three continents.", "category": "coverage", "current": int(context["visited_continents"]), "target": 3, "points": 18},
        {"id": "global_six", "title": "Global Six", "description": "Visit all six inhabited continents in the dataset.", "category": "coverage", "current": int(context["visited_continents"]), "target": min(6, int(context["total_continents"])), "points": 35},
        {"id": "regional_runner", "title": "Regional Runner", "description": "Log visits to ten states or regions.", "category": "coverage", "current": int(context["visited_states"]), "target": 10, "points": 14},
        {"id": "city_collector", "title": "City Collector", "description": "Visit twenty-five cities.", "category": "coverage", "current": int(context["visited_cities"]), "target": 25, "points": 14},
        {"id": "jetsetter", "title": "Jet Setter", "description": "Check into ten airports.", "category": "travel", "current": int(context["visited_airports"]), "target": 10, "points": 12},
        {"id": "trip_logger", "title": "Trip Logger", "description": "Record ten trip logs.", "category": "travel", "current": int(context["trip_count"]), "target": 10, "points": 12},
        {"id": "marathon_miles", "title": "Marathon Miles", "description": "Accumulate 25,000 estimated flight miles.", "category": "travel", "current": int(round(context["total_estimated_miles"])), "target": 25000, "points": 24},
        {"id": "timezone_tracker", "title": "Timezone Tracker", "description": "Visit twelve time zones.", "category": "travel", "current": int(context["timezones_visited"]), "target": 12, "points": 18},
        {"id": "north_south", "title": "Hemisphere Crosser", "description": "Reach both the northern and southern hemispheres.", "category": "geography", "current": 1 if context["north_south_overlap"] else 0, "target": 1, "points": 16},
        {"id": "east_west", "title": "Meridian Breaker", "description": "Reach both the eastern and western hemispheres.", "category": "geography", "current": 1 if context["east_west_overlap"] else 0, "target": 1, "points": 16},
        {"id": "quadrant_master", "title": "Quadrant Master", "description": "Visit all four world quadrants.", "category": "geography", "current": 1 if context["all_four_quadrants"] else 0, "target": 1, "points": 28},
        {"id": "summit_seeker", "title": "Summit Seeker", "description": "Visit a place at or above 2,500 meters.", "category": "geography", "current": int(round(max(0.0, context["highest_elevation_value"]))), "target": 2500, "points": 18},
        {"id": "heritage_hunter", "title": "Heritage Hunter", "description": "Visit five heritage-category sites.", "category": "lists", "current": heritage_visited, "target": 5, "points": 18},
    ]
    items: List[Dict[str, Any]] = []
    earned_count = 0
    score = 0
    for item in achievements:
        target = max(int(item["target"]), 1)
        current = max(int(item["current"]), 0)
        earned = current >= target
        progress = min(current, target)
        if earned:
            earned_count += 1
            score += int(item["points"])
        items.append({**item, "earned": earned, "progress_current": progress, "progress_target": target, "progress_percent": round((progress / target) * 100, 1), "progress_label": f"{progress:,} / {target:,}"})
    return {"earned": earned_count, "total": len(items), "score": score, "items": items}

def _build_measurements(context: Dict[str, Any]) -> List[Dict[str, Any]]:
    measurements: List[Dict[str, Any]] = []
    if context["highest_elevation"]:
        measurements.append(metric_entry("highest_elevation", "Highest elevation", context["highest_elevation"][0], round(context["highest_elevation"][1], 1), f"{round(context['highest_elevation'][1]):,} m"))
    if context["lowest_elevation"]:
        measurements.append(metric_entry("lowest_elevation", "Lowest elevation", context["lowest_elevation"][0], round(context["lowest_elevation"][1], 1), f"{round(context['lowest_elevation'][1]):,} m"))
    if context["largest_city"]:
        measurements.append(metric_entry("largest_city", "Largest city visited", context["largest_city"][0], int(context["largest_city"][1]), f"{int(context['largest_city'][1]):,} people"))
    if context["largest_country"]:
        measurements.append(metric_entry("largest_country", "Most populous country visited", context["largest_country"][0], int(context["largest_country"][1]), f"{int(context['largest_country'][1]):,} people", detail=context["largest_country"][2]))
    if context["largest_state"]:
        measurements.append(metric_entry("largest_state", "Largest region visited", context["largest_state"][0], round(context["largest_state"][1], 1), f"{round(context['largest_state'][1]):,} sq km"))
    if context["highest_airport"]:
        measurements.append(metric_entry("highest_airport", "Highest airport visited", context["highest_airport"][0], round(context["highest_airport"][1], 1), f"{round(context['highest_airport'][1]):,} m"))
    if context["longest_trip"]:
        measurements.append(metric_entry("longest_trip", "Longest trip logged", context["longest_trip"][0], round(context["longest_trip"][1], 1), f"{round(context['longest_trip'][1]):,} mi", detail=context["longest_trip"][2]))
    if context["most_connected_airport"]:
        measurements.append(metric_entry("most_connected_airport", "Most used airport", context["most_connected_airport"][0], int(context["most_connected_airport"][1]), f"{int(context['most_connected_airport'][1]):,} trip touches"))
    return measurements

def _all_site_rows(conn: DBConnection) -> List[Any]:
    return conn.execute(
        "SELECT places.id, places.data "
        f"FROM places {_active_place_join_sql()} "
        f"WHERE places.type = 'site' AND {_active_place_filter_sql()}",
        (True,),
    ).fetchall()

def _compute_profile_stats(
    conn: DBConnection,
    *,
    profile_id: Optional[int],
    user_id: Optional[int],
    total_counts: Dict[str, int],
    total_continents: int,
    site_rows: Optional[List[Any]] = None,
) -> Dict[str, Any]:
    visited_rows = _visited_rows_for_profile(conn, profile_id, user_id)
    visited_ids = [str(row["place_id"]) for row in visited_rows]
    trip_log_rows = _trip_rows_for_profile(conn, profile_id, user_id)
    visited_place_rows = _place_rows_by_ids(conn, visited_ids, active_only=True)
    if site_rows is None:
        site_rows = _all_site_rows(conn)

    trip_place_ids: List[str] = []
    total_estimated_miles = 0.0
    total_legs = 0
    repeated_airport_counts: Dict[str, int] = {}
    trip_dates: Set[str] = set()
    for row in trip_log_rows:
        total_estimated_miles += float(row["estimated_miles"] or 0.0)
        date_value = str(row["flown_on"] or row["created_at"] or "")[:10]
        if date_value:
            trip_dates.add(date_value)
        layover_ids = _parse_layover_place_ids(row["layover_place_ids"])
        total_legs += max(0, len(layover_ids) + 1)
        route_ids = [str(row["origin_place_id"]), *layover_ids, str(row["destination_place_id"])]
        trip_place_ids.extend(route_ids)
        for airport_id in route_ids:
            if airport_id.startswith("airport-"):
                repeated_airport_counts[airport_id] = repeated_airport_counts.get(airport_id, 0) + 1

    trip_place_rows = _place_rows_by_ids(conn, sorted(set(trip_place_ids)))
    trip_place_names = {str(row["id"]): str(row["name"]) for row in trip_place_rows}

    hemisphere_counts = {"north": 0, "south": 0, "east": 0, "west": 0}
    hemisphere_quadrants = {"ne": 0, "nw": 0, "se": 0, "sw": 0}
    farthest_north: Optional[Tuple[str, float]] = None
    farthest_south: Optional[Tuple[str, float]] = None
    easternmost: Optional[Tuple[str, float]] = None
    westernmost: Optional[Tuple[str, float]] = None
    highest_elevation: Optional[Tuple[str, float]] = None
    lowest_elevation: Optional[Tuple[str, float]] = None
    largest_city: Optional[Tuple[str, int]] = None
    largest_country: Optional[Tuple[str, int, str]] = None
    largest_state: Optional[Tuple[str, float]] = None
    highest_airport: Optional[Tuple[str, float]] = None
    timezone_set: Set[str] = set()
    currency_set: Set[str] = set()
    visited_continents_set: Set[str] = set()

    for row in visited_place_rows:
        lat = as_float(row["lat"])
        lon = as_float(row["lon"])
        place_name = str(row["name"] or row["id"])
        data = parse_json_object(row["data"])
        lat_side: Optional[str] = None
        lon_side: Optional[str] = None
        if lat is not None:
            if lat >= 0:
                hemisphere_counts["north"] += 1
                lat_side = "n"
            else:
                hemisphere_counts["south"] += 1
                lat_side = "s"
            if farthest_north is None or lat > farthest_north[1]:
                farthest_north = (place_name, lat)
            if farthest_south is None or lat < farthest_south[1]:
                farthest_south = (place_name, lat)
        if lon is not None:
            if lon >= 0:
                hemisphere_counts["east"] += 1
                lon_side = "e"
            else:
                hemisphere_counts["west"] += 1
                lon_side = "w"
            if easternmost is None or lon > easternmost[1]:
                easternmost = (place_name, lon)
            if westernmost is None or lon < westernmost[1]:
                westernmost = (place_name, lon)
        if lat_side and lon_side:
            hemisphere_quadrants[f"{lat_side}{lon_side}"] = hemisphere_quadrants.get(f"{lat_side}{lon_side}", 0) + 1

        timezone = extract_timezone(data)
        if timezone:
            timezone_set.add(timezone)

        elevation_m = extract_elevation_meters(data)
        if elevation_m is not None:
            if highest_elevation is None or elevation_m > highest_elevation[1]:
                highest_elevation = (place_name, elevation_m)
            if lowest_elevation is None or elevation_m < lowest_elevation[1]:
                lowest_elevation = (place_name, elevation_m)

        if row["type"] == "country":
            continent = get_continent_from_country_data(row["data"])
            if continent:
                visited_continents_set.add(continent)
            currency_code = extract_country_currency(data)
            if currency_code:
                currency_set.add(currency_code)
            population = extract_population(data)
            economy = extract_country_economy(data) or "Country"
            if population is not None and (largest_country is None or population > largest_country[1]):
                largest_country = (place_name, population, economy)
        elif row["type"] == "city":
            population = extract_population(data)
            if population is not None and (largest_city is None or population > largest_city[1]):
                largest_city = (place_name, population)
        elif row["type"] == "state":
            area_sqkm = extract_area_sqkm(data)
            if area_sqkm is not None and (largest_state is None or area_sqkm > largest_state[1]):
                largest_state = (place_name, area_sqkm)
        elif row["type"] == "airport" and elevation_m is not None:
            if highest_airport is None or elevation_m > highest_airport[1]:
                highest_airport = (place_name, elevation_m)

    longest_streak = 0
    current_streak = 0
    previous_day: Optional[datetime] = None
    for date_text in sorted(trip_dates):
        try:
            current_day = datetime.strptime(date_text, "%Y-%m-%d")
        except ValueError:
            continue
        if previous_day and (current_day - previous_day).days == 1:
            current_streak += 1
        else:
            current_streak = 1
        longest_streak = max(longest_streak, current_streak)
        previous_day = current_day

    site_category_totals: Dict[str, int] = {}
    site_category_visited: Dict[str, int] = {}
    for row in site_rows:
        payload = parse_json_object(row["data"])
        category = str(payload.get("category") or "heritage").strip().lower()
        site_category_totals[category] = site_category_totals.get(category, 0) + 1
        if row["id"] in visited_ids:
            site_category_visited[category] = site_category_visited.get(category, 0) + 1
    site_categories = {
        category: {"visited": site_category_visited.get(category, 0), "total": total}
        for category, total in sorted(site_category_totals.items())
    }

    longest_trip: Optional[Tuple[str, float, str]] = None
    for row in trip_log_rows:
        distance = float(row["estimated_miles"] or 0.0)
        if longest_trip is not None and distance <= longest_trip[1]:
            continue
        origin_name = trip_place_names.get(str(row["origin_place_id"]), str(row["origin_place_id"]))
        destination_name = trip_place_names.get(str(row["destination_place_id"]), str(row["destination_place_id"]))
        route_label = f"{origin_name} -> {destination_name}"
        date_label = str(row["flown_on"] or row["created_at"] or "")[:10]
        longest_trip = (route_label, distance, date_label or "Date unavailable")

    most_connected_airport: Optional[Tuple[str, int]] = None
    for airport_id, count in repeated_airport_counts.items():
        airport_name = trip_place_names.get(airport_id, airport_id)
        if most_connected_airport is None or count > most_connected_airport[1]:
            most_connected_airport = (airport_name, count)

    visited_countries = count_by_type(conn, "country", visited_ids)
    visited_states = count_by_type(conn, "state", visited_ids)
    visited_cities = count_by_type(conn, "city", visited_ids)
    visited_airports = count_by_type(conn, "airport", visited_ids)
    visited_sites = count_by_type(conn, "site", visited_ids)
    world_percent = (visited_countries / total_counts["country"] * 100) if total_counts["country"] else 0

    context = {
        "visited_countries": visited_countries,
        "visited_states": visited_states,
        "visited_cities": visited_cities,
        "visited_airports": visited_airports,
        "visited_sites": visited_sites,
        "visited_continents": len(visited_continents_set),
        "total_continents": total_continents,
        "trip_count": len(trip_log_rows),
        "total_estimated_miles": total_estimated_miles,
        "timezones_visited": len(timezone_set),
        "site_categories": site_categories,
        "north_south_overlap": hemisphere_counts["north"] > 0 and hemisphere_counts["south"] > 0,
        "east_west_overlap": hemisphere_counts["east"] > 0 and hemisphere_counts["west"] > 0,
        "all_four_quadrants": all(count > 0 for count in hemisphere_quadrants.values()),
        "highest_elevation_value": highest_elevation[1] if highest_elevation else 0.0,
        "highest_elevation": highest_elevation,
        "lowest_elevation": lowest_elevation,
        "largest_city": largest_city,
        "largest_country": largest_country,
        "largest_state": largest_state,
        "highest_airport": highest_airport,
        "longest_trip": longest_trip,
        "most_connected_airport": most_connected_airport,
    }
    achievements = _build_achievements(context)
    measurements = _build_measurements(context)
    overall_score = round(
        visited_countries * 12
        + len(visited_continents_set) * 28
        + visited_states * 2
        + visited_cities * 0.5
        + visited_airports * 1.5
        + visited_sites * 3
        + len(trip_log_rows) * 4
        + (total_estimated_miles / 400)
        + len(timezone_set) * 5
        + achievements["score"] * 1.75,
        1,
    )

    return {
        "continents": {"visited": len(visited_continents_set), "total": total_continents},
        "countries": {"visited": visited_countries, "total": total_counts["country"], "percent": round(world_percent, 1)},
        "states": {"visited": visited_states, "total": total_counts["state"]},
        "cities": {"visited": visited_cities, "total": total_counts["city"]},
        "airports": {"visited": visited_airports, "total": total_counts["airport"]},
        "sites": {"visited": visited_sites, "total": total_counts["site"]},
        "trip_logs": {
            "count": len(trip_log_rows),
            "flight_legs": total_legs,
            "estimated_miles": round(total_estimated_miles, 1),
            "average_miles_per_trip": round(total_estimated_miles / len(trip_log_rows), 1) if trip_log_rows else 0.0,
        },
        "site_categories": site_categories,
        "hemispheres": {
            **hemisphere_counts,
            "quadrants": hemisphere_quadrants,
            "overlap": {
                "north_south": hemisphere_counts["north"] > 0 and hemisphere_counts["south"] > 0,
                "east_west": hemisphere_counts["east"] > 0 and hemisphere_counts["west"] > 0,
                "all_four_quadrants": all(count > 0 for count in hemisphere_quadrants.values()),
            },
        },
        "geo_extremes": {
            "farthest_north": {"name": farthest_north[0], "lat": round(farthest_north[1], 4)} if farthest_north else None,
            "farthest_south": {"name": farthest_south[0], "lat": round(farthest_south[1], 4)} if farthest_south else None,
            "easternmost": {"name": easternmost[0], "lon": round(easternmost[1], 4)} if easternmost else None,
            "westernmost": {"name": westernmost[0], "lon": round(westernmost[1], 4)} if westernmost else None,
            "highest_elevation": {"name": highest_elevation[0], "elevation_m": round(highest_elevation[1], 1)} if highest_elevation else None,
            "lowest_elevation": {"name": lowest_elevation[0], "elevation_m": round(lowest_elevation[1], 1)} if lowest_elevation else None,
        },
        "travel": {
            "distance_miles": round(total_estimated_miles, 1),
            "distance_km": round(total_estimated_miles * 1.60934, 1),
            "timezones_visited": len(timezone_set),
            "currencies_used": len(currency_set),
            "longest_trip_streak_days": longest_streak,
            "repeated_airports": sum(1 for count in repeated_airport_counts.values() if count > 1),
        },
        "measurements": measurements,
        "achievements": achievements,
        "scorecard": {"overall_score": overall_score, "achievement_score": achievements["score"]},
    }

def _apply_rarity_to_achievements(achievements: Dict[str, Any], public_snapshots: List[Dict[str, Any]]) -> Dict[str, Any]:
    total_public = len(public_snapshots)
    earned_counts: Dict[str, int] = {}
    for snapshot in public_snapshots:
        for item in snapshot["stats"]["achievements"]["items"]:
            if item["earned"]:
                earned_counts[item["id"]] = earned_counts.get(item["id"], 0) + 1
    return {
        **achievements,
        "items": [
            {
                **item,
                "earned_by_public_profiles": earned_counts.get(item["id"], 0),
                "rarity_percent": round((earned_counts.get(item["id"], 0) / total_public) * 100, 1) if total_public else 0.0,
            }
            for item in achievements["items"]
        ],
    }

def _build_leaderboard(
    selected_stats: Dict[str, Any],
    selected_profile_id: Optional[int],
    selected_profile_public: bool,
    public_snapshots: List[Dict[str, Any]],
) -> Dict[str, Any]:
    def rank_entries(metric_key: str, label: str) -> Dict[str, Any]:
        sorted_entries = sorted(public_snapshots, key=lambda item: (-float(item["metrics"][metric_key]), str(item["name"]).lower(), int(item["id"])))
        return {
            "id": metric_key,
            "label": label,
            "leaders": [
                {"profile_id": int(item["id"]), "name": item["name"], "color": item["color"], "value": item["metrics"][metric_key]}
                for item in sorted_entries[:5]
            ],
        }

    for snapshot in public_snapshots:
        snapshot["metrics"] = {
            "overall_score": float(snapshot["stats"]["scorecard"]["overall_score"]),
            "countries": int(snapshot["stats"]["countries"]["visited"]),
            "continents": int(snapshot["stats"]["continents"]["visited"]),
            "miles": float(snapshot["stats"]["trip_logs"]["estimated_miles"]),
            "achievements": int(snapshot["stats"]["achievements"]["earned"]),
        }

    sorted_overall = sorted(public_snapshots, key=lambda item: (-float(item["metrics"]["overall_score"]), str(item["name"]).lower(), int(item["id"])))
    top_overall = [
        {
            "profile_id": int(item["id"]),
            "name": item["name"],
            "color": item["color"],
            "overall_score": item["metrics"]["overall_score"],
            "countries": item["metrics"]["countries"],
            "continents": item["metrics"]["continents"],
            "miles": item["metrics"]["miles"],
            "achievements": item["metrics"]["achievements"],
        }
        for item in sorted_overall[:10]
    ]

    selected_summary: Optional[Dict[str, Any]] = None
    if selected_profile_id is not None:
        metric_ranks: Dict[str, Optional[int]] = {}
        leading_categories: List[str] = []
        for metric_key in ("overall_score", "countries", "continents", "miles", "achievements"):
            metric_sorted = sorted(public_snapshots, key=lambda item: (-float(item["metrics"][metric_key]), str(item["name"]).lower(), int(item["id"])))
            rank = next((index + 1 for index, item in enumerate(metric_sorted) if int(item["id"]) == selected_profile_id), None)
            metric_ranks[metric_key] = rank
            if rank == 1:
                leading_categories.append(metric_key)
        selected_summary = {
            "eligible": selected_profile_public,
            "profile_id": selected_profile_id,
            "overall_rank": metric_ranks["overall_score"],
            "country_rank": metric_ranks["countries"],
            "continent_rank": metric_ranks["continents"],
            "miles_rank": metric_ranks["miles"],
            "achievement_rank": metric_ranks["achievements"],
            "leader_categories": leading_categories,
            "overall_score": selected_stats["scorecard"]["overall_score"],
        }

    return {
        "public_profile_count": len(public_snapshots),
        "current_profile": selected_summary,
        "top_overall": top_overall,
        "categories": [
            rank_entries("countries", "Countries visited"),
            rank_entries("continents", "Continents visited"),
            rank_entries("miles", "Flight miles"),
            rank_entries("achievements", "Achievements earned"),
        ],
    }

def _serialize_place_item(row: Any, place_type: str) -> Optional[Dict[str, Any]]:
    item = dict(row)
    try:
        data = json.loads(item.get("data") or "{}")
    except json.JSONDecodeError:
        data = {}
    if place_type == "airport" and is_duplicate_airport_record(data):
        return None

    state_code = extract_state_code(data)
    municipality = str(data.get("municipality") or data.get("city") or "").strip() or None
    country_text = str(item.get("country_code") or "").strip()
    location_parts = [part for part in [municipality, state_code, country_text] if part]
    country_codes = data.get("country_codes")
    alternate_names = [str(value).strip() for value in (data.get("alternateNames") or []) if str(value).strip()]
    tags = [str(value).strip() for value in (data.get("tags") or []) if str(value).strip()]
    country_or_countries = [
        str(value).strip() for value in (data.get("countryOrCountries") or []) if str(value).strip()
    ]

    item["state_code"] = state_code
    item["category"] = str(data.get("category") or "").strip() or None
    item["type"] = str(data.get("type") or "").strip() or None
    item["airport_code"] = extract_airport_code(data)
    item["airport_type"] = str(data.get("type") or "").strip().lower() or None
    item["municipality"] = municipality
    item["location"] = ", ".join(location_parts)
    item["search_location"] = " ".join(location_parts).lower()
    item["timezone"] = extract_timezone(data)
    item["elevation_m"] = extract_elevation_meters(data)
    item["feature_code"] = str(data.get("feature_code") or "").strip() or None
    item["feature_class"] = str(data.get("feature_class") or "").strip() or None
    item["population"] = extract_population(data)
    item["area_sqkm"] = extract_area_sqkm(data)
    item["continent"] = extract_continent_name(data) if place_type == "country" else None
    item["country_codes"] = [str(code).strip().upper() for code in country_codes if str(code).strip()] if isinstance(country_codes, list) else None
    item["source"] = str(data.get("source") or data.get("source_dataset") or "").strip() or None
    item["sourceType"] = str(data.get("sourceType") or "").strip() or None
    item["alternateNames"] = alternate_names
    item["countryOrCountries"] = country_or_countries
    item["region"] = str(data.get("region") or "").strip() or None
    item["cityOrLocality"] = str(data.get("cityOrLocality") or "").strip() or municipality
    item["latitude"] = as_float(data.get("latitude", item.get("lat")))
    item["longitude"] = as_float(data.get("longitude", item.get("lon")))
    item["summary"] = str(data.get("summary") or data.get("short_description") or "").strip() or None
    item["tags"] = tags
    item["metadata"] = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}

    if place_type == "state" and not str(item.get("name") or "").strip():
        fallback_code = state_code or str(item.get("id") or "").split("-")[-1].upper()
        item["name"] = fallback_code or "Unknown"

    item.pop("data", None)
    return item


__all__ = [
    '_active_place_join_sql',
    '_active_place_filter_sql',
    'count_by_type',
    'get_place_by_id',
    'miles_between_points',
    '_parse_layover_place_ids',
    'build_trip_log_payload',
    '_total_place_counts',
    '_total_continent_count',
    '_visited_rows_for_profile',
    '_trip_rows_for_profile',
    '_place_rows_by_ids',
    '_build_achievements',
    '_build_measurements',
    '_all_site_rows',
    '_compute_profile_stats',
    '_apply_rarity_to_achievements',
    '_build_leaderboard',
    '_serialize_place_item',
]
