"""Alpha: look at an image the way a stego challenge wants you to.

Upload once, then ask for views (alpha channel, one RGB channel, a single bit
plane, the picture with alpha forced opaque…) and LSB extractions. Images live
in memory with a short TTL: nothing is written to disk.
"""
from __future__ import annotations

import io
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass, field

import numpy as np
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 80_000_000
MAX_UPLOAD = int(os.environ.get("MAX_UPLOAD", 40 * 1024 * 1024))
TTL_SECONDS = int(os.environ.get("TTL_SECONDS", 30 * 60))
MAX_ITEMS = int(os.environ.get("MAX_ITEMS", 40))

CHANNELS = {"r": 0, "g": 1, "b": 2, "a": 3}
CHANNEL_NAMES = {"r": "Rouge", "g": "Vert", "b": "Bleu", "a": "Alpha"}


@dataclass
class Stored:
    rgba: np.ndarray            # H x W x 4 uint8
    info: dict
    created: float = field(default_factory=time.time)
    touched: float = field(default_factory=time.time)


class Cache:
    def __init__(self) -> None:
        self.items: dict[str, Stored] = {}
        self.lock = threading.Lock()

    def put(self, item: Stored) -> str:
        with self.lock:
            self._sweep()
            while len(self.items) >= MAX_ITEMS:
                oldest = min(self.items, key=lambda k: self.items[k].touched)
                del self.items[oldest]
            key = secrets.token_urlsafe(9)
            self.items[key] = item
            return key

    def get(self, key: str) -> Stored:
        with self.lock:
            self._sweep()
            item = self.items.get(key)
            if item is None:
                raise HTTPException(404, "image expired or unknown: upload it again")
            item.touched = time.time()
            return item

    def drop(self, key: str) -> None:
        with self.lock:
            self.items.pop(key, None)

    def _sweep(self) -> None:
        now = time.time()
        for k in [k for k, v in self.items.items() if now - v.touched > TTL_SECONDS]:
            del self.items[k]


cache = Cache()
app = FastAPI(title="Cyberdeck · Alpha", docs_url=None, redoc_url=None)


def analyse(img: Image.Image, raw_len: int, fmt: str | None) -> tuple[np.ndarray, dict]:
    mode = img.mode
    has_alpha = mode in ("RGBA", "LA", "PA") or (mode == "P" and "transparency" in img.info) or mode == "RGBa"
    rgba = np.asarray(ImageOps.exif_transpose(img).convert("RGBA"), dtype=np.uint8)
    a = rgba[..., 3]
    unique = np.unique(a)
    info = {
        "width": int(rgba.shape[1]),
        "height": int(rgba.shape[0]),
        "mode": mode,
        "format": fmt or "?",
        "bytes": raw_len,
        "has_alpha": bool(has_alpha),
        "alpha": {
            "min": int(a.min()),
            "max": int(a.max()),
            "unique_values": int(unique.size),
            "transparent_pixels": int((a == 0).sum()),
            "partial_pixels": int(((a > 0) & (a < 255)).sum()),
            "opaque_pixels": int((a == 255).sum()),
        },
        "channels": {
            name: {"min": int(rgba[..., i].min()), "max": int(rgba[..., i].max()), "unique_values": int(np.unique(rgba[..., i]).size)}
            for name, i in CHANNELS.items()
        },
        "metadata": {k: str(v)[:200] for k, v in img.info.items() if k not in ("exif", "icc_profile", "transparency") and isinstance(v, (str, int, float, bytes))},
    }
    return rgba, info


def hidden_in_transparent(rgba: np.ndarray) -> dict:
    """Do fully transparent pixels carry non-trivial RGB data? That is the classic hiding spot."""
    a = rgba[..., 3]
    mask = a == 0
    if not mask.any():
        return {"pixels": 0, "distinct_colors": 0}
    rgb = rgba[mask][:, :3]
    distinct = np.unique(rgb, axis=0).shape[0]
    return {"pixels": int(mask.sum()), "distinct_colors": int(distinct)}


@app.post("/alpha/api/images")
async def upload(file: UploadFile = File(...)):
    raw = await file.read()
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, f"image larger than {MAX_UPLOAD // (1024 * 1024)} MiB")
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"not an image Pillow can read: {exc}") from exc
    rgba, info = analyse(img, len(raw), img.format)
    info["hidden_in_transparent"] = hidden_in_transparent(rgba)
    key = cache.put(Stored(rgba=rgba, info=info))
    return {"id": key, "name": file.filename, **info}


def to_png(arr: np.ndarray, mode: str = "RGBA") -> Response:
    buf = io.BytesIO()
    Image.fromarray(arr, mode).save(buf, format="PNG", optimize=False, compress_level=3)
    return Response(buf.getvalue(), media_type="image/png", headers={"Cache-Control": "no-store"})


CHECKER = 16


def on_checkerboard(rgba: np.ndarray) -> np.ndarray:
    """Composite over a checkerboard so transparency is visible on any screen."""
    h, w = rgba.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    board = np.where(((yy // CHECKER) + (xx // CHECKER)) % 2 == 0, 200, 150).astype(np.float32)
    alpha = rgba[..., 3:4].astype(np.float32) / 255.0
    rgb = rgba[..., :3].astype(np.float32) * alpha + board[..., None] * (1 - alpha)
    return rgb.round().astype(np.uint8)


@app.get("/alpha/api/images/{key}/view")
def view(
    key: str,
    mode: str = Query("original"),
    channel: str = Query("a", pattern="^[rgba]$"),
    bit: int = Query(0, ge=0, le=7),
    invert: bool = False,
):
    st = cache.get(key)
    rgba = st.rgba
    c = CHANNELS[channel]
    if mode == "original":
        out = on_checkerboard(rgba)
        return to_png(255 - out if invert else out, "RGB")
    if mode == "channel":          # one channel as grayscale
        out = rgba[..., c]
    elif mode == "alpha_mask":     # where is transparency? red = fully transparent, amber = partial
        a = rgba[..., 3]
        out = (rgba[..., :3] * 0.35).astype(np.uint8)
        out[a == 0] = (229, 101, 79)
        out[(a > 0) & (a < 255)] = (242, 178, 78)
        return to_png(out, "RGB")
    elif mode == "opaque":         # force alpha to 255: reveals colours hidden under transparency
        out = rgba[..., :3].copy()
        return to_png(255 - out if invert else out, "RGB")
    elif mode == "rgb":            # drop alpha, keep colour
        out = rgba[..., :3].copy()
        return to_png(255 - out if invert else out, "RGB")
    elif mode == "bitplane":       # a single bit of one channel, as black/white
        out = ((rgba[..., c] >> bit) & 1).astype(np.uint8) * 255
    elif mode == "lsb_amplified":  # low 2 bits of every RGB channel, stretched to 0..255
        out = ((rgba[..., :3] & 0b11) * 85).astype(np.uint8)
        return to_png(255 - out if invert else out, "RGB")
    else:
        raise HTTPException(400, "unknown mode")
    if invert:
        out = 255 - out
    return to_png(np.ascontiguousarray(out), "L")


def extract_bits(rgba: np.ndarray, channels: str, bits: int, order: str) -> bytes:
    """Concatenate the `bits` lowest bits of the selected channels, pixel after pixel."""
    idx = [CHANNELS[ch] for ch in channels]
    planes = rgba[..., idx].reshape(-1, len(idx))          # N x k, row-major pixel order
    if order == "column":
        planes = rgba[..., idx].transpose(1, 0, 2).reshape(-1, len(idx))
    bit_list = []
    for b in range(bits - 1, -1, -1):
        bit_list.append(((planes >> b) & 1).astype(np.uint8))
    # shape: N x k x bits  -> flatten pixel by pixel, channel by channel, MSB-of-selected-bits first
    stacked = np.stack(bit_list, axis=-1).reshape(-1)
    usable = (stacked.size // 8) * 8
    return np.packbits(stacked[:usable]).tobytes()


PRINTABLE = re.compile(rb"[\x20-\x7e]{4,}")


@app.get("/alpha/api/images/{key}/lsb")
def lsb(
    key: str,
    channels: str = Query("rgb", pattern="^[rgba]{1,4}$"),
    bits: int = Query(1, ge=1, le=4),
    order: str = Query("row", pattern="^(row|column)$"),
    limit: int = Query(4096, ge=64, le=1_000_000),
    raw: bool = False,
):
    st = cache.get(key)
    data = extract_bits(st.rgba, channels, bits, order)
    if raw:
        return Response(data, media_type="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="lsb_{channels}_{bits}bit.bin"'})
    head = data[:limit]
    strings = [m.group().decode("ascii") for m in PRINTABLE.finditer(data[:min(len(data), 2_000_000)])][:200]
    magic = {
        b"PK\x03\x04": "zip", b"\x89PNG": "png", b"\xff\xd8\xff": "jpeg", b"GIF8": "gif", b"%PDF": "pdf",
        b"\x1f\x8b": "gzip", b"7z\xbc\xaf": "7z", b"Rar!": "rar", b"\x7fELF": "elf", b"MZ": "pe",
    }
    detected = next((name for sig, name in magic.items() if data.startswith(sig)), None)
    return {
        "channels": channels, "bits": bits, "order": order, "total_bytes": len(data),
        "hex": head.hex(), "ascii": head.decode("latin-1").translate(str.maketrans({chr(i): "." for i in list(range(0, 32)) + list(range(127, 256))})),
        "strings": strings, "detected": detected,
    }


def parse_hex(color: str) -> tuple[int, int, int]:
    named = {"black": "000000", "white": "ffffff"}
    color = named.get(color.lower(), color.lstrip("#"))
    if not re.fullmatch(r"[0-9a-fA-F]{6}", color):
        raise HTTPException(400, "color must be black, white or a #rrggbb value")
    return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)


def knockout(rgba: np.ndarray, color: tuple[int, int, int], tolerance: int, soft: bool) -> np.ndarray:
    """Turn every pixel close to `color` transparent.

    Distance is the max channel difference (0..255). With `soft`, pixels between
    tolerance/2 and tolerance fade out instead of a hard cut, which keeps
    anti-aliased edges clean on logos and screenshots.
    """
    out = rgba.copy()
    rgb = out[..., :3].astype(np.int16)
    dist = np.abs(rgb - np.array(color, dtype=np.int16)).max(axis=-1)
    if soft and tolerance > 0:
        lo = tolerance / 2
        factor = np.clip((dist - lo) / max(tolerance - lo, 1), 0, 1)
    else:
        factor = (dist > tolerance).astype(np.float32)
    out[..., 3] = (out[..., 3].astype(np.float32) * factor).round().astype(np.uint8)
    return out


@app.get("/alpha/api/images/{key}/knockout")
def knockout_view(
    key: str,
    color: str = Query("white"),
    tolerance: int = Query(30, ge=0, le=255),
    soft: bool = True,
    download: bool = False,
):
    st = cache.get(key)
    out = knockout(st.rgba, parse_hex(color), tolerance, soft)
    resp = to_png(out, "RGBA")
    if download:
        resp.headers["Content-Disposition"] = f'attachment; filename="transparent_{color.lstrip("#")}.png"'
    return resp


@app.delete("/alpha/api/images/{key}")
def forget(key: str):
    cache.drop(key)
    return JSONResponse({"ok": True}, status_code=200)


@app.get("/alpha/api/health")
def health():
    return {"ok": True, "cached": len(cache.items)}
