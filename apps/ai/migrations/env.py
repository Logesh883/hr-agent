"""Alembic environment for the `ai` schema.

Only the `ai` schema is managed here, and Alembic's own version table lives in it too, so
`public` (owned by Prisma) is never touched or compared.
"""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import text
from sqlalchemy.engine import Connection

import graphs.records  # noqa: F401  # pyright: ignore[reportUnusedImport] (registers run tables)
from app.settings import get_settings
from rag.db import SCHEMA, create_engine, metadata

config = context.config
if config.config_file_name is not None:
    # Keep the service's loggers working when migrations run in-process (tests).
    fileConfig(config.config_file_name, disable_existing_loggers=False)

URL = context.get_x_argument(as_dictionary=True).get("url") or get_settings().ai_db_url


def include_name(name: str | None, type_: str, parent_names: object) -> bool:
    # Autogenerate compares only our schema; Prisma's tables in `public` are not ours.
    if type_ == "schema":
        return name == SCHEMA
    # LangGraph's checkpointer creates and migrates its own tables in `ai` (checkpoints,
    # checkpoint_blobs, checkpoint_writes, checkpoint_migrations): not Alembic's to manage.
    if type_ == "table":
        return name is not None and not name.startswith("checkpoint")
    return True


def do_run_migrations(connection: Connection) -> None:
    connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
    context.configure(
        connection=connection,
        target_metadata=metadata,
        version_table_schema=SCHEMA,
        include_schemas=True,
        include_name=include_name,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations() -> None:
    engine = create_engine(URL)
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations)
        await connection.commit()
    await engine.dispose()


if context.is_offline_mode():
    raise SystemExit("Offline (--sql) migrations aren't set up; run against a database.")
asyncio.run(run_migrations())
