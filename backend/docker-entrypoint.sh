#!/bin/bash
set -e

# Run Alembic migrations if using Postgres
if [ -n "$DATABASE_URL" ] && [[ "$DATABASE_URL" != sqlite* ]]; then
    echo "Running database migrations..."
    cd /app && alembic upgrade head
fi

exec "$@"
