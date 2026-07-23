# AtlasTracker

> Built entirely with agentic AI (OpenAI Codex version 26).  I directed and reviewed the agents but didn't write the code myself. It's a personal project, so treat it accordingly; there are no security or stability guarantees, and this should not be deployed to the open internet.

A single-container, self-hosted tracker for countries, states/regions, cities, airports, and heritage sites. It ships with a small curated dataset so it runs instantly, and it's built so you can drop in the full Natural Earth / OurAirports / GeoNames datasets later.

## Quick start (Docker)

```bash
docker compose up --build
```

The container listens on port `8000`, published as `8000` on the host.

Open http://localhost:8000

### Data persistence

SQLite is stored in a Docker volume at `/data/app.db`.

### Optional Postgres backend

SQLite is the default. To use Postgres instead, set `DB_HOST`, `DB_PORT`, and `DB_NAME`:

```bash
DB_HOST=localhost DB_PORT=5432 DB_NAME=places_been docker compose up --build
```

When `DB_HOST` and `DB_NAME` are set, the API switches to Postgres automatically (`DB_BACKEND=auto`).

## Runtime environment variables

Configure the container with these:

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
- `OIDC_SESSION_COOKIE`: signed session cookie name (default `atlas_tracker_session`)
- `OIDC_LOGIN_COOKIE`: temporary login state cookie name (default `atlas_tracker_login`)
- `OIDC_SESSION_TTL_SECONDS`: session lifetime (default `604800`)
- `OIDC_LOGIN_TTL_SECONDS`: login state lifetime (default `600`)
- `OIDC_COOKIE_SECURE`: mark auth cookies `Secure` (`1`/`0`, default `0`)
- `PUID`: container runtime UID (default `1000`)
- `PGID`: container runtime GID (default `1000`)
- `UVICORN_WORKERS`: worker count (default `1`)

## Local development

The backend is a package under `server/app/`; run uvicorn from the repository
root so `server.main:app` resolves. The dev frontend proxies `/api` to the
backend on port 8000 (see `frontend/vite.config.ts`), so the two run
independently.

Frontend:

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, proxies /api -> :8000
```

Backend, in another terminal from the repository root:

```bash
pip install -r server/requirements.txt
DATA_DIR=./data DATA_SOURCES_DIR=./data_sources uvicorn server.main:app --reload
```

To use Postgres locally, set `DB_HOST`, `DB_PORT`, and `DB_NAME` (and optionally drop `DATA_DIR`):

```bash
pip install -r server/requirements.txt
DB_HOST=localhost DB_PORT=5432 DB_NAME=places_been DATA_SOURCES_DIR=./data_sources uvicorn server.main:app --reload
```

## Tests

Backend (pytest against an in-process TestClient with tiny fixture datasets):

```bash
pip install -r server/requirements-dev.txt
python -m pytest server/tests -q
```

Frontend (vitest for the pure stat/achievement logic and the shared UI
components; `typecheck` runs `tsc --noEmit`):

```bash
cd frontend
npm run test
npm run typecheck
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

## Data sources

The repo ships with a small curated starter dataset in `data_sources/` so the app runs immediately. On first run the server imports these files into the database. After that it polls `data_sources/` on a configurable interval and applies differential upserts/deletes automatically.

- `countries.geojson`: country polygons.
- `state_regions.geojson`: state/region polygons.
- `cities.json`: curated cities.
- `airports.json`: curated airports.
- Sites are split across several curated files, each feeding the `site` place type:
  - `whc001.json`: UNESCO World Heritage sites.
  - `darksky.json`: DarkSky International places.
  - `festivals.json`: festivals.
  - `michelin_restaurants.json`: Michelin-starred restaurants.

### Replacing with full datasets

Run these from the repo root.

1) **Countries (Natural Earth)**

```bash
mkdir -p data_sources/raw
curl -L "https://naturalearth.s3.amazonaws.com/110m_cultural/ne_110m_admin_0_countries.zip" -o data_sources/raw/ne_countries.zip
```

Then convert to GeoJSON with `ogr2ogr` (or QGIS) and write the output to `data_sources/countries.geojson`:

```bash
ogr2ogr -f GeoJSON data_sources/countries.geojson data_sources/raw/ne_110m_admin_0_countries.shp
```

2) **Cities (GeoNames)**

The refresh script (below) pulls these from GeoNames `cities15000` automatically. To do it by hand, filter your source down to a curated subset and save it as `data_sources/cities.json`.

3) **Airports (OurAirports)**

The refresh script pulls these too. By hand: download `airports.csv` from https://ourairports.com/data/, filter to major airports with a valid IATA code, and save as `data_sources/airports.json`.

4) **Sites**

Keep the curated site files (`whc001.json`, `darksky.json`, `festivals.json`, `michelin_restaurants.json`) as-is, or replace them with your own lists in the same shape.

5) **Replace the files and let the app sync them**

```bash
docker compose up --build
```

The default poll interval is hourly (`DATA_SYNC_INTERVAL_SECONDS=3600`). Set it to `0` to disable in-app polling.

> The map is dynamic (MapLibre + tile layers + GeoJSON overlays), not a static image. If your environment blocks outbound tile servers the basemap can look empty, but the overlay layers still render and stay interactive.

## Profiles

- First run prompts for the first profile name from the web UI (no seeded defaults).
- Supports Add / Edit / Delete.
- Includes an **All Profiles** mode with per-profile map colors and a legend.
- When OIDC is enabled, profiles are owned by the authenticated user and aren't visible to other users.

## Users

- The app enforces users in all modes.
- OIDC mode: sign in via your provider.
- Local mode: first run prompts you to create the first user, then requires selecting a user before using the app.

## OIDC authentication (untested)

- Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_SESSION_SECRET` to enable authentication.
- The app uses the OIDC authorization code flow and stores a signed session cookie server-side.
- The callback endpoint defaults to `http://<host>:8000/api/auth/callback`; override it with `OIDC_REDIRECT_PATH` if needed.
- Existing unowned profiles are automatically assigned to the first user who logs in after OIDC is enabled.

## API overview

- `GET /api/places?type=country|state|city|airport|site&query=&limit=&offset=`
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
- `GET /api/stats` (all-profiles aggregate) or `GET /api/stats?profile_id=`
- `GET /api/export?profile_id=`
- `POST /api/import?profile_id=`

## Seeding

The database imports from `data_sources/` automatically on first start and then keeps syncing those files. You can force a one-off sync with:

```bash
python scripts/seed_db.py
```

## Data refresh automation

In-app polling:

- Watches the repo-backed files in `data_sources/`.
- Upserts changed/new places and removes retired ones, but only when they aren't referenced by visits or trip logs.
- Controlled by `DATA_SYNC_INTERVAL_SECONDS` (default `3600`; set to `0` to disable).

Refreshing the source files from upstream:

```bash
python3 scripts/refresh_external_sources.py
```

This regenerates:

- `data_sources/airports.json` from OurAirports (major airports with a valid IATA code).
- `data_sources/cities.json` from GeoNames `cities15000` (population >= 10k).

The script deliberately leaves the site datasets (`whc001.json`, `darksky.json`, `festivals.json`, `michelin_restaurants.json`) alone — those are curated by hand.

After a refresh, the running app detects the changed files on its next poll and syncs them automatically. For an immediate sync:

```bash
python3 scripts/seed_db.py
```

## License

Released under The Unlicense (public domain). As an AI-generated project, no ownership claim is made over any portion that isn't copyrightable for lack of sufficient human authorship; any human-authored contribution (prompts, curation, arrangement, documentation) is dedicated to the public domain.
