"""Mirage API: upload an image or a video (or give a URL), get the evidence.

Nothing is kept: the file lives in a temp folder for the duration of the
analysis. The optional statistical score calls Sightengine with the keys in
SIGHTENGINE_USER / SIGHTENGINE_SECRET; without them, evidence only.
"""
from __future__ import annotations

import ipaddress
import os
import re
import shutil
import socket
import tempfile
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from analysis import IMAGE_EXT, VIDEO_EXT, analyse

MAX_IMAGE = 60 * 1024 * 1024
MAX_VIDEO = 300 * 1024 * 1024
SIGHTENGINE = "https://api.sightengine.com/1.0/check.json"
USER_AGENT = "Mozilla/5.0 (compatible; cyberdeck-mirage/1.0)"

app = FastAPI(title="Cyberdeck · Mirage", docs_url=None, redoc_url=None)


def se_keys() -> tuple[str, str]:
    return os.environ.get("SIGHTENGINE_USER", "").strip(), os.environ.get("SIGHTENGINE_SECRET", "").strip()


def sightengine(paths: list[str]) -> float | None:
    """Average 'ai_generated' probability over the given images."""
    user, secret = se_keys()
    if not user or not secret or not paths:
        return None
    scores = []
    with httpx.Client(timeout=60.0) as c:
        for p in paths[:3]:
            with open(p, "rb") as fh:
                r = c.post(SIGHTENGINE, data={"models": "genai", "api_user": user, "api_secret": secret}, files={"media": (os.path.basename(p), fh, "image/jpeg")})
            body = r.json()
            if body.get("status") != "success":
                raise RuntimeError(body.get("error", {}).get("message") or f"Sightengine a répondu {r.status_code}")
            scores.append(float(body.get("type", {}).get("ai_generated", 0)))
    return sum(scores) / len(scores) if scores else None


def scorer():
    return sightengine if all(se_keys()) else None


def private_host(host: str) -> bool:
    if host in ("localhost",) or host.endswith(".local") or host.endswith(".internal"):
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified:
            return True
    return False


def run(path: str, filename: str, workdir: str) -> dict:
    try:
        return analyse(path, filename, workdir, scorer())
    except ValueError as exc:
        raise HTTPException(415, str(exc))


@app.get("/mirage/api/status")
async def status():
    return {"score": all(se_keys()), "max_image": MAX_IMAGE, "max_video": MAX_VIDEO, "exiftool": bool(shutil.which("exiftool")), "ffmpeg": bool(shutil.which("ffmpeg"))}


@app.post("/mirage/api/analyse")
async def analyse_upload(file: UploadFile = File(...)):
    name = os.path.basename(file.filename or "media")
    ext = os.path.splitext(name.lower())[1]
    if ext not in IMAGE_EXT | VIDEO_EXT:
        raise HTTPException(415, "image (jpg, png, webp, heic, tiff, avif, gif) ou vidéo (mp4, mov, webm, mkv, avi) attendue")
    limit = MAX_VIDEO if ext in VIDEO_EXT else MAX_IMAGE
    workdir = tempfile.mkdtemp(prefix="mirage-")
    try:
        path = os.path.join(workdir, "media" + ext)
        size = 0
        with open(path, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"{limit // (1024 * 1024)} Mo maximum pour ce type de fichier")
                out.write(chunk)
        if size == 0:
            raise HTTPException(400, "fichier vide")
        return run(path, name, workdir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@app.post("/mirage/api/fetch")
async def analyse_url(body: dict):
    url = str(body.get("url") or "").strip()
    if not re.match(r"^https?://", url, re.I):
        raise HTTPException(400, "URL http(s) attendue")
    host = urlparse(url).hostname or ""
    if not host or private_host(host):
        raise HTTPException(400, "adresse locale refusée : dépose le fichier directement")
    workdir = tempfile.mkdtemp(prefix="mirage-")
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True, headers={"user-agent": USER_AGENT}) as c:
            async with c.stream("GET", url) as r:
                if r.status_code != 200:
                    raise HTTPException(502, f"le site a répondu {r.status_code}")
                ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
                name = os.path.basename(urlparse(str(r.url)).path) or "media"
                ext = os.path.splitext(name.lower())[1]
                if ext not in IMAGE_EXT | VIDEO_EXT:
                    ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/heic": ".heic",
                           "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm"}.get(ctype, "")
                    name = name + ext
                if not ext:
                    raise HTTPException(415, f"ce lien ne renvoie ni une image ni une vidéo ({ctype or 'type inconnu'})")
                limit = MAX_VIDEO if ext in VIDEO_EXT else MAX_IMAGE
                path = os.path.join(workdir, "media" + ext)
                size = 0
                with open(path, "wb") as out:
                    async for chunk in r.aiter_bytes(1024 * 1024):
                        size += len(chunk)
                        if size > limit:
                            raise HTTPException(413, f"{limit // (1024 * 1024)} Mo maximum")
                        out.write(chunk)
        return run(path, name, workdir)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"téléchargement impossible : {exc.__class__.__name__}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@app.get("/mirage/api/health")
async def health():
    return {"ok": True}


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
