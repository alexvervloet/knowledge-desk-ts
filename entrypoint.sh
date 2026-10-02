#!/bin/sh
# Run pending migrations only when asked (the API service sets RUN_MIGRATIONS=1).
# Then exec the service command.
set -e

if [ "$RUN_MIGRATIONS" = "1" ]; then
    echo "running migrations..."
    node dist/src/migrate.js
fi

exec "$@"
