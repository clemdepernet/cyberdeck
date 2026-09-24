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

# Optional shared password (same idea as APP_PASSWORD elsewhere in the homelab).
if [ -n "${APP_PASSWORD:-}" ]; then
  user="${APP_USER:-toolbox}"
  hash="$(openssl passwd -apr1 "$APP_PASSWORD")"
  printf '%s:%s\n' "$user" "$hash" > /etc/nginx/.htpasswd
  chmod 640 /etc/nginx/.htpasswd
  cat > /etc/nginx/auth.conf <<CONF
auth_basic "Cyberdeck";
auth_basic_user_file /etc/nginx/.htpasswd;
CONF
  echo "[cyberdeck] basic auth enabled for user '$user'"
else
  : > /etc/nginx/auth.conf
  echo "[cyberdeck] no APP_PASSWORD set: the deck is open to anyone who can reach it"
fi

nginx -t
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
