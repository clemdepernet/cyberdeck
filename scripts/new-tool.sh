#!/usr/bin/env bash
# Scaffolds a new drawer of the deck: tools/<id>/ with a manifest, an nginx
# location and a static page. Then follow the printed steps.
#
#   scripts/new-tool.sh <id> "<Name>" ["<tagline>"] ["<tech>"]
#   e.g. scripts/new-tool.sh hashes "Hashes" "md5, sha1, sha256 d'un texte ou d'un fichier" "HTML · JavaScript"
set -euo pipefail

id="${1:-}"; name="${2:-}"; tagline="${3:-}"; tech="${4:-HTML · JavaScript}"
if [[ -z "$id" || -z "$name" ]]; then echo "usage: $0 <id> \"<Name>\" [\"<tagline>\"] [\"<tech>\"]" >&2; exit 1; fi
if ! [[ "$id" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then echo "id must be lowercase letters/digits/dashes" >&2; exit 1; fi

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/tools/$id"
[ -e "$dir" ] && { echo "tools/$id already exists" >&2; exit 1; }
mkdir -p "$dir"

next_order=$(( $(grep -h '"order"' "$root"/tools/*/tool.json 2>/dev/null | grep -o '[0-9]\+' | sort -n | tail -1 || echo 0) + 10 ))

cat > "$dir/tool.json" <<JSON
{
  "id": "$id",
  "name": "$name",
  "tagline": "$tagline",
  "tech": "$tech",
  "icon": "tool",
  "path": "/$id/",
  "order": $next_order
}
JSON

cat > "$dir/nginx.conf" <<NGINX
location /$id/ {
  alias /app/tools/$id/;
  try_files \$uri \$uri/ /$id/index.html;
}
NGINX

cat > "$dir/index.html" <<HTML
<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>$name · Cyberdeck</title>
  <link rel="stylesheet" href="/theme.css">
</head>
<body>
<div class="tool-page">
  <header class="tool-head">
    <div>
      <h1>$name</h1>
      <p>$tagline</p>
    </div>
  </header>
  <div class="tool-body">
    <p class="muted">À toi de jouer : tools/$id/index.html</p>
  </div>
</div>
<script src="/deck.js"></script>
</body>
</html>
HTML

cat <<MSG
Created tools/$id/ (tool.json, nginx.conf, index.html).

Static tool? You are done: rebuild the image and the tab appears.
Needs a process (API, backend)?
  1. add tools/$id/supervisor.conf (copy tools/paste/supervisor.conf, pick a free 81xx port)
  2. proxy it from tools/$id/nginx.conf (see tools/alpha/nginx.conf)
  3. build/install it in the Dockerfile (a "<id>-build" stage, or a runtime install)
Then: docker compose up -d --build
MSG
