import json
import os
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

import analysis
import app as mirage

client = TestClient(mirage.app)
HAVE_EXIFTOOL = bool(shutil.which("exiftool"))
HAVE_FFMPEG = bool(shutil.which("ffmpeg"))


def png(path, size=(1024, 1024), text=None):
    img = Image.new("RGB", size, (90, 120, 200))
    info = PngImagePlugin.PngInfo()
    for k, v in (text or {}).items():
        info.add_text(k, v)
    img.save(path, pnginfo=info)
    return path


def jpg(path, size=(4032, 3024)):
    Image.new("RGB", size, (120, 90, 40)).save(path, quality=90)
    return path


def upload(path):
    with open(path, "rb") as fh:
        return client.post("/mirage/api/analyse", files={"file": (os.path.basename(path), fh, "application/octet-stream")})


@pytest.mark.skipif(not HAVE_EXIFTOOL, reason="exiftool needed")
def test_stable_diffusion_png_is_proof(tmp_path):
    p = png(tmp_path / "gen.png", text={"parameters": "a cat, masterpiece\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 1, Model: juggernautXL"})
    r = upload(p)
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["kind"] == "image" and b["verdict"]["level"] == "ai"
    ids = [s["id"] for s in b["signals"]]
    assert "sd-params" in ids and "juggernautXL" in next(s["detail"] for s in b["signals"] if s["id"] == "sd-params")
    assert "dims" in ids   # 1024x1024 flagged as a weak hint too
    assert b["preview"].startswith("data:image/jpeg")


@pytest.mark.skipif(not HAVE_EXIFTOOL, reason="exiftool needed")
def test_comfyui_and_novelai(tmp_path):
    p = png(tmp_path / "comfy.png", size=(640, 480), text={"workflow": json.dumps({"nodes": [{"type": "KSampler"}]}), "prompt": json.dumps({"3": {"class_type": "KSampler"}})})
    b = upload(p).json()
    assert b["verdict"]["level"] == "ai" and any(s["id"] == "comfy" for s in b["signals"])
    p = png(tmp_path / "nai.png", size=(640, 480), text={"Comment": json.dumps({"prompt": "x", "steps": 28, "sampler": "k_euler", "seed": 5}), "Software": "NovelAI"})
    b = upload(p).json()
    ids = [s["id"] for s in b["signals"]]
    assert "novelai" in ids and "gen-novelai" in ids


@pytest.mark.skipif(not HAVE_EXIFTOOL, reason="exiftool needed")
def test_iptc_source_type_and_camera(tmp_path):
    p = jpg(tmp_path / "ai.jpg", size=(1920, 1080))
    subprocess.run(["exiftool", "-overwrite_original", "-q", "-XMP-iptcExt:DigitalSourceType=http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia", str(p)], check=True)
    b = upload(p).json()
    assert b["verdict"]["level"] == "ai" and any(s["id"] == "iptc-ai" for s in b["signals"])
    p = jpg(tmp_path / "cam.jpg")
    subprocess.run(["exiftool", "-overwrite_original", "-q", "-Make=Canon", "-Model=Canon EOS R6", "-ExposureTime=1/250", "-FNumber=4", "-ISO=200", "-LensModel=RF 24-70mm", str(p)], check=True)
    b = upload(p).json()
    assert b["verdict"]["level"] == "camera"
    cam = next(s for s in b["signals"] if s["id"] == "camera")
    assert cam["strength"] == "auth" and "Canon EOS R6" in cam["detail"] and "f/4" in cam["detail"]
    assert b["file"]["make"] == "Canon" and b["file"]["iso"] == 200


@pytest.mark.skipif(not HAVE_EXIFTOOL, reason="exiftool needed")
def test_plain_jpeg_without_exif_is_unknown(tmp_path):
    b = upload(jpg(tmp_path / "plain.jpg", size=(3000, 2000))).json()
    assert b["verdict"]["level"] == "unknown"
    assert any(s["id"] == "no-exif" for s in b["signals"])
    assert b["c2pa"] is None and b["score"] is None


def test_sd_watermark_roundtrip(tmp_path):
    if analysis._dwt_module() is None:
        pytest.skip("imwatermark codec not installed")
    src = png(tmp_path / "src.png", size=(768, 512))
    dst = str(tmp_path / "wm.png")
    assert analysis.embed_sd_watermark(str(src), dst)
    wm = analysis.sd_watermark(dst)
    assert wm and wm["scheme"] == "SDV2"
    assert analysis.sd_watermark(str(src)) is None


@pytest.mark.skipif(not (HAVE_EXIFTOOL and HAVE_FFMPEG), reason="exiftool + ffmpeg needed")
def test_video_frames_and_score(tmp_path, monkeypatch):
    v = tmp_path / "clip.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-t", "2", "-pix_fmt", "yuv420p", str(v)], check=True)
    monkeypatch.setenv("SIGHTENGINE_USER", "u")
    monkeypatch.setenv("SIGHTENGINE_SECRET", "s")
    seen = []

    def fake(paths):
        seen.extend(paths)
        return 0.91

    monkeypatch.setattr(mirage, "sightengine", fake)
    b = upload(v).json()
    assert b["kind"] == "video" and b["frames"] == 3 and len(seen) == 3
    assert b["verdict"]["level"] == "likely" and b["score"] == 0.91
    assert any(s["id"] == "score" and s["strength"] == "strong" for s in b["signals"])
    assert b["file"]["duration"] and b["preview"]


def test_verdict_rules():
    v = analysis.verdict_of
    assert v([{"strength": "proof", "title": "X"}], None)["level"] == "ai"
    assert v([], 0.85)["level"] == "likely"
    assert v([], 0.6)["level"] == "hints"
    assert v([{"strength": "auth", "title": "Empreinte"}], None)["level"] == "camera"
    assert v([{"strength": "auth", "title": "Empreinte"}], 0.7)["level"] == "hints"
    assert v([{"strength": "weak", "title": "Dims"}], None)["level"] == "unknown"
    assert v([], None)["level"] == "unknown"


def test_upload_validation(tmp_path):
    assert client.post("/mirage/api/analyse", files={"file": ("x.exe", b"MZ", "application/octet-stream")}).status_code == 415
    assert client.post("/mirage/api/analyse", files={"file": ("x.png", b"", "image/png")}).status_code == 400
    assert client.post("/mirage/api/fetch", json={"url": "ftp://x"}).status_code == 400
    assert client.post("/mirage/api/fetch", json={"url": "http://localhost/x.png"}).status_code == 400
    assert client.get("/mirage/api/status").json()["score"] is False


def test_c2pa_store_parsing():
    store = {"active_manifest": "urn:uuid:1", "manifests": {"urn:uuid:1": {
        "claim_generator": "ChatGPT/1.0 c2pa-rs/0.31",
        "claim_generator_info": [{"name": "ChatGPT", "version": "1.0"}],
        "title": "image.png",
        "ingredients": [],
        "assertions": [{"label": "c2pa.actions.v2", "data": {"actions": [
            {"action": "c2pa.created", "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia", "softwareAgent": {"name": "DALL-E 3"}}]}}],
    }}, "validation_status": []}
    c = analysis.parse_store(store)
    assert c["present"] and c["valid"] and c["generator"] == "ChatGPT" and c["source_types"] == ["trainedAlgorithmicMedia"] and c["agents"] == ["DALL-E 3"]
    sig = analysis.signals_from_metadata({}, c, "image")
    assert sig[0]["id"] == "c2pa-ai" and sig[0]["strength"] == "proof" and "DALL-E 3" in sig[0]["detail"]
    assert analysis.verdict_of(sig, None)["level"] == "ai"
    cam = analysis.parse_store({"active_manifest": "a", "manifests": {"a": {"claim_generator": "Leica M11", "assertions": [{"label": "c2pa.actions", "data": {"actions": [{"action": "c2pa.created", "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"}]}}]}}, "validation_status": [{"code": "signingCredential.untrusted", "explanation": "x"}]})
    assert cam["valid"] is False and cam["source_types"] == ["digitalCapture"]
    sig = analysis.signals_from_metadata({}, cam, "image")
    assert sig[0]["id"] == "c2pa-camera" and "non vérifiée" in sig[0]["detail"]
    assert analysis.parse_store({}) is None
