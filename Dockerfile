FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV DATA_DIR=/data
ENV DATA_SOURCES_DIR=/app/data_sources
ENV FRONTEND_DIST=/app/frontend/dist

COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server ./server
COPY data_sources ./data_sources
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /data

EXPOSE 8000
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
