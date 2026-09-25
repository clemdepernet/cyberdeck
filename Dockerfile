# syntax=docker/dockerfile:1
# Cyberdeck: one image, several tools, each built with its own stack.
#
# Adding a tool:
#   1. create tools/<id>/ with tool.json, nginx.conf (+ supervisor.conf if it runs a process)
#   2. if it needs compiling, add a `<id>-build` stage below and COPY --from it in the runtime stage
#   3. if it needs a runtime (python venv, node…), install it in the runtime stage
# scripts/new-tool.sh does step 1 for you.

# ───────────────────────── whiteboard: React + Excalidraw, built with Vite ─────────────────────────
FROM node:22-bookworm-slim AS whiteboard-build
WORKDIR /build
COPY tools/whiteboard/app/package.json tools/whiteboard/app/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY tools/whiteboard/app/ ./
RUN npm run build \
 && cp -r node_modules/@excalidraw/excalidraw/dist/prod/fonts dist/fonts \
 && ls dist

# ───────────────────────── pivot: React + React Flow, built with Vite (parser tests run here) ─────────────────────────
FROM node:22-bookworm-slim AS pivot-build
WORKDIR /build
COPY tools/pivot/app/package.json tools/pivot/app/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY tools/pivot/app/ ./
RUN npm test && npm run build && ls dist

# ───────────────────────── gate: Go, login page + auth_request backend ─────────────────────────
FROM golang:1.23-bookworm AS gate-build
WORKDIR /build
COPY gate/ ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o gate .

# ───────────────────────── paste: Go, static binary ─────────────────────────
FROM golang:1.23-bookworm AS paste-build
WORKDIR /build
COPY tools/paste/go.mod tools/paste/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY tools/paste/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o paste .

# ───────────────────────── links: Go, static binary ─────────────────────────
FROM golang:1.23-bookworm AS links-build
WORKDIR /build
COPY tools/links/go.mod tools/links/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY tools/links/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o links .

# ───────────────────────── convert: Go, static binary (drives LibreOffice, ImageMagick, ffmpeg…) ─────────────────────────
FROM golang:1.23-bookworm AS convert-build
WORKDIR /build
COPY tools/convert/ ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o convert .

# ───────────────────────── cyberchef: official static build, downloaded as-is ─────────────────────────
FROM debian:bookworm-slim AS cyberchef-build
ARG CYBERCHEF_VERSION=v11.5.0
ARG CYBERCHEF_ZIP=CyberChef_8cd426dd4f40f1423912d5fad91b578a86a65112.zip
RUN set -eux; \
    apt-get update; apt-get install -y --no-install-recommends ca-certificates curl unzip; \
    curl -fsSL -o /tmp/cyberchef.zip "https://github.com/gchq/CyberChef/releases/download/${CYBERCHEF_VERSION}/${CYBERCHEF_ZIP}"; \
    mkdir -p /cyberchef; unzip -q /tmp/cyberchef.zip -d /cyberchef; rm /tmp/cyberchef.zip; \
    mv /cyberchef/CyberChef_${CYBERCHEF_VERSION}.html /cyberchef/index.html; \
    ls /cyberchef | head

# ───────────────────────── runtime ─────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/data PUID=1000 PGID=1000 PUBLIC_URL="" MAX_LINKS=10 HIBP_API_KEY="" VT_API_KEY="" APP_USER=toolbox APP_PASSWORD="" APP_USERS=""
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends nginx supervisor python3 python3-venv openssl ca-certificates curl \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
      imagemagick img2pdf poppler-utils pandoc ffmpeg file \
      fonts-liberation fonts-dejavu-core fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core; \
    rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled /etc/nginx/sites-available /var/www/html; \
    userdel -r node 2>/dev/null || true; \
    useradd --system --uid 1000 --create-home --shell /usr/sbin/nologin deck

WORKDIR /app

# alpha: Python venv (FastAPI + Pillow + numpy)
COPY tools/alpha/requirements.txt /app/tools/alpha/requirements.txt
RUN python3 -m venv /opt/alpha && /opt/alpha/bin/pip install -r /app/tools/alpha/requirements.txt

# leaks: Python venv (FastAPI + httpx)
COPY tools/leaks/requirements.txt /app/tools/leaks/requirements.txt
RUN python3 -m venv /opt/leaks && /opt/leaks/bin/pip install -r /app/tools/leaks/requirements.txt

# verdict: Python venv (FastAPI + httpx + multipart uploads)
COPY tools/verdict/requirements.txt /app/tools/verdict/requirements.txt
RUN python3 -m venv /opt/verdict && /opt/verdict/bin/pip install -r /app/tools/verdict/requirements.txt

# whole tree (static tools need nothing else)
COPY shell/ /app/shell/
COPY tools/ /app/tools/
COPY --from=gate-build /build/gate /app/gate/gate
COPY scripts/ /app/scripts/
COPY supervisord.conf /etc/supervisor/supervisord.conf
COPY entrypoint.sh /app/entrypoint.sh

# compiled artefacts
COPY --from=whiteboard-build /build/dist /app/tools/whiteboard/dist
COPY --from=pivot-build /build/dist /app/tools/pivot/dist
COPY --from=paste-build /build/paste /app/tools/paste/paste
COPY --from=cyberchef-build /cyberchef /app/tools/cyberchef/dist
COPY --from=convert-build /build/convert /app/tools/convert/convert
COPY --from=links-build /build/links /app/tools/links/links

RUN set -eux; \
    rm -rf /app/tools/whiteboard/app; \
    rm -rf /app/tools/pivot/app; \
    cp /app/shell/nginx.conf /etc/nginx/nginx.conf; \
    : > /etc/nginx/auth.conf; \
    python3 /app/scripts/build-manifest.py; \
    chmod +x /app/entrypoint.sh /app/gate/gate /app/tools/paste/paste /app/tools/convert/convert /app/tools/convert/smoke.sh /app/tools/links/links; \
    nginx -t

# ───────────────────────── test: run the Python + Node suites inside the real image ─────────────────────────
FROM runtime AS test
RUN /opt/alpha/bin/pip install pytest httpx \
 && cd /app/tools/alpha && /opt/alpha/bin/python -m pytest -q \
 && /opt/leaks/bin/pip install pytest \
 && cd /app/tools/leaks && /opt/leaks/bin/python -m pytest -q \
 && /opt/verdict/bin/pip install pytest \
 && cd /app/tools/verdict && /opt/verdict/bin/python -m pytest -q \
 && cd /app/tools/whiteboard && node --test server.test.mjs \
 && cd /app/tools/pivot && node --test server.test.mjs \
 && su deck -s /bin/bash -c /app/tools/convert/smoke.sh

FROM runtime
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD curl -fsS http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
