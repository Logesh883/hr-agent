"""Dev entry point: `uv run python -m app --reload` serves on AI_HOST:AI_PORT from the root .env."""

import argparse

import uvicorn

from app.settings import get_settings

parser = argparse.ArgumentParser(prog="python -m app")
parser.add_argument("--reload", action="store_true", help="restart on code changes")
args = parser.parse_args()

settings = get_settings()
uvicorn.run("app.main:app", host=settings.ai_host, port=settings.ai_port, reload=args.reload)
