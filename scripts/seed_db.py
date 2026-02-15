import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))
os.environ.setdefault("DATA_DIR", str(BASE_DIR / "data"))
os.environ.setdefault("DATA_SOURCES_DIR", str(BASE_DIR / "data_sources"))

from server.main import seed_db

seed_db()
print("Database seeded")
