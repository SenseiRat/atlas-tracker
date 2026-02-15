# World Visited Tracker

A single-container, self-hosted tracker for countries, cities, airports, and heritage sites. It ships with a minimal curated dataset so it runs instantly and is designed so you can drop in full Natural Earth / OurAirports datasets later.

## Quick start (Docker)

```bash
docker compose up --build
```

The container listens on port `8000` internally and is published as `8080` on the host.

Open http://localhost:8080

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

## Troubleshooting dependency install (npm/pip)

If `npm install` or `pip install` fails with `403`/proxy errors, your environment is blocking outbound registry access.

- This repo includes a root `.npmrc` pinned to `https://registry.npmjs.org/`.
- Unset forced proxy variables before retrying:

```bash
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
cd frontend && npm install
pip install -r server/requirements.txt
```

- If you are on a corporate network, set those variables to your approved proxy instead.

## Data sources

The repo ships with a **small curated starter dataset** in `data_sources/` so the app runs immediately.

- `countries.geojson`: simplified placeholder polygons.
- `cities.json`: curated major cities.
- `airports.json`: curated major airports.
- `sites.json`: curated UNESCO-style landmarks.

### Replacing with full datasets

1. Download Natural Earth `ne_110m_admin_0_countries.geojson`.
2. Replace `data_sources/countries.geojson`.
3. Replace cities/airports with your own filtered datasets.
4. Delete `/data/app.db` to trigger reseeding.

## Profiles

- First run prompts for the first profile name from the web UI (no seeded defaults).
- Supports Add / Edit / Delete profile actions.
- Includes an **All Profiles** mode with per-profile map colors and legend.

## API overview

- `GET /api/places?type=country|city|airport|site&query=&limit=&offset=`
- `GET /api/places/geojson?type=`
- `GET /api/profiles`
- `POST /api/profiles`
- `PUT /api/profiles/{profile_id}`
- `DELETE /api/profiles/{profile_id}`
- `GET /api/visits` (all profiles) or `GET /api/visits?profile_id=`
- `POST /api/visits/toggle`
- `GET /api/stats` (all profiles aggregate) or `GET /api/stats?profile_id=`
- `GET /api/export?profile_id=`
- `POST /api/import?profile_id=`

## Seeding

The database seeds automatically on first start. You can manually reseed with:

```bash
python scripts/seed_db.py
```
