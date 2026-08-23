#!/usr/bin/env bash
# One-shot database setup for a fresh deployment.
#
# Usage:
#   bash deploy/setup-database.sh 'postgresql+asyncpg://USER:PASS@host/db?ssl=require'
#
# Runs, in order:
#   1. alembic upgrade head   -- creates every table, extension and constraint
#   2. scripts.seed           -- admin, hospitals, doctors, patients
#   3. scripts.seed_kb        -- knowledge base for the voice agent
#   4. a verification check   -- proves the booking constraint actually exists
#
# Runs everything inside the already-running `api` container, so you don't need
# Python, psql or any dependencies installed on your machine.

set -euo pipefail

DB_URL="${1:-}"
if [ -z "$DB_URL" ]; then
    echo "ERROR: pass your database URL as the first argument."
    echo ""
    echo "  bash deploy/setup-database.sh 'postgresql+asyncpg://user:pass@host/db?ssl=require'"
    echo ""
    exit 1
fi

# Catch the two mistakes that fail confusingly rather than loudly.
case "$DB_URL" in
    *sslmode=*)
        echo "ERROR: use '?ssl=require', not '?sslmode=require'."
        echo "       sslmode is a libpq parameter; this driver is asyncpg and rejects it."
        exit 1 ;;
    *-pooler.*)
        echo "ERROR: that is Neon's POOLED endpoint (hostname contains '-pooler')."
        echo "       Booking uses pg_advisory_xact_lock, which does not survive a"
        echo "       transaction-mode pooler. Use the DIRECT connection string."
        exit 1 ;;
    postgresql+asyncpg://*) ;;
    postgresql://*)
        echo "ERROR: change the 'postgresql://' prefix to 'postgresql+asyncpg://'."
        exit 1 ;;
    *)
        echo "ERROR: that does not look like a Postgres URL."
        exit 1 ;;
esac

echo "==> 1/4  Creating tables, extensions and constraints"
docker compose exec -T -e ALEMBIC_DATABASE_URL="$DB_URL" api alembic upgrade head

echo ""
echo "==> 2/4  Seeding users, hospitals and doctors"
docker compose exec -T -e DATABASE_URL="$DB_URL" api python -m scripts.seed

echo ""
echo "==> 3/4  Seeding the knowledge base (downloads embedding model on first run)"
docker compose exec -T -e DATABASE_URL="$DB_URL" api python -m scripts.seed_kb

echo ""
echo "==> 4/4  Verifying"
docker compose exec -T -e DATABASE_URL="$DB_URL" api python - <<'PYEOF'
import asyncio, os, sys
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

REQUIRED_EXTENSIONS = {"uuid-ossp", "vector", "btree_gist", "citext"}

async def main() -> int:
    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        found = {r[0] for r in (await conn.execute(text("SELECT extname FROM pg_extension"))).all()}
        constraint = (await conn.execute(text(
            "SELECT conname FROM pg_constraint WHERE conname = 'appointments_no_overlap'"
        ))).scalar()
        doctors = (await conn.execute(text(
            "SELECT count(*) FROM users WHERE role = 'doctor'"
        ))).scalar()
        chunks = (await conn.execute(text("SELECT count(*) FROM kb_chunks"))).scalar()
    await engine.dispose()

    ok = True
    missing = REQUIRED_EXTENSIONS - found
    if missing:
        print(f"  FAIL  missing extensions: {sorted(missing)}")
        ok = False
    else:
        print(f"  ok    extensions installed: {sorted(REQUIRED_EXTENSIONS)}")

    if constraint:
        print("  ok    double-booking constraint 'appointments_no_overlap' present")
    else:
        # This is the single constraint the whole booking design rests on.
        print("  FAIL  'appointments_no_overlap' MISSING -- double-booking is NOT prevented")
        ok = False

    print(f"  ok    {doctors} doctors seeded")
    print(f"  ok    {chunks} knowledge-base chunks indexed")
    return 0 if ok else 1

sys.exit(asyncio.run(main()))
PYEOF

echo ""
echo "Database ready."
