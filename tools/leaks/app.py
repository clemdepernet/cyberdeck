"""Leaks: has an e-mail address appeared in known breaches, and what leaked lately?

E-mail lookups go to Have I Been Pwned v3 and need HIBP_API_KEY. The breach
catalogue, the Pwned Passwords range API and the news feeds are free. Nothing
is stored: results are cached in memory for a few minutes, that is all.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from sources import breaches_as_feed, merge, normalise_breach, parse_rss

HIBP = "https://haveibeenpwned.com/api/v3"
PWNED = "https://api.pwnedpasswords.com/range"
USER_AGENT = os.environ.get("USER_AGENT", "cyberdeck-leaks/1.0 (+https://github.com/clemdepernet/cyberdeck)")
CHECK_TTL = int(os.environ.get("CHECK_TTL", 600))
FEED_TTL = int(os.environ.get("FEED_TTL", 900))
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[a-zA-Z0-9-]{2,}$")

# French sources first: the point of the feed is what touches people here.
FEEDS = [
    ("Bonjour la fuite", "https://bonjourlafuite.eu.org/feed.xml", True),
    ("ZATAZ", "https://www.zataz.com/feed/", True),
    ("Numerama Cyberguerre", "https://www.numerama.com/cyberguerre/feed/", True),
    ("CERT-FR alertes", "https://www.cert.ssi.gouv.fr/alerte/feed/", True),
]

app = FastAPI(title="Cyberdeck · Leaks", docs_url=None, redoc_url=None)


def api_key() -> str:
    return os.environ.get("HIBP_API_KEY", "").strip()


class TTLCache:
    def __init__(self) -> None:
        self.items: dict[str, tuple[float, Any]] = {}

    def get(self, key: str):
        hit = self.items.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
        self.items.pop(key, None)
        return None

    def put(self, key: str, value: Any, ttl: int) -> Any:
        self.items[key] = (time.time() + ttl, value)
        return value


cache = TTLCache()
lookups: dict[str, list[float]] = {}   # per-IP timestamps, protects the paid key


def rate_limited(ip: str, per_minute: int = 12) -> bool:
    now = time.time()
    hits = [t for t in lookups.get(ip, []) if now - t < 60]
    if len(hits) >= per_minute:
        lookups[ip] = hits
        return True
    hits.append(now)
    lookups[ip] = hits
    return False


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?")


async def fetch(url: str, headers: dict | None = None, timeout: float = 20.0) -> httpx.Response:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as c:
        return await c.get(url, headers={"user-agent": USER_AGENT, **(headers or {})})


# ---------------------------------------------------------------- catalogue & feed

async def all_breaches() -> list[dict]:
    hit = cache.get("breaches")
    if hit is not None:
        return hit
    r = await fetch(f"{HIBP}/breaches")
    r.raise_for_status()
    return cache.put("breaches", r.json(), FEED_TTL)


async def one_feed(name: str, url: str, french: bool) -> tuple[list[dict], str | None]:
    try:
        r = await fetch(url, headers={"accept": "application/rss+xml, application/xml, text/xml"})
        r.raise_for_status()
        return parse_rss(r.text, name, french), None
    except Exception as exc:  # noqa: BLE001 - one dead source must not kill the feed
        return [], f"{name}: {exc.__class__.__name__}"


@app.get("/leaks/api/feed")
async def feed():
    hit = cache.get("feed")
    if hit is not None:
        return hit
    results = await asyncio.gather(*(one_feed(n, u, f) for n, u, f in FEEDS), all_breaches(), return_exceptions=True)
    items, errors = [], []
    for res in results[:-1]:
        lst, err = res
        items.extend(lst)
        if err:
            errors.append(err)
    breaches = results[-1]
    if isinstance(breaches, Exception):
        errors.append(f"Have I Been Pwned: {breaches.__class__.__name__}")
        hibp_items = []
    else:
        hibp_items = breaches_as_feed(breaches)
    merged = merge(items, hibp_items)
    payload = {
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sources": [n for n, _, _ in FEEDS] + ["Have I Been Pwned"],
        "errors": errors,
        "french": [i for i in merged if i["french"]][:80],
        "world": merged[:120],
    }
    return cache.put("feed", payload, FEED_TTL)


@app.get("/leaks/api/status")
async def status():
    return {"hibp_key": bool(api_key()), "feed_ttl": FEED_TTL}


# ---------------------------------------------------------------- e-mail lookup

@app.get("/leaks/api/check")
async def check(request: Request, email: str = Query(..., min_length=3, max_length=320)):
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "adresse e-mail invalide")
    if not api_key():
        return JSONResponse(status_code=503, content={
            "error": "Aucune clé HIBP configurée sur ce deck.",
            "hint": "Ajoute HIBP_API_KEY dans le .env du conteneur (clé à prendre sur haveibeenpwned.com/API/Key). Le fil d'actualité et le test de mot de passe fonctionnent sans.",
        })
    hit = cache.get(f"check:{email}")
    if hit is not None:
        return hit
    if rate_limited(client_ip(request)):
        raise HTTPException(429, "trop de recherches à la suite, attends une minute")
    headers = {"hibp-api-key": api_key()}
    breaches, pastes = await asyncio.gather(
        fetch(f"{HIBP}/breachedaccount/{email}?truncateResponse=false&includeUnverified=true", headers),
        fetch(f"{HIBP}/pasteaccount/{email}", headers),
    )
    if breaches.status_code == 401:
        raise HTTPException(502, "clé HIBP refusée (401) : vérifie HIBP_API_KEY")
    if breaches.status_code == 429:
        raise HTTPException(429, f"quota HIBP atteint, réessaie dans {breaches.headers.get('retry-after', '?')} s")
    if breaches.status_code not in (200, 404):
        raise HTTPException(502, f"HIBP a répondu {breaches.status_code}")
    found = [normalise_breach(b) for b in breaches.json()] if breaches.status_code == 200 else []
    found.sort(key=lambda b: b["breach_date"], reverse=True)
    paste_list = []
    if pastes.status_code == 200:
        for p in pastes.json():
            paste_list.append({"source": p.get("Source"), "id": p.get("Id"), "title": p.get("Title") or "", "date": p.get("Date") or "", "count": p.get("EmailCount", 0)})
    payload = {
        "email": email,
        "breaches": found,
        "pastes": paste_list,
        "french": [b for b in found if b["french"]],
        "data_classes": sorted({c for b in found for c in b["data_classes"]}),
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return cache.put(f"check:{email}", payload, CHECK_TTL)


# ---------------------------------------------------------------- password k-anonymity

@app.get("/leaks/api/password-range/{prefix}")
async def password_range(prefix: str):
    prefix = prefix.upper()
    if not re.fullmatch(r"[0-9A-F]{5}", prefix):
        raise HTTPException(400, "préfixe SHA-1 de 5 caractères hexadécimaux attendu")
    hit = cache.get(f"range:{prefix}")
    if hit is not None:
        return hit
    r = await fetch(f"{PWNED}/{prefix}", headers={"Add-Padding": "true"})
    r.raise_for_status()
    suffixes = {}
    for line in r.text.splitlines():
        if ":" in line:
            sfx, count = line.split(":", 1)
            if count.strip() != "0":   # padding entries carry a zero count
                suffixes[sfx.strip().upper()] = int(count)
    return cache.put(f"range:{prefix}", {"prefix": prefix, "suffixes": suffixes}, 3600)


@app.get("/leaks/api/health")
async def health():
    return {"ok": True, "cached": len(cache.items)}
