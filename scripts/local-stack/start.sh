#!/usr/bin/env bash
# Boots a minimal, Docker-free Supabase-compatible stack for integration testing:
#   PostgreSQL (local binaries) + Supabase Auth (GoTrue) + PostgREST + a tiny gateway on :54321
# that routes /auth/v1 and /rest/v1 like a real Supabase project. Storage, Realtime and Edge
# Functions are NOT included (storage tables are stubbed so the migrations apply).
#
# Usage: scripts/local-stack/start.sh   (then: source $STACK_DIR/env.sh)
# Needs: PostgreSQL 15+ server binaries, Node 18+, curl, internet access to github.com once.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STACK_DIR="${STACK_DIR:-$ROOT/.local-stack}"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PGPORT=54330
AUTH_VERSION=2.177.0
PGRST_VERSION=12.2.12
JWT_SECRET="vendora-local-dev-jwt-secret-at-least-32-chars"
mkdir -p "$STACK_DIR"
cd "$STACK_DIR"

[ -x ./postgrest ] || { curl -fsSL -o pgrst.tar.xz "https://github.com/PostgREST/postgrest/releases/download/v$PGRST_VERSION/postgrest-v$PGRST_VERSION-linux-static-x86-64.tar.xz" && tar xJf pgrst.tar.xz && rm pgrst.tar.xz; }
[ -x ./auth/gotrue ] || { mkdir -p auth && curl -fsSL -o auth.tar.gz "https://github.com/supabase/auth/releases/download/v$AUTH_VERSION/auth-v$AUTH_VERSION-x86.tar.gz" && tar xzf auth.tar.gz -C auth && rm auth.tar.gz; }

RUN_AS=()
if [ "$(id -u)" = "0" ]; then RUN_AS=(runuser -u postgres --); fi
if [ ! -d data ]; then
  mkdir -p data && { [ "$(id -u)" = "0" ] && chown postgres data || true; }
  "${RUN_AS[@]}" "$PGBIN/initdb" -D "$STACK_DIR/data" -A trust -U postgres >/dev/null
  echo "wal_level = logical" >> data/postgresql.conf
fi
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$STACK_DIR/data" -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1" -l "$STACK_DIR/data/postgres.log" start >/dev/null || true
sleep 2
PSQL=(psql -h 127.0.0.1 -p $PGPORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)

if ! "${PSQL[@]}" -tAc "select 1 from pg_roles where rolname='supabase_auth_admin'" | grep -q 1; then
  "${PSQL[@]}" <<'SQL'
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login password 'postgres' noinherit;
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin login password 'postgres' createrole noinherit;
create schema if not exists auth authorization supabase_auth_admin;
grant create on database postgres to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
grant usage on schema auth to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text not null, owner uuid);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create publication supabase_realtime;
SQL
fi

export GOTRUE_DB_DRIVER=postgres
export DATABASE_URL="postgres://supabase_auth_admin:postgres@127.0.0.1:$PGPORT/postgres?sslmode=disable&search_path=auth"
export GOTRUE_DB_MIGRATIONS_PATH="$STACK_DIR/auth/migrations"
export GOTRUE_SITE_URL="http://localhost:4173/VENDORA/"
export GOTRUE_URI_ALLOW_LIST="http://localhost:4173/**"
export API_EXTERNAL_URL="http://localhost:54321/auth/v1"
export GOTRUE_API_HOST=127.0.0.1 PORT=9999
export GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated
export GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role
export GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true GOTRUE_DISABLE_SIGNUP=false
export GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true
if ! "${PSQL[@]}" -tAc "select 1 from pg_tables where schemaname='auth' and tablename='users'" | grep -q 1; then
  ./auth/gotrue migrate > auth-migrate.log 2>&1
fi
if ! "${PSQL[@]}" -tAc "select 1 from pg_tables where schemaname='public' and tablename='businesses'" | grep -q 1; then
  for f in "$ROOT"/supabase/migrations/*.sql; do echo "applying $(basename "$f")"; "${PSQL[@]}" -f "$f" >/dev/null; done
fi
pkill -f "auth/gotrue" 2>/dev/null || true
nohup ./auth/gotrue > auth.log 2>&1 &

cat > postgrest.conf <<CONF
db-uri = "postgres://authenticator:postgres@127.0.0.1:$PGPORT/postgres"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = 3000
CONF
pkill -f "postgrest postgrest.conf" 2>/dev/null || true
nohup ./postgrest postgrest.conf > postgrest.log 2>&1 &

ANON_KEY=$(JWT_SECRET="$JWT_SECRET" ROLE=anon node "$ROOT/scripts/local-stack/jwt.mjs")
SERVICE_KEY=$(JWT_SECRET="$JWT_SECRET" ROLE=service_role node "$ROOT/scripts/local-stack/jwt.mjs")
pkill -f "local-stack/gateway.mjs" 2>/dev/null || true
nohup node "$ROOT/scripts/local-stack/gateway.mjs" > gateway.log 2>&1 &
sleep 3
cat > env.sh <<ENV
export VITE_SUPABASE_URL=http://localhost:54321
export VITE_SUPABASE_ANON_KEY=$ANON_KEY
export LOCAL_SERVICE_KEY=$SERVICE_KEY
export LOCAL_PG="postgres://postgres@127.0.0.1:$PGPORT/postgres"
ENV
curl -fsS http://localhost:54321/auth/v1/health >/dev/null && echo "auth: ok" || { echo "auth: FAILED"; tail -20 auth.log; exit 1; }
curl -fsS -H "apikey: $ANON_KEY" http://localhost:54321/rest/v1/ >/dev/null && echo "rest: ok" || { echo "rest: FAILED"; tail -20 postgrest.log; exit 1; }
echo "Local stack ready. source $STACK_DIR/env.sh"
