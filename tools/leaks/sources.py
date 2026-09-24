"""Feed parsing and normalisation, kept free of network code so it is testable offline.

Every item becomes: {source, title, link, date (ISO), summary, tags, french}.
"""
from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
FRENCH_HINTS = re.compile(r"\b(france|french|fran[cç]ais|fran[cç]aise)\b", re.I)


def strip_html(text: str, limit: int = 280) -> str:
    text = html.unescape(TAG_RE.sub(" ", text or ""))
    text = WS_RE.sub(" ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def list_from_html(text: str) -> list[str]:
    """Bonjour la fuite puts the leaked data types in <li> elements."""
    items = re.findall(r"<li>(.*?)</li>", text or "", re.S)
    return [strip_html(i, 80) for i in items if strip_html(i, 80)]


def parse_date(value: str | None) -> str:
    if not value:
        return ""
    value = value.strip()
    try:
        return parsedate_to_datetime(value).astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except ValueError:
        return ""


def _text(node, *names) -> str:
    for name in names:
        found = node.find(name)
        if found is not None and (found.text or "").strip():
            return found.text.strip()
    return ""


def parse_rss(xml_text: str, source: str, french: bool = True) -> list[dict]:
    """RSS 2.0 (and tolerant of Atom) → normalised items."""
    xml_text = re.sub(r"^[^<]*", "", xml_text)  # stray bytes before the prolog
    try:
        root = ET.fromstring(xml_text.encode("utf-8", "ignore") if isinstance(xml_text, str) else xml_text)
    except ET.ParseError:
        return []
    ns = {"atom": "http://www.w3.org/2005/Atom", "dc": "http://purl.org/dc/elements/1.1/"}
    out = []
    for item in root.iter("item"):
        desc = _text(item, "description", "{http://purl.org/rss/1.0/modules/content/}encoded")
        link = _text(item, "link") or (item.find("guid").text.strip() if item.find("guid") is not None else "")
        out.append({
            "source": source,
            "title": strip_html(_text(item, "title"), 200),
            "link": link,
            "date": parse_date(_text(item, "pubDate") or _text(item, "dc:date")),
            "summary": strip_html(desc),
            "tags": [strip_html(c.text or "", 40) for c in item.findall("category") if (c.text or "").strip()],
            "details": list_from_html(desc),
            "french": french,
        })
    for entry in root.iter("{http://www.w3.org/2005/Atom}entry"):
        link_el = entry.find("atom:link", ns)
        out.append({
            "source": source,
            "title": strip_html(_text(entry, "atom:title") if False else (entry.findtext("atom:title", default="", namespaces=ns) or ""), 200),
            "link": link_el.get("href", "") if link_el is not None else "",
            "date": parse_date(entry.findtext("atom:updated", default="", namespaces=ns) or entry.findtext("atom:published", default="", namespaces=ns)),
            "summary": strip_html(entry.findtext("atom:summary", default="", namespaces=ns) or entry.findtext("atom:content", default="", namespaces=ns)),
            "tags": [],
            "details": [],
            "french": french,
        })
    return out


def is_french_breach(b: dict) -> bool:
    domain = (b.get("Domain") or "").lower()
    return domain.endswith(".fr") or bool(FRENCH_HINTS.search(b.get("Description") or "")) or bool(FRENCH_HINTS.search(b.get("Title") or ""))


def normalise_breach(b: dict) -> dict:
    """HIBP breach model → the subset the UI shows, with plain-text description."""
    return {
        "name": b.get("Name", ""),
        "title": b.get("Title", ""),
        "domain": b.get("Domain", ""),
        "breach_date": b.get("BreachDate", ""),
        "added_date": b.get("AddedDate", ""),
        "pwn_count": b.get("PwnCount", 0),
        "data_classes": b.get("DataClasses", []),
        "description": strip_html(b.get("Description", ""), 600),
        "logo": b.get("LogoPath", ""),
        "verified": bool(b.get("IsVerified")),
        "sensitive": bool(b.get("IsSensitive")),
        "stealer_log": bool(b.get("IsStealerLog")),
        "spam_list": bool(b.get("IsSpamList")),
        "french": is_french_breach(b),
        "link": f"https://haveibeenpwned.com/Breach/{b.get('Name', '')}",
    }


def breaches_as_feed(breaches: list[dict], limit: int = 60) -> list[dict]:
    items = []
    for b in sorted(breaches, key=lambda x: x.get("AddedDate", ""), reverse=True)[:limit]:
        n = normalise_breach(b)
        items.append({
            "source": "Have I Been Pwned",
            "title": f"{n['title']} · {n['pwn_count']:,} comptes".replace(",", " "),
            "link": n["link"],
            "date": parse_date(n["added_date"]),
            "summary": n["description"],
            "tags": n["data_classes"][:6],
            "details": [],
            "french": n["french"],
            "breach": n,
        })
    return items


def merge(*lists: list[dict]) -> list[dict]:
    seen, out = set(), []
    for item in sorted((i for lst in lists for i in lst), key=lambda i: i.get("date", ""), reverse=True):
        key = item.get("link") or item.get("title")
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out
