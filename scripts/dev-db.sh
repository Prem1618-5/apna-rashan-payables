#!/usr/bin/env bash
# Local Postgres 16 for development, no Docker needed.
#   scripts/dev-db.sh [start]   create (first time) and start the cluster in ./data/pg
#   scripts/dev-db.sh stop      stop it
#   scripts/dev-db.sh status    show whether it is running
#   scripts/dev-db.sh psql      open psql on the dev database
# Result: postgres://arad:arad@localhost:5432/arad (matches .env.example). Idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${DEV_PGDATA:-$ROOT/data/pg}"
PGPORT="${DEV_PGPORT:-5432}"
DB_USER=arad
DB_PASS=arad
DB_NAME=arad
LOG="$PGDATA/server.log"

if [ ! -x "$PGBIN/pg_ctl" ]; then
  echo "Postgres binaries not found in $PGBIN (set PGBIN)" >&2
  exit 1
fi

# initdb/postgres refuse to run as root; use the postgres system user in that case.
as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

psql_admin() {
  PGPASSWORD="$DB_PASS" "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -v ON_ERROR_STOP=1 "$@"
}

init_cluster() {
  echo "Creating Postgres cluster in $PGDATA"
  mkdir -p "$PGDATA"
  if [ "$(id -u)" = "0" ]; then chown postgres:postgres "$PGDATA"; fi
  chmod 700 "$PGDATA"
  local pwfile
  pwfile="$(mktemp)"
  printf '%s\n' "$DB_PASS" >"$pwfile"
  if [ "$(id -u)" = "0" ]; then chown postgres "$pwfile"; fi
  as_pg "$PGBIN/initdb" -D "$PGDATA" -U "$DB_USER" --pwfile="$pwfile" -E UTF8 --no-locale \
    --auth-local=scram-sha-256 --auth-host=scram-sha-256 >/dev/null
  rm -f "$pwfile"
  cat <<EOF | as_pg tee -a "$PGDATA/postgresql.conf" >/dev/null

# --- dev settings (scripts/dev-db.sh)
listen_addresses = '127.0.0.1'
port = $PGPORT
unix_socket_directories = ''
timezone = 'UTC'
log_timezone = 'UTC'
max_connections = 200
EOF
}

start() {
  [ -s "$PGDATA/PG_VERSION" ] || init_cluster
  if as_pg "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    echo "Postgres already running on port $PGPORT"
  else
    as_pg "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOG" -w -t 30 start >/dev/null
    echo "Postgres started on port $PGPORT (log: $LOG)"
  fi
  if ! psql_admin -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1; then
    psql_admin -d postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER" >/dev/null
    echo "Created database $DB_NAME"
  fi
  echo "DATABASE_URL=postgres://$DB_USER:$DB_PASS@localhost:$PGPORT/$DB_NAME"
}

stop() {
  if [ -s "$PGDATA/PG_VERSION" ] && as_pg "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    as_pg "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null
    echo "Postgres stopped"
  else
    echo "Postgres is not running"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) as_pg "$PGBIN/pg_ctl" -D "$PGDATA" status || true ;;
  psql) shift; psql_admin -d "$DB_NAME" "$@" ;;
  *) echo "usage: $0 [start|stop|status|psql]" >&2; exit 2 ;;
esac
