import os
from pathlib import Path

from server.main import seed_db

os.environ.setdefault("DATA_DIR", str(Path(__file__).resolve().parents[1] / "data"))
os.environ.setdefault("DATA_SOURCES_DIR", str(Path(__file__).resolve().parents[1] / "data_sources"))

seed_db()
print("Database seeded")
