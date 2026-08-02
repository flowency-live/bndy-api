#!/usr/bin/env python3
"""Authorised Lemonrock UK catalogue exporter for the bndy POC.

Collects all UK venues and bands with current gigs from Lemonrock A-Z indexes,
then downloads each venue's official CSV feed and builds structured venue,
artist and gig JSON datasets without visiting individual gig pages.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import sys
import time
import traceback
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL = "https://www.lemonrock.com"
LETTERS = tuple("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + ("123",)
OUT = Path(os.environ.get("OUTPUT_DIR", "lemonrock_export"))
ACCESS_KEY = os.environ.get("LEMONROCK_ACCESS_KEY", "").strip() or None
DELAY = float(os.environ.get("LEMONROCK_DELAY", "0.25"))
YEARS = int(os.environ.get("LEMONROCK_YEARS", "5"))
USER_AGENT = os.environ.get(
    "LEMONROCK_USER_AGENT",
    "bndy-lemonrock-authorised-export/1.0 (+founder-approved POC)",
)

GIG_ID_RE = re.compile(r"(?:[?&]id=)(\d+)")
GIG_COUNT_RE = re.compile(r"\b(\d+)\s+gigs?\b", re.I)
VENUE_META_RE = re.compile(
    r"^(?P<venue_type>.*),\s*(?P<gig_count>\d+)\s+gigs?,\s*(?P<area>.+)$", re.I
)
ACT_TYPE_RE = re.compile(r"\b(Solo Artist|Duo|Trio|\d+\s+piece)\b", re.I)
BASED_RE = re.compile(r"\bbased\s*:\s*(.+)$", re.I)
EXCLUDED_PATHS = {
    "", "guide", "join", "about", "install", "help", "terms", "editor",
    "bands", "venues", "towns", "favourites", "login", "logout", "account",
    "allbands", "allvenues", "available-bands", "newestgigs", "statistics",
}


@dataclass
class EntityRow:
    slug: str
    name: str
    kind: str
    metadata_text: str
    index_letter: str
    source_url: str
    gig_count: int | None = None
    venue_type: str | None = None
    area: str | None = None
    genre: str | None = None
    act_type: str | None = None
    based_area: str | None = None


class ExportError(RuntimeError):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def norm(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).casefold()


def parse_bool(value: str | None) -> bool:
    return norm(value) in {"1", "true", "yes", "y", "tbc", "cancelled", "support", "repeat"}


def build_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=5, connect=5, read=5, status=5, backoff_factor=1.0,
        status_forcelist=(408, 429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}), respect_retry_after_header=True,
    )
    session.mount("https://", HTTPAdapter(max_retries=retry, pool_connections=8, pool_maxsize=8))
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,text/csv;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
    })
    return session


def get(session: requests.Session, url: str, *, params: dict[str, Any] | None = None) -> requests.Response:
    response = session.get(url, params=params, timeout=45)
    response.raise_for_status()
    return response


def local_row_text(anchor) -> str:
    candidates: list[str] = []
    node = anchor
    for _ in range(5):
        node = getattr(node, "parent", None)
        if node is None:
            break
        text = node.get_text(" ", strip=True)
        if text:
            candidates.append(text)
            if GIG_COUNT_RE.search(text) and len(text) <= 600:
                return text
    return candidates[0] if candidates else anchor.get_text(" ", strip=True)


def parse_entity_anchor(anchor, letter: str, kind: str) -> EntityRow | None:
    href = (anchor.get("href") or "").strip()
    name = anchor.get_text(" ", strip=True)
    if not href or not name:
        return None
    absolute = urljoin(BASE_URL + "/", href)
    parsed = urlparse(absolute)
    path = parsed.path.strip("/")
    if (
        parsed.netloc not in {"lemonrock.com", "www.lemonrock.com"}
        or not path or "/" in path or "." in path or parsed.query
        or path.casefold() in EXCLUDED_PATHS
    ):
        return None
    text = local_row_text(anchor)
    if not GIG_COUNT_RE.search(text):
        return None
    metadata = text[len(name):].strip() if text.startswith(name) else text
    left, right = metadata.find("("), metadata.rfind(")")
    if left >= 0 and right > left:
        metadata = metadata[left + 1:right]
    metadata = re.sub(r"\s+", " ", metadata).strip(" ,")
    count_match = GIG_COUNT_RE.search(metadata)
    row = EntityRow(
        slug=path, name=name, kind=kind, metadata_text=metadata,
        index_letter=letter, source_url=absolute,
        gig_count=int(count_match.group(1)) if count_match else None,
    )
    if kind == "venue":
        match = VENUE_META_RE.match(metadata)
        if match:
            row.venue_type = match.group("venue_type").strip(" ,") or None
            row.area = match.group("area").strip(" ,") or None
    else:
        act_match = ACT_TYPE_RE.search(metadata)
        based_match = BASED_RE.search(metadata)
        row.act_type = act_match.group(1) if act_match else None
        row.based_area = based_match.group(1).strip(" ,") if based_match else None
        cuts = [m.start() for m in (act_match, count_match, based_match) if m]
        row.genre = metadata[:min(cuts)].strip(" ,") if cuts else metadata or None
    return row


def enumerate_entities(session: requests.Session, kind: str) -> tuple[list[EntityRow], list[dict[str, Any]]]:
    endpoint = "allvenues.php" if kind == "venue" else "allbands.php"
    found: dict[str, EntityRow] = {}
    page_results: list[dict[str, Any]] = []
    for letter in LETTERS:
        started = time.time()
        try:
            response = get(session, f"{BASE_URL}/{endpoint}", params={"_start": letter, "all": 0, "cc": "gb"})
            html = response.text
            if "request is being verified" in html.casefold() or "one moment, please" in html.casefold():
                raise ExportError("Bot verification page returned")
            soup = BeautifulSoup(html, "html.parser")
            before = len(found)
            for anchor in soup.find_all("a", href=True):
                row = parse_entity_anchor(anchor, letter, kind)
                if row:
                    found.setdefault(row.slug, row)
            page_results.append({
                "letter": letter, "status": "ok", "http_status": response.status_code,
                "added": len(found) - before, "elapsed_seconds": round(time.time() - started, 3),
                "url": response.url,
            })
            print(f"{kind} index {letter}: +{len(found)-before} (total {len(found)})", flush=True)
        except Exception as exc:
            page_results.append({
                "letter": letter, "status": "failed", "error": f"{type(exc).__name__}: {exc}",
                "elapsed_seconds": round(time.time() - started, 3),
            })
            print(f"ERROR {kind} index {letter}: {exc}", file=sys.stderr, flush=True)
        time.sleep(DELAY)
    return sorted(found.values(), key=lambda item: (item.name.casefold(), item.slug)), page_results


def canonical_row(raw: dict[str, str], venue: EntityRow, row_number: int) -> dict[str, Any]:
    cleaned = {(key or "").strip(): (value or "").strip() for key, value in raw.items()}
    source_url = cleaned.get("URL", "")
    match = GIG_ID_RE.search(source_url)
    return {
        "source_row_number": row_number,
        "lemonrock_gig_id": int(match.group(1)) if match else None,
        "date": cleaned.get("Date") or None,
        "start_time": cleaned.get("Start Time") or None,
        "end_time": cleaned.get("End Time") or None,
        "timezone": "Europe/London",
        "is_tbc": parse_bool(cleaned.get("TBC?")),
        "is_cancelled": parse_bool(cleaned.get("Cancelled?")),
        "artist_name": cleaned.get("Band Name") or None,
        "venue_name": cleaned.get("Venue") or venue.name,
        "venue_slug": venue.slug,
        "venue_area": venue.area,
        "venue_type": venue.venue_type,
        "entrance_fee_text": cleaned.get("Entrance Fee") or None,
        "source_url": source_url or None,
        "is_support_artist": parse_bool(cleaned.get("Support Band?")),
        "is_repeating": parse_bool(cleaned.get("Repeating?")),
        "is_first_repeat": parse_bool(cleaned.get("First Repeat?")),
        "raw": cleaned,
    }


def fetch_venue_csv(session: requests.Session, venue: EntityRow) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    params: dict[str, Any] = {"t": venue.slug, "y": YEARS}
    if ACCESS_KEY:
        params["key"] = ACCESS_KEY
    started = time.time()
    response = get(session, f"{BASE_URL}/csv.php", params=params)
    text = response.text.lstrip("\ufeff")
    header_offset = text.find('"Date","TBC?"')
    if header_offset >= 0:
        text = text[header_offset:]
    lower = text.casefold()
    if "request is being verified" in lower or "one moment, please" in lower:
        raise ExportError("Bot verification page returned for CSV")
    if text.lstrip().startswith("No gigs for period"):
        return [], {"venue_slug": venue.slug, "status": "ok_empty", "url": response.url}
    reader = csv.DictReader(io.StringIO(text))
    actual = {(field or "").strip() for field in (reader.fieldnames or [])}
    required = {"Date", "Band Name", "Venue", "URL"}
    if not required.issubset(actual):
        raise ExportError(f"Unexpected CSV columns {sorted(actual)}. Preview: {text[:180]!r}")
    rows = [canonical_row(row, venue, number) for number, row in enumerate(reader, start=2)]
    return rows, {
        "venue_slug": venue.slug, "status": "ok", "row_count": len(rows),
        "http_status": response.status_code, "elapsed_seconds": round(time.time() - started, 3),
        "url": response.url,
    }


def fallback_id(row: dict[str, Any]) -> str:
    raw = "|".join(str(row.get(key) or "") for key in ("date", "start_time", "venue_slug", "artist_name"))
    return "fingerprint:" + hashlib.sha256(raw.encode()).hexdigest()[:24]


def build_artists(index_rows: list[EntityRow], raw_rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, str | None]]:
    artists: dict[str, dict[str, Any]] = {}
    candidates: dict[str, list[str]] = defaultdict(list)
    for artist in index_rows:
        artist_id = f"lemonrock:{artist.slug}"
        artists[artist_id] = {
            "artist_id": artist_id, "lemonrock_slug": artist.slug, "name": artist.name,
            "genre": artist.genre, "act_type": artist.act_type, "based_area": artist.based_area,
            "listed_current_gig_count": artist.gig_count, "metadata_text": artist.metadata_text,
            "source_url": artist.source_url, "source": "Lemonrock Gig Guide",
        }
        candidates[norm(artist.name)].append(artist_id)
    name_to_id: dict[str, str | None] = {}
    names = sorted({row["artist_name"] for row in raw_rows if row.get("artist_name")}, key=str.casefold)
    for name in names:
        key = norm(name)
        matches = candidates.get(key, [])
        if len(matches) == 1:
            name_to_id[key] = matches[0]
        else:
            artist_id = "name:" + hashlib.sha256(key.encode()).hexdigest()[:20]
            name_to_id[key] = artist_id
            artists.setdefault(artist_id, {
                "artist_id": artist_id, "lemonrock_slug": None, "name": name,
                "genre": None, "act_type": None, "based_area": None,
                "listed_current_gig_count": None, "metadata_text": None,
                "source_url": None, "source": "Lemonrock Gig Guide",
                "match_note": "Observed in gig CSV but not uniquely matched to the A-Z artist index",
            })
    return sorted(artists.values(), key=lambda item: (item["name"].casefold(), item["artist_id"])), name_to_id


def build_gigs(raw_rows: list[dict[str, Any]], name_to_artist_id: dict[str, str | None]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in raw_rows:
        key = str(row["lemonrock_gig_id"]) if row.get("lemonrock_gig_id") is not None else fallback_id(row)
        groups[key].append(row)
    gigs: list[dict[str, Any]] = []
    for group_key, rows in groups.items():
        primary_rows = [row for row in rows if not row.get("is_support_artist")]
        support_rows = [row for row in rows if row.get("is_support_artist")]
        base = primary_rows[0] if primary_rows else rows[0]
        lineup, seen = [], set()
        for row, role in [(r, "primary") for r in primary_rows] + [(r, "support") for r in support_rows]:
            name = row.get("artist_name")
            signature = (norm(name), role)
            if not name or signature in seen:
                continue
            seen.add(signature)
            lineup.append({"artist_id": name_to_artist_id.get(norm(name)), "name": name, "role": role})
        conflicts: dict[str, list[Any]] = {}
        for field in ("date", "start_time", "end_time", "venue_name", "entrance_fee_text"):
            values = list(dict.fromkeys(row.get(field) for row in rows))
            if len(values) > 1:
                conflicts[field] = values
        gig_id = base.get("lemonrock_gig_id")
        gigs.append({
            "event_id": f"lemonrock:{gig_id}" if gig_id is not None else group_key,
            "lemonrock_gig_id": gig_id,
            "date": base.get("date"), "start_time": base.get("start_time"),
            "end_time": base.get("end_time"), "timezone": "Europe/London",
            "venue": {
                "lemonrock_slug": base.get("venue_slug"), "name": base.get("venue_name"),
                "area": base.get("venue_area"), "type": base.get("venue_type"), "country_code": "GB",
            },
            "artists": lineup,
            "primary_artist_name": primary_rows[0].get("artist_name") if primary_rows else None,
            "support_artist_names": [entry["name"] for entry in lineup if entry["role"] == "support"],
            "entrance_fee_text": base.get("entrance_fee_text"),
            "is_tbc": any(row.get("is_tbc") for row in rows),
            "is_cancelled": any(row.get("is_cancelled") for row in rows),
            "is_repeating": any(row.get("is_repeating") for row in rows),
            "is_first_repeat": any(row.get("is_first_repeat") for row in rows),
            "source_url": base.get("source_url"),
            "source_venue_slugs": sorted({row["venue_slug"] for row in rows}),
            "source_row_count": len(rows), "source_conflicts": conflicts or None,
            "source": "Lemonrock Gig Guide",
        })
    return sorted(gigs, key=lambda item: (
        item.get("date") or "9999-99-99", item.get("start_time") or "99:99:99",
        norm(item.get("venue", {}).get("name")), norm(item.get("primary_artist_name")),
    ))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "started_at": now_iso(), "source": "Lemonrock Gig Guide",
        "scope": "UK venues and artists with current gigs; venue CSV horizon controlled by y parameter",
        "years_parameter": YEARS, "access_key_supplied": bool(ACCESS_KEY), "errors": [],
    }
    session = build_session()
    venues, venue_pages = enumerate_entities(session, "venue")
    index_artists, artist_pages = enumerate_entities(session, "artist")
    report.update({"venue_index_pages": venue_pages, "artist_index_pages": artist_pages})
    if not venues:
        report.update({"completed_at": now_iso(), "errors": ["No venues discovered"]})
        write_json(OUT / "run_report.json", report)
        return 2

    raw_rows, csv_results, failures = [], [], []
    for position, venue in enumerate(venues, 1):
        try:
            rows, result = fetch_venue_csv(session, venue)
            raw_rows.extend(rows)
            csv_results.append(result)
            print(f"[{position}/{len(venues)}] {venue.name}: {len(rows)} rows", flush=True)
        except Exception as exc:
            failure = {
                "venue_slug": venue.slug, "venue_name": venue.name, "venue_area": venue.area,
                "error_type": type(exc).__name__, "error": str(exc),
            }
            failures.append(failure)
            csv_results.append({"status": "failed", **failure})
            print(f"ERROR [{position}/{len(venues)}] {venue.slug}: {exc}", file=sys.stderr, flush=True)
        time.sleep(DELAY)

    artists, artist_ids = build_artists(index_artists, raw_rows)
    gigs = build_gigs(raw_rows, artist_ids)
    venues_json = [{
        "venue_id": f"lemonrock:{venue.slug}", "lemonrock_slug": venue.slug,
        "name": venue.name, "area": venue.area, "venue_type": venue.venue_type,
        "country_code": "GB", "listed_current_gig_count": venue.gig_count,
        "metadata_text": venue.metadata_text, "source_url": venue.source_url,
        "source": "Lemonrock Gig Guide",
    } for venue in venues]

    write_json(OUT / "venues.json", venues_json)
    write_json(OUT / "artists.json", artists)
    write_json(OUT / "gigs.json", gigs)
    write_jsonl(OUT / "gigs.jsonl", gigs)
    write_jsonl(OUT / "raw_gig_rows.jsonl", raw_rows)
    write_json(OUT / "failures.json", failures)
    write_json(OUT / "combined.json", {
        "meta": {"generated_at": now_iso(), "source": "Lemonrock Gig Guide", "years_parameter": YEARS},
        "venues": venues_json, "artists": artists, "gigs": gigs,
    })

    complete = not failures and all(page.get("status") == "ok" for page in venue_pages + artist_pages)
    report.update({
        "completed_at": now_iso(), "venue_count": len(venues_json),
        "artist_index_count": len(index_artists), "artist_output_count": len(artists),
        "raw_gig_row_count": len(raw_rows), "unique_gig_count": len(gigs),
        "venue_csv_success_count": sum(1 for result in csv_results if result.get("status") in {"ok", "ok_empty"}),
        "venue_csv_failure_count": len(failures),
        "index_failure_count": sum(1 for page in venue_pages + artist_pages if page.get("status") != "ok"),
        "complete": complete, "csv_results": csv_results,
        "output_files": ["venues.json", "artists.json", "gigs.json", "gigs.jsonl", "raw_gig_rows.jsonl", "combined.json", "failures.json", "run_report.json"],
    })
    if failures:
        report["errors"].append(f"{len(failures)} venue CSV feeds failed; see failures.json")
    write_json(OUT / "run_report.json", report)
    (OUT / "README.txt").write_text(
        f"Lemonrock UK export generated {report['completed_at']}\n\n"
        f"Venues: {len(venues_json)}\nArtists: {len(artists)}\nUnique gigs: {len(gigs)}\n"
        f"Failed venue feeds: {len(failures)}\nComplete: {complete}\n",
        encoding="utf-8",
    )
    print(json.dumps({"venues": len(venues_json), "artists": len(artists), "gigs": len(gigs), "failures": len(failures), "complete": complete}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "fatal_error.txt").write_text(traceback.format_exc(), encoding="utf-8")
        raise
