import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app import app, extract_bits, knockout

client = TestClient(app)


def png_bytes(arr, mode="RGBA"):
    buf = io.BytesIO()
    Image.fromarray(arr, mode).save(buf, format="PNG")
    return buf.getvalue()


def upload(arr, mode="RGBA", name="t.png"):
    r = client.post("/alpha/api/images", files={"file": (name, png_bytes(arr, mode), "image/png")})
    assert r.status_code == 200, r.text
    return r.json()


def test_upload_reports_alpha_stats():
    arr = np.zeros((4, 4, 4), dtype=np.uint8)
    arr[..., :3] = 100
    arr[..., 3] = 255
    arr[0, 0, 3] = 0          # one fully transparent pixel hiding a colour
    arr[0, 0, :3] = (1, 2, 3)
    arr[1, 1, 3] = 128        # one partial
    info = upload(arr)
    assert info["has_alpha"] is True
    assert info["alpha"] == {"min": 0, "max": 255, "unique_values": 3, "transparent_pixels": 1, "partial_pixels": 1, "opaque_pixels": 14}
    assert info["hidden_in_transparent"] == {"pixels": 1, "distinct_colors": 1}
    assert info["width"] == 4 and info["height"] == 4


def test_views_return_png():
    arr = np.random.default_rng(1).integers(0, 256, (8, 6, 4), dtype=np.uint8)
    key = upload(arr)["id"]
    for params in (
        {"mode": "original"}, {"mode": "channel", "channel": "a"}, {"mode": "alpha_mask"},
        {"mode": "opaque"}, {"mode": "rgb"}, {"mode": "bitplane", "channel": "r", "bit": 0},
        {"mode": "lsb_amplified"}, {"mode": "channel", "channel": "g", "invert": "true"},
    ):
        r = client.get(f"/alpha/api/images/{key}/view", params=params)
        assert r.status_code == 200, params
        assert r.headers["content-type"] == "image/png"
        assert Image.open(io.BytesIO(r.content)).size == (6, 8)
    assert client.get(f"/alpha/api/images/{key}/view", params={"mode": "nope"}).status_code == 400


def test_bitplane_matches_numpy():
    arr = np.zeros((2, 2, 4), dtype=np.uint8)
    arr[..., 3] = 255
    arr[0, 0, 0] = 0b00000001
    arr[1, 1, 0] = 0b00000010
    key = upload(arr)["id"]
    r = client.get(f"/alpha/api/images/{key}/view", params={"mode": "bitplane", "channel": "r", "bit": 0})
    plane = np.asarray(Image.open(io.BytesIO(r.content)))
    assert plane.tolist() == [[255, 0], [0, 0]]
    r = client.get(f"/alpha/api/images/{key}/view", params={"mode": "bitplane", "channel": "r", "bit": 1})
    assert np.asarray(Image.open(io.BytesIO(r.content))).tolist() == [[0, 0], [0, 255]]


def test_lsb_roundtrip():
    # hide the ASCII of "Hi!" in the LSB of R,G,B in row order
    secret = b"Hi!"
    bits = [(byte >> i) & 1 for byte in secret for i in range(7, -1, -1)]
    arr = np.full((2, 4, 4), 200, dtype=np.uint8)  # 8 pixels * 3 channels = 24 bits
    arr[..., 3] = 255
    flat = arr[..., :3].reshape(-1)
    for i, b in enumerate(bits):
        flat[i] = (flat[i] & 0xFE) | b
    arr[..., :3] = flat.reshape(2, 4, 3)
    assert extract_bits(arr, "rgb", 1, "row")[:3] == secret
    key = upload(arr)["id"]
    out = client.get(f"/alpha/api/images/{key}/lsb", params={"channels": "rgb", "bits": 1}).json()
    assert bytes.fromhex(out["hex"])[:3] == secret
    assert out["total_bytes"] == 3
    raw = client.get(f"/alpha/api/images/{key}/lsb", params={"channels": "rgb", "bits": 1, "raw": "true"})
    assert raw.content == secret


def test_rejects_garbage_and_forgets():
    r = client.post("/alpha/api/images", files={"file": ("x.png", b"not an image", "image/png")})
    assert r.status_code == 400
    arr = np.zeros((2, 2, 3), dtype=np.uint8)
    key = upload(arr, mode="RGB")["id"]
    assert client.delete(f"/alpha/api/images/{key}").status_code == 200
    assert client.get(f"/alpha/api/images/{key}/view").status_code == 404


def test_knockout_makes_colour_transparent():
    arr = np.zeros((2, 3, 4), dtype=np.uint8)
    arr[..., 3] = 255
    arr[0, 0, :3] = (255, 255, 255)   # pure white
    arr[0, 1, :3] = (235, 235, 235)   # near white
    arr[0, 2, :3] = (200, 200, 200)   # grey, outside tolerance
    arr[1, :, :3] = (10, 200, 30)
    out = knockout(arr, (255, 255, 255), 30, soft=False)
    assert out[0, 0, 3] == 0 and out[0, 1, 3] == 0
    assert out[0, 2, 3] == 255 and out[1, 0, 3] == 255
    assert out[..., :3].tolist() == arr[..., :3].tolist()   # colours untouched
    soft = knockout(arr, (255, 255, 255), 30, soft=True)
    assert soft[0, 0, 3] == 0 and 0 < soft[0, 1, 3] < 255 and soft[0, 2, 3] == 255

    key = upload(arr)["id"]
    r = client.get(f"/alpha/api/images/{key}/knockout", params={"color": "black", "tolerance": 40, "download": "true"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert "attachment" in r.headers["content-disposition"]
    png = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGBA"))
    assert png.shape == (2, 3, 4) and png[1, 0, 3] == 255   # green stays; nothing was black here
    assert client.get(f"/alpha/api/images/{key}/knockout", params={"color": "zz"}).status_code == 400
    r = client.get(f"/alpha/api/images/{key}/knockout", params={"color": "#0ac81e", "tolerance": 0, "soft": "false"})
    png = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGBA"))
    assert png[1, :, 3].tolist() == [0, 0, 0] and png[0, 2, 3] == 255
