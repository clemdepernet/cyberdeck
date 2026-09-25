"""Verdict: one thing to check (hash, URL, domain, IP or a file), one readable
VirusTotal report.

The key stays on the server (VT_API_KEY); the browser only talks to this API.
Results are cached in memory for a few minutes to spare the public quota
(4 requests per minute, 500 per day on a free key).
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import os
import re
import time
from typing import Any

import httpx
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse

VT = "https://www.virustotal.com/api/v3"
GUI = "https://www.virustotal.com/gui"
USER_AGENT = "cyberdeck-verdict/1.0 (+https://github.com/clemdepernet/cyberdeck)"
LOOKUP_TTL = int(os.environ.get("LOOKUP_TTL", 600))
MAX_UPLOAD = 32 * 1024 * 1024
HASH_RE = re.compile(r"^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$")
DOMAIN_RE = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", re.I)

app = FastAPI(title="Cyberdeck · Verdict", docs_url=None, redoc_url=None)


def api_key() -> str:
    return os.environ.get("VT_API_KEY", "").strip()


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
hits: dict[str, list[float]] = {}


def rate_limited(ip: str, per_minute: int = 8) -> bool:
    now = time.time()
    recent = [t for t in hits.get(ip, []) if now - t < 60]
    if len(recent) >= per_minute:
        hits[ip] = recent
        return True
    recent.append(now)
    hits[ip] = recent
    return False


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?")


async def request_vt(method: str, path: str, **kw) -> httpx.Response:
    """Single choke point for the network, monkeypatched in tests."""
    async with httpx.AsyncClient(timeout=kw.pop("timeout", 60.0)) as c:
        return await c.request(method, f"{VT}{path}", headers={"x-apikey": api_key(), "user-agent": USER_AGENT}, **kw)


# ---------------------------------------------------------------- classify the query

def url_id(url: str) -> str:
    return base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")


def classify(q: str) -> tuple[str, str]:
    """Returns (type, canonical value). type ∈ file · ip · domain · url."""
    q = q.strip()
    if not q:
        raise HTTPException(400, "rien à analyser")
    if HASH_RE.match(q):
        return "file", q.lower()
    try:
        return "ip", str(ipaddress.ip_address(q))
    except ValueError:
        pass
    if re.match(r"^[a-z][a-z0-9+.-]*://", q, re.I):
        return "url", q
    host = re.split(r"[/?#:]", q, 1)[0]
    if host != q or q.lower().startswith("www."):
        try:
            ipaddress.ip_address(host)
            return "url", "http://" + q
        except ValueError:
            if DOMAIN_RE.match(host):
                return "url", "http://" + q
            raise HTTPException(400, "ça ressemble à une URL, mais l'hôte n'est ni un domaine ni une IP")
    if DOMAIN_RE.match(q):
        return "domain", q.lower()
    raise HTTPException(400, "ni un hash (MD5, SHA-1, SHA-256), ni une IP, ni un domaine, ni une URL")


def vt_path(kind: str, value: str) -> str:
    return {"file": f"/files/{value}", "ip": f"/ip_addresses/{value}", "domain": f"/domains/{value}", "url": f"/urls/{url_id(value)}"}[kind]


def permalink(kind: str, ident: str) -> str:
    return {"file": f"{GUI}/file/{ident}", "ip": f"{GUI}/ip-address/{ident}", "domain": f"{GUI}/domain/{ident}", "url": f"{GUI}/url/{ident}"}[kind]


# ---------------------------------------------------------------- normalise the report

def ts(value) -> str | None:
    if not value:
        return None
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(value)))
    except (TypeError, ValueError, OverflowError):
        return None


def engines_of(attrs: dict) -> list[dict]:
    order = {"malicious": 0, "suspicious": 1, "harmless": 3, "undetected": 4, "timeout": 5, "type-unsupported": 6, "failure": 6}
    out = []
    for name, r in (attrs.get("last_analysis_results") or {}).items():
        out.append({
            "engine": r.get("engine_name") or name,
            "category": r.get("category") or "undetected",
            "result": r.get("result") or "",
            "method": r.get("method") or "",
            "version": r.get("engine_version") or "",
            "update": r.get("engine_update") or "",
        })
    out.sort(key=lambda e: (order.get(e["category"], 2), e["engine"].lower()))
    return out


def stats_of(attrs: dict) -> dict:
    s = attrs.get("last_analysis_stats") or {}
    keys = ("malicious", "suspicious", "harmless", "undetected", "timeout")
    return {k: int(s.get(k) or 0) for k in keys}


def meta_file(a: dict) -> dict:
    sig = a.get("signature_info") or {}
    ptc = a.get("popular_threat_classification") or {}
    return {
        "names": (a.get("names") or [])[:8],
        "size": a.get("size"),
        "type": a.get("type_description") or a.get("type_tag"),
        "magic": a.get("magic"),
        "md5": a.get("md5"), "sha1": a.get("sha1"), "sha256": a.get("sha256"),
        "first_seen": ts(a.get("first_submission_date")),
        "last_seen": ts(a.get("last_submission_date")),
        "times_submitted": a.get("times_submitted"),
        "threat_label": ptc.get("suggested_threat_label"),
        "threat_categories": [c.get("value") for c in ptc.get("popular_threat_category") or [] if c.get("value")],
        "threat_names": [c.get("value") for c in ptc.get("popular_threat_name") or [] if c.get("value")],
        "signed_by": sig.get("signers") or sig.get("product") or None,
        "type_tags": a.get("type_tags") or [],
    }


def meta_ip(a: dict) -> dict:
    return {
        "owner": a.get("as_owner"), "asn": a.get("asn"), "country": a.get("country"),
        "network": a.get("network"), "rir": a.get("regional_internet_registry"),
        "continent": a.get("continent"),
        "whois_date": ts(a.get("whois_date")),
        "whois": (a.get("whois") or "")[:1500],
    }


def dns_records(a: dict) -> list[dict]:
    out = []
    for r in a.get("last_dns_records") or []:
        if r.get("type") in ("A", "AAAA", "MX", "NS", "CNAME", "TXT", "SOA"):
            out.append({"type": r.get("type"), "value": str(r.get("value") or "")[:200], "ttl": r.get("ttl")})
    return out[:30]


def meta_domain(a: dict) -> dict:
    return {
        "registrar": a.get("registrar"),
        "created": ts(a.get("creation_date")),
        "updated": ts(a.get("last_update_date")),
        "expires": ts(a.get("expiration_date")),
        "popularity": {k: v.get("rank") for k, v in (a.get("popularity_ranks") or {}).items() if isinstance(v, dict)},
        "dns": dns_records(a),
        "whois_date": ts(a.get("whois_date")),
        "whois": (a.get("whois") or "")[:1500],
    }


def meta_url(a: dict) -> dict:
    return {
        "url": a.get("url"),
        "final_url": a.get("last_final_url"),
        "title": a.get("title"),
        "http_code": a.get("last_http_response_code"),
        "content_length": a.get("last_http_response_content_length"),
        "content_type": (a.get("last_http_response_headers") or {}).get("Content-Type") or (a.get("last_http_response_headers") or {}).get("content-type"),
        "first_seen": ts(a.get("first_submission_date")),
        "last_seen": ts(a.get("last_submission_date")),
        "times_submitted": a.get("times_submitted"),
        "threat_names": a.get("threat_names") or [],
        "redirects": (a.get("redirection_chain") or [])[:10],
        "outgoing_links": (a.get("outgoing_links") or [])[:10],
    }


def normalise(kind: str, value: str, obj: dict) -> dict:
    a = obj.get("attributes") or {}
    ident = obj.get("id") or value
    votes = a.get("total_votes") or {}
    stats = stats_of(a)
    meta = {"file": meta_file, "ip": meta_ip, "domain": meta_domain, "url": meta_url}[kind](a)
    return {
        "found": True,
        "type": kind,
        "query": value,
        "id": ident,
        "permalink": permalink(kind, ident),
        "stats": stats,
        "total": sum(stats.values()),
        "last_analysis": ts(a.get("last_analysis_date")),
        "reputation": a.get("reputation"),
        "votes": {"harmless": int(votes.get("harmless") or 0), "malicious": int(votes.get("malicious") or 0)},
        "tags": (a.get("tags") or [])[:20],
        "categories": a.get("categories") or {},
        "meta": meta,
        "engines": engines_of(a),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def vt_error(r: httpx.Response) -> HTTPException:
    if r.status_code == 401:
        return HTTPException(502, "clé VirusTotal refusée (401) : vérifie VT_API_KEY")
    if r.status_code == 429:
        return HTTPException(429, "quota VirusTotal atteint (4 requêtes/min, 500/jour sur une clé gratuite) : attends un peu")
    try:
        msg = r.json().get("error", {}).get("message") or ""
    except Exception:  # noqa: BLE001
        msg = ""
    return HTTPException(502, f"VirusTotal a répondu {r.status_code}{' : ' + msg if msg else ''}")


def need_key():
    if not api_key():
        raise HTTPException(503, "Aucune clé VirusTotal configurée : ajoute VT_API_KEY dans le .env du conteneur (clé gratuite sur virustotal.com, menu API key).")


# ---------------------------------------------------------------- routes

@app.get("/verdict/api/status")
async def status():
    return {"vt_key": bool(api_key()), "max_upload": MAX_UPLOAD, "lookup_ttl": LOOKUP_TTL}


@app.get("/verdict/api/lookup")
async def lookup(request: Request, q: str = Query(..., min_length=1, max_length=2048)):
    need_key()
    kind, value = classify(q)
    key = f"{kind}:{value}"
    hit = cache.get(key)
    if hit is not None:
        return hit
    if rate_limited(client_ip(request)):
        raise HTTPException(429, "trop de recherches à la suite, attends une minute")
    r = await request_vt("GET", vt_path(kind, value))
    if r.status_code == 404:
        payload = {"found": False, "type": kind, "query": value, "can_submit": kind == "url",
                   "hint": {"file": "Ce hash est inconnu de VirusTotal. Dépose le fichier lui-même pour le faire analyser.",
                            "url": "Cette URL n'a jamais été analysée. Tu peux la soumettre.",
                            "domain": "Domaine inconnu de VirusTotal.",
                            "ip": "Adresse inconnue de VirusTotal."}[kind]}
        return cache.put(key, payload, 60)
    if r.status_code != 200:
        raise vt_error(r)
    return cache.put(key, normalise(kind, value, r.json().get("data") or {}), LOOKUP_TTL)


@app.post("/verdict/api/scan/url")
async def scan_url(request: Request, body: dict):
    need_key()
    kind, value = classify(str(body.get("url") or ""))
    if kind != "url":
        raise HTTPException(400, "une URL est attendue")
    if rate_limited(client_ip(request)):
        raise HTTPException(429, "trop de soumissions à la suite, attends une minute")
    r = await request_vt("POST", "/urls", data={"url": value})
    if r.status_code != 200:
        raise vt_error(r)
    cache.items.pop(f"url:{value}", None)
    return {"analysis_id": (r.json().get("data") or {}).get("id"), "type": "url", "query": value}


@app.post("/verdict/api/scan/file")
async def scan_file(request: Request, file: UploadFile = File(...)):
    need_key()
    if rate_limited(client_ip(request), per_minute=4):
        raise HTTPException(429, "trop d'envois à la suite, attends une minute")
    blob = await file.read(MAX_UPLOAD + 1)
    if len(blob) > MAX_UPLOAD:
        raise HTTPException(413, "32 Mo maximum via l'API publique")
    if not blob:
        raise HTTPException(400, "fichier vide")
    sha256 = hashlib.sha256(blob).hexdigest()
    # Known already? Then no need to ship the bytes anywhere.
    known = await request_vt("GET", f"/files/{sha256}")
    if known.status_code == 200:
        return {"known": True, "type": "file", "query": sha256, "report": cache.put(f"file:{sha256}", normalise("file", sha256, known.json().get("data") or {}), LOOKUP_TTL)}
    r = await request_vt("POST", "/files", files={"file": (file.filename or "upload.bin", blob, file.content_type or "application/octet-stream")}, timeout=180.0)
    if r.status_code != 200:
        raise vt_error(r)
    return {"known": False, "analysis_id": (r.json().get("data") or {}).get("id"), "type": "file", "query": sha256, "name": file.filename}


@app.get("/verdict/api/analysis/{analysis_id}")
async def analysis(analysis_id: str):
    need_key()
    if not re.fullmatch(r"[A-Za-z0-9_=-]{8,200}", analysis_id):
        raise HTTPException(400, "identifiant d'analyse invalide")
    r = await request_vt("GET", f"/analyses/{analysis_id}")
    if r.status_code != 200:
        raise vt_error(r)
    data = r.json()
    attrs = (data.get("data") or {}).get("attributes") or {}
    meta = data.get("meta") or {}
    item = None
    if meta.get("url_info", {}).get("url"):
        item = meta["url_info"]["url"]
    elif meta.get("file_info", {}).get("sha256"):
        item = meta["file_info"]["sha256"]
    return {"status": attrs.get("status"), "stats": attrs.get("stats") or {}, "item": item}


@app.get("/verdict/api/health")
async def health():
    return {"ok": True, "cached": len(cache.items)}


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
