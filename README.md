# World Visited Tracker

A single-container, self-hosted tracker for countries, cities, airports, and heritage sites. It ships with a minimal curated dataset so it runs instantly and is designed so you can drop in full Natural Earth / OurAirports datasets later.

## Quick start (Docker)

```bash
docker compose up --build
```

The container listens on port `8000` internally and is published as `8000` on the host.

Open http://localhost:8000

### Data persistence

SQLite is stored in a Docker volume at `/data/app.db`.

### Optional Postgres backend

SQLite is still the default. To use Postgres instead, set `DB_HOST`, `DB_PORT`, and `DB_NAME`:

```bash
DB_HOST=localhost DB_PORT=5432 DB_NAME=places_been docker compose up --build
```

When `DB_HOST` and `DB_NAME` are set, the API uses Postgres automatically (`DB_BACKEND=auto`).

## Runtime environment variables

You can configure the container with these environment variables:

- `DB_BACKEND`: `auto` (default), `sqlite`, or `postgres`
- `DB_HOST`: Postgres host (required when `DB_BACKEND=postgres`)
- `DB_PORT`: Postgres port (default `5432`)
- `DB_NAME`: Postgres database name (required when `DB_BACKEND=postgres`)
- `DB_USER`: Postgres user (default `postgres`)
- `DB_PASSWORD`: Postgres password (optional)
- `DB_SSLMODE`: Postgres sslmode (default `prefer`)
- `DATA_DIR`: SQLite data directory (default `/data`)
- `SQLITE_DB_PATH`: absolute SQLite file path override (optional)
- `SQLITE_BUSY_TIMEOUT_MS`: SQLite lock wait timeout in milliseconds (default `5000`)
- `SQLITE_ENABLE_WAL`: SQLite WAL mode (`1`/`0`, default `1`)
- `IMPORT_MAX_BYTES`: max JSON import size in bytes (default `10485760`)
- `OIDC_ISSUER`: OIDC issuer URL (enables authentication when set with `OIDC_CLIENT_ID`)
- `OIDC_CLIENT_ID`: OIDC client ID
- `OIDC_CLIENT_SECRET`: OIDC client secret (optional for public clients)
- `OIDC_SCOPES`: authorization scopes (default `openid profile email`)
- `OIDC_REDIRECT_PATH`: callback path or full callback URL (default `/api/auth/callback`)
- `OIDC_SESSION_SECRET`: required HMAC secret for signed auth cookies when OIDC is enabled
- `OIDC_SESSION_COOKIE`: signed session cookie name (default `world_tracker_session`)
- `OIDC_LOGIN_COOKIE`: temporary login state cookie name (default `world_tracker_login`)
- `OIDC_SESSION_TTL_SECONDS`: session lifetime (default `604800`)
- `OIDC_LOGIN_TTL_SECONDS`: login state lifetime (default `600`)
- `OIDC_COOKIE_SECURE`: mark auth cookies `Secure` (`1`/`0`, default `0`)
- `PUID`: container runtime UID (default `1000`)
- `PGID`: container runtime GID (default `1000`)
- `UVICORN_WORKERS`: worker count (default `1`)

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

Use Postgres locally by setting `DB_HOST`, `DB_PORT`, and `DB_NAME` (and optionally omitting `DATA_DIR`):

```bash
cd server
pip install -r requirements.txt
DB_HOST=localhost DB_PORT=5432 DB_NAME=places_been DATA_SOURCES_DIR=../data_sources uvicorn main:app --reload
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

The repo ships with a **small curated starter dataset** in `data_sources/` so the app runs immediately. On first run, the server imports these files into the database. After that, it polls `data_sources/` on a configurable interval and applies differential upserts/deletes automatically.

- `countries.geojson`: simplified placeholder polygons.
- `cities.json`: curated major cities.
- `airports.json`: curated major airports.
- `whc001.json`: UNESCO World Heritage site seed data.
- `darksky.json`: DarkSky place seed data.
- `festivals.json`: cultural festival seed data.
- `michelin_restaurants.json`: Michelin restaurant seed data.

### Replacing with full datasets

Use the commands below from the repo root:

1) **Countries (Natural Earth)**

```bash
mkdir -p data_sources/raw
curl -L "https://naturalearth.s3.amazonaws.com/110m_cultural/ne_110m_admin_0_countries.zip" -o data_sources/raw/ne_countries.zip
```

Then convert to GeoJSON with `ogr2ogr` (or QGIS) and place output at:

```bash
ogr2ogr -f GeoJSON data_sources/countries.geojson data_sources/raw/ne_110m_admin_0_countries.shp
```

2) **Cities (Natural Earth Populated Places)**

- Download populated places from:
  `https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/`
- Convert/filter to a curated top subset (e.g. top ~1000 by scalerank/population) and save as:

```bash
data_sources/cities.json
```

3) **Airports (OurAirports)**

- Download from: `https://ourairports.com/data/` (`airports.csv`)
- Filter to `type in {large_airport, medium_airport}` and export to:

```bash
data_sources/airports.json
```

4) **Sites**

- Use the split starter datasets in `data_sources/`:
  - `whc001.json`
  - `darksky.json`
  - `festivals.json`
  - `michelin_restaurants.json`

5) **Replace files and let the app sync them**

```bash
docker compose up --build
```

The default poll interval is hourly (`DATA_SYNC_INTERVAL_SECONDS=3600`). Set it to `0` to disable in-app polling.

> The map is dynamic (MapLibre + tile layers + GeoJSON overlays), not a static image. If your environment blocks outbound tile servers, the basemap can look empty; the overlay layers still render and remain interactive.

## Profiles

- First run prompts for the first profile name from the web UI (no seeded defaults).
- Supports Add / Edit / Delete profile actions.
- Includes an **All Profiles** mode with per-profile map colors and legend.
- When OIDC is enabled, profiles are owned by the authenticated user and are not visible to other users.

## Users

- The app now enforces users in all modes.
- OIDC mode: sign in via your provider.
- Local mode: first run prompts to create the first user, then requires selecting a user before using the app.

## OIDC authentication

- Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_SESSION_SECRET` to enable authentication.
- The app uses the OIDC authorization code flow and stores a signed session cookie server-side.
- Callback endpoint defaults to `http://<host>:8000/api/auth/callback`; override with `OIDC_REDIRECT_PATH` if needed.
- Existing unowned profiles are automatically assigned to the first user who logs in after enabling OIDC.

## API overview

- `GET /api/places?type=country|city|airport|site&query=&limit=&offset=`
- `GET /api/places/geojson?type=`
- `GET /api/profiles`
- `POST /api/profiles`
- `PUT /api/profiles/{profile_id}`
- `DELETE /api/profiles/{profile_id}`
- `GET /api/auth/session`
- `GET /api/auth/login`
- `GET /api/auth/callback`
- `POST /api/auth/logout`
- `GET /api/visits` (all profiles) or `GET /api/visits?profile_id=`
- `POST /api/visits/toggle`
- `GET /api/stats` (all profiles aggregate) or `GET /api/stats?profile_id=`
- `GET /api/export?profile_id=`
- `POST /api/import?profile_id=`

## Seeding

The database imports from `data_sources/` automatically on first start and then keeps syncing those files. You can still force a one-off sync with:

```bash
python scripts/seed_db.py
```

## Data Refresh Automation

- In-app polling:
  - Watches the repo-backed files in `data_sources/`.
  - Upserts changed/new places and removes retired places only when they are not referenced by visits or trip logs.
  - Controlled by:
    - `DATA_SYNC_INTERVAL_SECONDS` (default `3600`)
    - `DATA_SYNC_EXTERNAL_REFRESH_ENABLED` (default `0`)
    - `DATA_SYNC_EXTERNAL_REFRESH_INTERVAL_SECONDS` (default `86400`)
- `python3 scripts/refresh_external_sources.py`
  - Refreshes:
    - `data_sources/airports.json` from OurAirports (major airports with valid IATA code).
    - `data_sources/cities.json` from GeoNames `cities15000` (population >= 10k).
    - Site datasets are read from the split files:
      - `data_sources/whc001.json`
      - `data_sources/darksky.json`
      - `data_sources/festivals.json`

After refresh, the running app will detect the changed files on the next poll and sync them automatically. For an immediate sync:

```bash
python3 scripts/seed_db.py
```

If you want the server to run the refresh scripts itself, enable `DATA_SYNC_EXTERNAL_REFRESH_ENABLED=1`. It will run those scripts on the configured external refresh interval before syncing the local files back into the database.


## List Work
- TODO: Tighten city inclusion criteria (current list is too broad) and add a lookup + manual add flow for cities not in the curated list.
- TODO: Add Dark Sky destinations (International Dark Sky Places list).
- TODO: Add famous cultural festivals.
- TODO: Add national/iconic foods or regional food collections.
- TODO: Expand nature achievements (highest mountain, etc.).
- TODO: Expand Michelin-star coverage to include comparable regional review/ranking sources where Michelin is limited.
- TODO: Migrate/expand protected areas, national parks, and reserves data to WDPA-backed coverage.
