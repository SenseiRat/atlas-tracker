"""Application entry point.

Assembles the app from the server.app package and re-exports the package
surface so `server.main.<name>` keeps working for scripts and tests.
"""
from server.app.config import *  # noqa: F401,F403
from server.app.db import *  # noqa: F401,F403
from server.app.helpers import *  # noqa: F401,F403
from server.app.security import *  # noqa: F401,F403
from server.app.settings_store import *  # noqa: F401,F403
from server.app.data_sources import *  # noqa: F401,F403
from server.app.stats import *  # noqa: F401,F403
from server.app.auth import *  # noqa: F401,F403
from server.app.routes import *  # noqa: F401,F403
from server.app.factory import create_app

app = create_app()
