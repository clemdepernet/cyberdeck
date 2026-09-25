#!/usr/bin/env bash
# Prepares /data (one sub-folder per tool), optional basic auth, then hands over to supervisord.
set -euo pipefail

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${DATA_DIR:-/data}"

groupmod -o -g "$PGID" deck >/dev/null 2>&1 || true
usermod -o -u "$PUID" deck >/dev/null 2>&1 || true

mkdir -p "$DATA_DIR"
for d in /app/tools/*/; do
  id="$(basename "$d")"
  mkdir -p "$DATA_DIR/$id"
done
chown -R deck:deck "$DATA_DIR"

mkdir -p "$DATA_DIR/gate"
chown deck:deck "$DATA_DIR/gate"

# Optional login: APP_PASSWORD (+ APP_USER, default toolbox) puts the whole deck
# behind the gate's login page; short links and paste reading stay public.
if [ -n "${APP_PASSWORD:-}" ]; then
  cat > /etc/nginx/auth.conf <<CONF
auth_request /gate/check;
auth_request_set \$deck_user \$upstream_http_x_deck_user;
auth_request_set \$deck_role \$upstream_http_x_deck_role;
error_page 401 = @login;
CONF
  echo "[cyberdeck] login required (user '${APP_USER:-toolbox}')"
else
  : > /etc/nginx/auth.conf
  echo "[cyberdeck] no APP_PASSWORD set: the deck is open to anyone who can reach it"
fi

nginx -t
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
