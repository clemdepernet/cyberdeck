import json

import pytest
from fastapi.testclient import TestClient

import app as leaks
from sources import breaches_as_feed, is_french_breach, merge, normalise_breach, parse_rss, strip_html

BLF = """<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Bonjour la fuite</title>
<item><title><![CDATA[🟢 Agence de Services et de Paiement]]></title><pubDate>Thu, 24 Sep 2026 00:00:00 +0000</pubDate>
<description><![CDATA[<ul><li>Nom, prénom</li><li>IBAN</li></ul>]]></description>
<guid isPermaLink="true"><![CDATA[https://bonjourlafuite.eu.org#ASP-2026-09-24]]></guid><category>leak</category><category>sensitive</category></item>
<item><title>Vieux</title><pubDate>Tue, 01 Sep 2026 00:00:00 +0000</pubDate><link>https://x/old</link><description>&lt;p&gt;Texte &lt;b&gt;riche&lt;/b&gt;&lt;/p&gt;</description></item>
</channel></rss>"""

HIBP = [
    {"Name": "FreeMobile", "Title": "Free Mobile", "Domain": "free.fr", "BreachDate": "2024-10-17", "AddedDate": "2025-05-27T00:00:00Z", "PwnCount": 13926173,
     "Description": "In October 2024, French telco <a href=\"x\">Free</a> suffered a breach.", "LogoPath": "https://l/free.png", "DataClasses": ["Email addresses", "IBAN"], "IsVerified": True, "IsSensitive": False},
    {"Name": "LimeLeads", "Title": "LimeLeads", "Domain": "limeleads.com", "BreachDate": "2019-01-01", "AddedDate": "2026-09-20T00:00:00Z", "PwnCount": 17838396,
     "Description": "US data broker.", "LogoPath": "", "DataClasses": ["Email addresses"], "IsVerified": True, "IsSensitive": False, "IsStealerLog": False},
]


def test_parse_rss_bonjour_la_fuite():
    items = parse_rss(BLF, "Bonjour la fuite", True)
    assert len(items) == 2
    first = items[0]
    assert first["title"].endswith("Agence de Services et de Paiement")
    assert first["date"].startswith("2026-09-24")
    assert first["link"] == "https://bonjourlafuite.eu.org#ASP-2026-09-24"
    assert first["details"] == ["Nom, prénom", "IBAN"]
    assert first["tags"] == ["leak", "sensitive"]
    assert items[1]["summary"] == "Texte riche"
    assert parse_rss("not xml at all", "x") == []


def test_breach_normalisation_and_french_flag():
    n = normalise_breach(HIBP[0])
    assert n["french"] is True and n["description"] == "In October 2024, French telco Free suffered a breach."
    assert is_french_breach(HIBP[1]) is False
    feed = breaches_as_feed(HIBP)
    assert [i["breach"]["name"] for i in feed] == ["LimeLeads", "FreeMobile"]   # newest AddedDate first
    assert feed[1]["french"] and "13 926 173" in feed[1]["title"]


def test_merge_sorts_and_dedups():
    a = [{"link": "1", "date": "2026-01-01T00:00:00+00:00"}, {"link": "2", "date": "2026-03-01T00:00:00+00:00"}]
    b = [{"link": "2", "date": "2026-03-01T00:00:00+00:00"}, {"link": "3", "date": "2026-02-01T00:00:00+00:00"}]
    assert [i["link"] for i in merge(a, b)] == ["2", "3", "1"]
    assert strip_html("a" * 300, 10) == "aaaaaaaaa…"


client = TestClient(leaks.app)


def test_check_without_key_and_validation(monkeypatch):
    monkeypatch.delenv("HIBP_API_KEY", raising=False)
    assert client.get("/leaks/api/check", params={"email": "not-an-email"}).status_code == 400
    r = client.get("/leaks/api/check", params={"email": "a@b.co"})
    assert r.status_code == 503 and "HIBP_API_KEY" in r.json()["hint"]
    assert client.get("/leaks/api/status").json()["hibp_key"] is False


class FakeResponse:
    def __init__(self, status, body="", headers=None):
        self.status_code, self._body, self.headers, self.text = status, body, headers or {}, body if isinstance(body, str) else ""
    def json(self):
        return self._body
    def raise_for_status(self):
        pass


def test_check_with_key_uses_hibp(monkeypatch):
    monkeypatch.setenv("HIBP_API_KEY", "k")
    calls = []
    async def fake_fetch(url, headers=None, timeout=20.0):
        calls.append((url, headers))
        if "breachedaccount" in url:
            return FakeResponse(200, HIBP)
        if "pasteaccount" in url:
            return FakeResponse(200, [{"Source": "Pastebin", "Id": "abc", "Title": "dump", "Date": "2020-01-01T00:00:00Z", "EmailCount": 12}])
        raise AssertionError(url)
    monkeypatch.setattr(leaks, "fetch", fake_fetch)
    leaks.cache.items.clear()
    r = client.get("/leaks/api/check", params={"email": "Someone@Example.org"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["email"] == "someone@example.org"
    assert [b["name"] for b in body["breaches"]] == ["FreeMobile", "LimeLeads"]   # newest breach first
    assert body["french"][0]["name"] == "FreeMobile"
    assert body["pastes"][0]["source"] == "Pastebin"
    assert "IBAN" in body["data_classes"]
    assert all(h and h.get("hibp-api-key") == "k" for _, h in calls)
    assert "breachedaccount/someone@example.org?truncateResponse=false" in calls[0][0]
    # cached: a second call must not hit the network
    calls.clear()
    assert client.get("/leaks/api/check", params={"email": "someone@example.org"}).status_code == 200
    assert calls == []


def test_check_not_found_and_errors(monkeypatch):
    monkeypatch.setenv("HIBP_API_KEY", "k")
    async def nf(url, headers=None, timeout=20.0):
        return FakeResponse(404, {})
    monkeypatch.setattr(leaks, "fetch", nf)
    leaks.cache.items.clear(); leaks.lookups.clear()
    r = client.get("/leaks/api/check", params={"email": "clean@example.org"})
    assert r.status_code == 200 and r.json()["breaches"] == [] and r.json()["pastes"] == []
    async def bad(url, headers=None, timeout=20.0):
        return FakeResponse(401, {})
    monkeypatch.setattr(leaks, "fetch", bad)
    leaks.cache.items.clear()
    assert client.get("/leaks/api/check", params={"email": "x@example.org"}).status_code == 502


def test_rate_limit_protects_key(monkeypatch):
    monkeypatch.setenv("HIBP_API_KEY", "k")
    async def nf(url, headers=None, timeout=20.0):
        return FakeResponse(404, {})
    monkeypatch.setattr(leaks, "fetch", nf)
    leaks.cache.items.clear(); leaks.lookups.clear()
    codes = [client.get("/leaks/api/check", params={"email": f"u{i}@example.org"}).status_code for i in range(14)]
    assert codes[:12] == [200] * 12 and codes[12] == 429


def test_password_range(monkeypatch):
    async def fake(url, headers=None, timeout=20.0):
        assert url.endswith("/range/5BAA6") and headers.get("Add-Padding") == "true"
        return FakeResponse(200, "1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\nAAAA:0\r\n")
    monkeypatch.setattr(leaks, "fetch", fake)
    leaks.cache.items.clear()
    r = client.get("/leaks/api/password-range/5baa6")
    assert r.status_code == 200
    assert r.json()["suffixes"] == {"1E4C9B93F3F0682250B6CF8331B7EE68FD8": 3861493}
    assert client.get("/leaks/api/password-range/zz").status_code == 400


def test_feed_survives_a_dead_source(monkeypatch):
    async def fake(url, headers=None, timeout=20.0):
        if "bonjourlafuite" in url:
            return FakeResponse(200, BLF)
        if url.endswith("/breaches"):
            return FakeResponse(200, HIBP)
        raise httpx.ConnectError("down")
    import httpx
    monkeypatch.setattr(leaks, "fetch", fake)
    leaks.cache.items.clear()
    r = client.get("/leaks/api/feed")
    assert r.status_code == 200
    body = r.json()
    assert len(body["errors"]) == 3 and all("ConnectError" in e for e in body["errors"])
    assert body["french"][0]["source"] == "Bonjour la fuite"
    assert any(i["source"] == "Have I Been Pwned" for i in body["world"])
    assert all(i["french"] for i in body["french"])
