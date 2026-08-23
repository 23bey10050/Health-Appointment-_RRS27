"""Shared column-type helpers so every model declares Postgres ENUMs the same way.

`create_type=False` everywhere: the Alembic baseline migration creates the Postgres
CREATE TYPE statements explicitly (see alembic/versions/0001_baseline.py). Letting
SQLAlchemy also try to create them on `metadata.create_all()` would double-create /
order incorrectly relative to the exclusion constraint and generated columns.
"""

from sqlalchemy.dialects import postgresql


def pg_enum(enum_cls: type, name: str) -> postgresql.ENUM:
    return postgresql.ENUM(
        enum_cls,
        name=name,
        create_type=False,
        values_callable=lambda obj: [e.value for e in obj],
    )
