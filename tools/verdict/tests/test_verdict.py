import pytest
from fastapi.testclient import TestClient

import app as verdict
from app import classify, url_id

client = TestClient(verdict.app)


class FakeResponse:
    def __init__(self, status, body=None):
        self.status_code, self._body = status, body if body is not None else {}

    def json(self):
        return self._body


FILE_OBJ = {"id": "a" * 64, "type": "file", "attributes": {
    "names": ["evil.exe", "setup.exe"], "size": 1234, "type_description": "Win32 EXE", "md5": "m", "sha1": "s", "sha256": "a" * 64,
    "first_submission_date": 1700000000, "last_analysis_date": 1700003600, "times_submitted": 3, "reputation": -12, "tags": ["peexe", "overlay"],
    "total_votes": {"harmless": 1, "malicious": 7},
    "popular_threat_classification": {"suggested_threat_label": "trojan.agent/gen", "popular_threat_category": [{"value": "trojan", "count": 20}], "popular_threat_name": [{"value": "agent", "count": 9}]},
    "last_analysis_stats": {"malicious": 42, "suspicious": 1, "harmless": 0, "undetected": 20, "timeout": 1},
    "last_analysis_results": {
        "Zed": {"engine_name": "Zed", "category": "undetected", "result": None, "engine_update": "20260925"},
        "Alpha": {"engine_name": "Alpha", "category": "malicious", "result": "Trojan.Agent", "method": "blacklist", "engine_update": "20260925"},
        "Beta": {"engine_name": "Beta", "category": "suspicious", "result": "Heur.Gen"},
    },
}}


def test_classify():
    assert classify("D41D8CD98F00B204E9800998ECF8427E") == ("file", "d41d8cd98f00b204e9800998ecf8427e")
    assert classify("8.8.8.8") == ("ip", "8.8.8.8")
    assert classify("2001:db8::1") == ("ip", "2001:db8::1")
    assert classify("Example.COM") == ("domain", "example.com")
    assert classify("https://x.io/a?b=1") == ("url", "https://x.io/a?b=1")
    assert classify("x.io/login") == ("url", "http://x.io/login")
    assert classify("www.x.io") == ("url", "http://www.x.io")
    assert classify("10.0.0.1:8080/admin") == ("url", "http://10.0.0.1:8080/admin")
    for bad in ("", "not a thing", "a" * 300):
        with pytest.raises(Exception):
            classify(bad)
    assert url_id("http://x.io/") == "aHR0cDovL3guaW8v"


def test_without_key(monkeypatch):
    monkeypatch.delenv("VT_API_KEY", raising=False)
    r = client.get("/verdict/api/lookup", params={"q": "8.8.8.8"})
    assert r.status_code == 503 and "VT_API_KEY" in r.json()["error"]
    assert client.get("/verdict/api/status").json()["vt_key"] is False


def test_file_lookup_normalised_and_cached(monkeypatch):
    monkeypatch.setenv("VT_API_KEY", "k")
    calls = []

    async def fake(method, path, **kw):
        calls.append((method, path))
        return FakeResponse(200, {"data": FILE_OBJ})

    monkeypatch.setattr(verdict, "request_vt", fake)
    verdict.cache.items.clear(); verdict.hits.clear()
    r = client.get("/verdict/api/lookup", params={"q": "A" * 64})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["found"] and b["type"] == "file" and b["permalink"].endswith("/file/" + "a" * 64)
    assert b["stats"]["malicious"] == 42 and b["total"] == 64
    assert [e["engine"] for e in b["engines"]] == ["Alpha", "Beta", "Zed"]   # detections first
    assert b["meta"]["threat_label"] == "trojan.agent/gen" and b["meta"]["names"] == ["evil.exe", "setup.exe"]
    assert b["votes"] == {"harmless": 1, "malicious": 7} and b["last_analysis"] == "2023-11-14T23:13:20Z"
    assert calls == [("GET", "/files/" + "a" * 64)]
    client.get("/verdict/api/lookup", params={"q": "a" * 64})
    assert len(calls) == 1   # served from cache


def test_unknown_url_can_be_submitted(monkeypatch):
    monkeypatch.setenv("VT_API_KEY", "k")

    async def fake(method, path, **kw):
        if method == "GET" and path.startswith("/urls/"):
            return FakeResponse(404, {"error": {"code": "NotFoundError"}})
        if method == "POST" and path == "/urls":
            assert kw["data"] == {"url": "http://never-seen.example/x"}
            return FakeResponse(200, {"data": {"id": "u-abc123", "type": "analysis"}})
        if method == "GET" and path == "/analyses/u-abc123":
            return FakeResponse(200, {"data": {"attributes": {"status": "completed", "stats": {"malicious": 0}}}, "meta": {"url_info": {"url": "http://never-seen.example/x"}}})
        raise AssertionError((method, path))

    monkeypatch.setattr(verdict, "request_vt", fake)
    verdict.cache.items.clear(); verdict.hits.clear()
    r = client.get("/verdict/api/lookup", params={"q": "never-seen.example/x"})
    assert r.status_code == 200 and r.json() == {**r.json(), "found": False, "type": "url", "can_submit": True}
    r = client.post("/verdict/api/scan/url", json={"url": "never-seen.example/x"})
    assert r.status_code == 200 and r.json()["analysis_id"] == "u-abc123"
    r = client.get("/verdict/api/analysis/u-abc123")
    assert r.json() == {"status": "completed", "stats": {"malicious": 0}, "item": "http://never-seen.example/x"}
    assert client.get("/verdict/api/analysis/bad id!").status_code == 400


def test_domain_ip_and_errors(monkeypatch):
    monkeypatch.setenv("VT_API_KEY", "k")

    async def fake(method, path, **kw):
        if path == "/domains/example.com":
            return FakeResponse(200, {"data": {"id": "example.com", "attributes": {"registrar": "IANA", "creation_date": 808012800, "last_dns_records": [{"type": "A", "value": "93.184.216.34", "ttl": 60}, {"type": "HINFO", "value": "x"}], "popularity_ranks": {"Majestic": {"rank": 12}}, "categories": {"Vendor": "info tech"}, "last_analysis_stats": {"harmless": 60, "undetected": 10}}}})
        if path == "/ip_addresses/8.8.8.8":
            return FakeResponse(200, {"data": {"id": "8.8.8.8", "attributes": {"as_owner": "GOOGLE", "asn": 15169, "country": "US", "last_analysis_stats": {"harmless": 70}}}})
        if path == "/ip_addresses/1.1.1.1":
            return FakeResponse(429, {})
        if path == "/ip_addresses/2.2.2.2":
            return FakeResponse(401, {})
        raise AssertionError(path)

    monkeypatch.setattr(verdict, "request_vt", fake)
    verdict.cache.items.clear(); verdict.hits.clear()
    d = client.get("/verdict/api/lookup", params={"q": "example.com"}).json()
    assert d["meta"]["registrar"] == "IANA" and d["meta"]["created"] == "1995-08-10T00:00:00Z"
    assert d["meta"]["dns"] == [{"type": "A", "value": "93.184.216.34", "ttl": 60}] and d["meta"]["popularity"] == {"Majestic": 12}
    assert d["categories"] == {"Vendor": "info tech"} and d["stats"]["harmless"] == 60
    ip = client.get("/verdict/api/lookup", params={"q": "8.8.8.8"}).json()
    assert ip["meta"]["owner"] == "GOOGLE" and ip["meta"]["asn"] == 15169
    assert client.get("/verdict/api/lookup", params={"q": "1.1.1.1"}).status_code == 429
    assert client.get("/verdict/api/lookup", params={"q": "2.2.2.2"}).status_code == 502
    assert client.get("/verdict/api/lookup", params={"q": "???"}).status_code == 400


def test_file_upload_short_circuits_known_hash(monkeypatch):
    monkeypatch.setenv("VT_API_KEY", "k")
    posted = []

    async def fake(method, path, **kw):
        if method == "GET" and path.startswith("/files/"):
            return FakeResponse(200, {"data": FILE_OBJ}) if path.endswith("known") else FakeResponse(404, {})
        if method == "POST" and path == "/files":
            posted.append(kw["files"]["file"][0])
            return FakeResponse(200, {"data": {"id": "f-1"}})
        raise AssertionError((method, path))

    monkeypatch.setattr(verdict, "request_vt", fake)
    verdict.cache.items.clear(); verdict.hits.clear()
    r = client.post("/verdict/api/scan/file", files={"file": ("sample.bin", b"hello", "application/octet-stream")})
    assert r.status_code == 200 and r.json()["known"] is False and r.json()["analysis_id"] == "f-1"
    assert r.json()["query"] == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    assert posted == ["sample.bin"]
    assert client.post("/verdict/api/scan/file", files={"file": ("e", b"", "application/octet-stream")}).status_code == 400


def test_rate_limit(monkeypatch):
    monkeypatch.setenv("VT_API_KEY", "k")

    async def fake(method, path, **kw):
        return FakeResponse(404, {})

    monkeypatch.setattr(verdict, "request_vt", fake)
    verdict.cache.items.clear(); verdict.hits.clear()
    codes = [client.get("/verdict/api/lookup", params={"q": f"10.0.0.{i}"}).status_code for i in range(10)]
    assert codes[:8] == [200] * 8 and codes[8] == 429
