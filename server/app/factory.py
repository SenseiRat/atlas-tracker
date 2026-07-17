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
from typing import Any, Dict, List, Optional, Set, Tuple
from collections.abc import Callable, Iterator

from fastapi import APIRouter, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from server.app.config import *  # noqa: F401,F403
from server.app.data_sources import (
    sync_data_sources_if_needed,
    start_data_sync_thread,
    stop_data_sync_thread,
)
from server.app.routes import router


def create_app() -> FastAPI:
    app = FastAPI(title="AtlasTracker")
    app.include_router(router)

    @app.on_event("startup")
    async def _startup() -> None:
        sync_data_sources_if_needed(reason="startup")
        start_data_sync_thread()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        stop_data_sync_thread()

    if FRONTEND_DIST.exists():
        app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")

    @app.get("/")
    async def root() -> FileResponse:
        index_path = FRONTEND_DIST / "index.html"
        if index_path.exists():
            return FileResponse(index_path)
        return FileResponse(str(Path(__file__).resolve().parents[1] / "placeholder.html"))

    return app
