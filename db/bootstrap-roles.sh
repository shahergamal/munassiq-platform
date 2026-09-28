#!/bin/bash
# Creates the two runtime roles. Runs once (docker-entrypoint-initdb.d) or manually on managed PostgreSQL.
#   munassiq_app    : tenant traffic. RLS ENFORCED. Never bypasses isolation.
#   munassiq_system : auth, tenant provisioning, platform admin. BYPASSRLS, narrow code paths only.
# The migration owner is the role that runs `npm run db:migrate` (POSTGRES_USER in docker-compose).
set -euo pipefail
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
: "${SYSTEM_DB_PASSWORD:?SYSTEM_DB_PASSWORD is required}"
DB="${POSTGRES_DB:-munassiq}"
psql -v ON_ERROR_STOP=1 -v app_pw="$APP_DB_PASSWORD" -v sys_pw="$SYSTEM_DB_PASSWORD" -U "${POSTGRES_USER:-postgres}" -d "$DB" <<'SQL'
SELECT format('CREATE ROLE munassiq_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'munassiq_app') \gexec
SELECT format('CREATE ROLE munassiq_system LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS', :'sys_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'munassiq_system') \gexec
SQL
psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$DB" -c "GRANT CONNECT ON DATABASE \"$DB\" TO munassiq_app, munassiq_system; GRANT USAGE ON SCHEMA public TO munassiq_app, munassiq_system;"
