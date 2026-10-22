#!/bin/sh
# Container entrypoint (runs under tini).
#
# If DATABASE_URL is not set but DB_HOST is, build DATABASE_URL from
#   DB_HOST, DB_PORT (5432), DB_NAME, DB_USER, DB_PASSWORD, DB_SSLMODE (optional)
# DB_PASSWORD may be the plain password (ECS secret "<arn>:password::") or the
# whole RDS-managed secret JSON {"username": "...", "password": "..."}.
# User and password are URL-encoded. Nothing secret is printed.
set -eu

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  # shellcheck disable=SC2016 # the single-quoted text is JavaScript, not shell
  DATABASE_URL="$(node -e '
    const e = process.env;
    let user = e.DB_USER || "";
    let password = e.DB_PASSWORD || "";
    if (password.trim().startsWith("{")) {
      try {
        const j = JSON.parse(password);
        password = j.password || "";
        user = user || j.username || "";
      } catch {
        console.error("entrypoint: DB_PASSWORD looks like JSON but does not parse");
        process.exit(1);
      }
    }
    for (const [k, v] of [["DB_USER", user], ["DB_PASSWORD", password], ["DB_NAME", e.DB_NAME]]) {
      if (!v) { console.error(`entrypoint: ${k} is required when DB_HOST is set`); process.exit(1); }
    }
    const enc = encodeURIComponent;
    const port = e.DB_PORT || "5432";
    const query = e.DB_SSLMODE ? `?sslmode=${enc(e.DB_SSLMODE)}` : "";
    process.stdout.write(`postgres://${enc(user)}:${enc(password)}@${e.DB_HOST}:${port}/${enc(e.DB_NAME)}${query}`);
  ')"
  export DATABASE_URL
  unset DB_PASSWORD
fi

exec "$@"
