# World Visited Tracker

A single-container, self-hosted tracker for countries, cities, airports, and heritage sites. It ships with a minimal curated dataset so it runs instantly and is designed so you can drop in full Natural Earth / OurAirports datasets later.

## Quick start (Docker)

```bash
docker compose up --build
```

Open http://localhost:8000

### Data persistence

SQLite is stored in a Docker volume at `/data/app.db`.

## Local development

```bash
cd frontend
npm install
npm run dev
```

In another terminal:

```bash
cd server
pip install -r requirements.txt
DATA_DIR=../data DATA_SOURCES_DIR=../data_sources uvicorn main:app --reload
```

## Data sources

The repo ships with the following datasets:

- `countries.geojson`: Natural Earth world map
- `cities.json`: Global cities with greater than 15,000 population
- `airports.json`: OurAirports list of airports
- `sites.json`: Placeholder for UNESCO world heritage sites

### Replacing with full datasets

1. Download Natural Earth `ne_110m_admin_0_countries.geojson`.
2. Replace `data_sources/countries.geojson`.
3. Replace cities/airports with your own filtered datasets.
4. Delete `/data/app.db` to trigger reseeding.

## API overview

- `GET /api/places?type=country|city|airport|site&query=&limit=&offset=`
- `GET /api/places/geojson?type=`
- `GET /api/profiles`
- `POST /api/profiles`
- `GET /api/visits?profile_id=`
- `POST /api/visits/toggle`
- `GET /api/stats?profile_id=`
- `GET /api/export?profile_id=`
- `POST /api/import?profile_id=`

## Seeding

The database seeds automatically on first start. You can manually reseed with:

```bash
python scripts/seed_db.py
```

# Planned Features
- Flight log tracking
- Michelin Star Restaurants (and potentially similar review bodies for regions that Michellin doesn't cover)
- National / Iconic foods (if I can find a dataset on it) or regional food collections
- Nature achievements (highest mountain, etc.)
- Famous cultural festivals
- Protected Areas, National Parks, Reserves (WDPA database)
- Dark Sky destinations (International Dark Sky Places List)
- OpenStreetMap tags as appropriate
