FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY .npmrc /app/.npmrc
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY frontend ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV DATA_DIR=/data
ENV DATA_SOURCES_DIR=/app/data_sources
ENV FRONTEND_DIST=/app/frontend/dist
ENV DB_BACKEND=auto
ENV DB_HOST=
ENV DB_PORT=5432
ENV DB_NAME=
ENV DB_USER=postgres
ENV DB_PASSWORD=
ENV DB_SSLMODE=prefer
ENV SQLITE_DB_PATH=
ENV SQLITE_BUSY_TIMEOUT_MS=5000
ENV SQLITE_ENABLE_WAL=1
ENV IMPORT_MAX_BYTES=10485760
ENV OIDC_ISSUER=
ENV OIDC_CLIENT_ID=
ENV OIDC_CLIENT_SECRET=
ENV OIDC_SCOPES="openid profile email"
ENV OIDC_REDIRECT_PATH=/api/auth/callback
ENV OIDC_SESSION_SECRET=
ENV OIDC_SESSION_COOKIE=world_tracker_session
ENV OIDC_LOGIN_COOKIE=world_tracker_login
ENV OIDC_SESSION_TTL_SECONDS=604800
ENV OIDC_LOGIN_TTL_SECONDS=600
ENV OIDC_COOKIE_SECURE=0
ENV UVICORN_HOST=0.0.0.0
ENV UVICORN_PORT=8000
ENV UVICORN_WORKERS=1

COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server ./server
COPY data_sources ./data_sources
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /data

EXPOSE 8000
CMD ["sh", "-c", "uvicorn server.main:app --host ${UVICORN_HOST} --port ${UVICORN_PORT} --workers ${UVICORN_WORKERS} --proxy-headers --forwarded-allow-ips='*'"]
