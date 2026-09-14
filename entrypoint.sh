#!/bin/sh
# Run pending migrations only when asked (the API service sets RUN_MIGRATIONS=1);
# the worker skips them and waits for the API to be healthy first. Then exec the
# service command (the server or the worker).
set -e

if [ "$RUN_MIGRATIONS" = "1" ]; then
    echo "running migrations..."
    node dist/src/migrate.js
fi

exec "$@"
