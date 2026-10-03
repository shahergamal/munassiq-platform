#!/bin/bash
# Entry point for the single-container Railway image (deploy/railway.Dockerfile).
# Railway assigns the public port at runtime via $PORT; nginx must listen on it, and the API always
# listens on 4000 internally. Migrations run once at start, then both processes run in the foreground
# so the container exits (and Railway restarts it) if either one dies.
set -e

# $PORT is Railway's public port for nginx. The API always listens on 4000 internally (nginx proxies
# /api/ to it), so PORT is overridden just for the node process below, not for nginx.
WEB_PORT="${PORT:-8080}"
sed "s/__PORT__/$WEB_PORT/" /etc/nginx/http.d/default.conf.template > /etc/nginx/http.d/default.conf

echo "[railway-start] applying database migrations..."
(cd /srv/app/apps/api && PORT=4000 node src/db/migrate.ts)

echo "[railway-start] starting API on :4000 and nginx on :$WEB_PORT..."
(cd /srv/app/apps/api && PORT=4000 node src/server.ts) &
API_PID=$!
nginx -g 'daemon off;' &
NGINX_PID=$!

wait -n "$API_PID" "$NGINX_PID"
exit $?
