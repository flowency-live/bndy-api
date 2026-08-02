from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup, NavigableString, Tag

BASE = "https://www.lemonrock.com"
BLOG_URL = f"{BASE}/editor?page=blog"
OUT = Path(os.getenv("OUTPUT_DIR", "lemonrock_editor_blog_capture"))
DELAY = float(os.getenv("LEMONROCK_DELAY", "0.50"))
TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "30"))
MAX_PAGES = int(os.getenv("MAX_PAGES", "80"))
DATE_RE = re.compile(r"^(?:New\s+)?(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})(.*)$")
PAGE_COUNT_RE = re.compile(r"of\s+(\d+)", re.I)


@dataclass
class PageResult:
    page_number: int
    start: int
    url: str
    status: str
    http_status: int | None
    bytes: int
    sha256: str | None
    candidate_dates: int
    error: str | None = None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": "bndy-lemonrock-blog-research/0.1 (founder-authorised POC; contact: bndy)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Cache-Control": "no-cache",
    })
    return s


def page_url(start: int) -> str:
    if start == 0:
        return BLOG_URL
    return f"{BASE}/editor?_start={start}&page=blog"


def is_verification_page(text: str) -> bool:
    lower = text.casefold()
    return any(x in lower for x in (
        "bot verification",
        "verify you are human",
        "checking your browser",
        "cf-chl-",
        "captcha",
    ))


def fetch(session: requests.Session, url: str) -> requests.Response:
    last: Exception | None = None
    for attempt in range(4):
        try:
            r = session.get(url, timeout=TIMEOUT)
            if r.status_code in {429, 500, 502, 503, 504}:
                wait = min(30, 2 ** attempt * 2)
                time.sleep(wait)
                continue
            r.raise_for_status()
            if is_verification_page(r.text):
                raise RuntimeError("Bot verification page returned")
            return r
        except Exception as exc:
            last = exc
            if attempt == 3:
                break
            time.sleep(min(30, 2 ** attempt * 2))
    raise RuntimeError(f"Failed to fetch {url}: {last}")


def visible_text(tag: Tag) -> str:
    return " ".join(tag.get_text(" ", strip=True).split())


def inspect_candidates(html: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    date_nodes: list[dict[str, Any]] = []
    for string in soup.find_all(string=True):
        if not isinstance(string, NavigableString):
            continue
        text = " ".join(str(string).split())
        m = DATE_RE.match(text)
        if not m:
            continue
        parent = string.parent
        ancestry: list[dict[str, Any]] = []
        current: Tag | None = parent if isinstance(parent, Tag) else None
        for _ in range(6):
            if current is None:
                break
            ancestry.append({
                "tag": current.name,
                "id": current.get("id"),
                "class": current.get("class", []),
                "text_preview": visible_text(current)[:500],
            })
            current = current.parent if isinstance(current.parent, Tag) else None
        date_nodes.append({
            "raw": text,
            "date": m.group(1),
            "tail": m.group(2).strip(),
            "ancestry": ancestry,
        })
    return {
        "candidate_date_count": len(date_nodes),
        "date_nodes": date_nodes,
        "page_text_preview": visible_text(soup)[:3000],
    }


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    raw_dir = OUT / "raw_pages"
    raw_dir.mkdir(exist_ok=True)
    started = now_iso()
    session = build_session()
    page_results: list[PageResult] = []
    diagnostics: list[dict[str, Any]] = []

    first = fetch(session, page_url(0))
    first_text = first.text
    match = PAGE_COUNT_RE.search(visible_text(BeautifulSoup(first_text, "html.parser")))
    total_pages = int(match.group(1)) if match else 62
    total_pages = min(total_pages, MAX_PAGES)
    print(f"Detected {total_pages} blog pages", flush=True)

    for page_num in range(1, total_pages + 1):
        start = (page_num - 1) * 4
        url = page_url(start)
        try:
            response = first if page_num == 1 else fetch(session, url)
            data = response.content
            sha = hashlib.sha256(data).hexdigest()
            path = raw_dir / f"page_{page_num:03d}_start_{start:03d}.html"
            path.write_bytes(data)
            diag = inspect_candidates(response.text)
            diagnostics.append({
                "page_number": page_num,
                "start": start,
                "url": url,
                **diag,
            })
            page_results.append(PageResult(
                page_number=page_num,
                start=start,
                url=url,
                status="ok",
                http_status=response.status_code,
                bytes=len(data),
                sha256=sha,
                candidate_dates=diag["candidate_date_count"],
            ))
            print(f"[{page_num}/{total_pages}] {url} dates={diag['candidate_date_count']} bytes={len(data)}", flush=True)
        except Exception as exc:
            page_results.append(PageResult(
                page_number=page_num,
                start=start,
                url=url,
                status="failed",
                http_status=None,
                bytes=0,
                sha256=None,
                candidate_dates=0,
                error=f"{type(exc).__name__}: {exc}",
            ))
            print(f"ERROR [{page_num}/{total_pages}] {url}: {exc}", file=sys.stderr, flush=True)
        if page_num != total_pages:
            time.sleep(DELAY)

    completed = now_iso()
    report = {
        "started_at": started,
        "completed_at": completed,
        "source_url": BLOG_URL,
        "reported_blog_count": 248,
        "detected_page_count": total_pages,
        "successful_pages": sum(x.status == "ok" for x in page_results),
        "failed_pages": sum(x.status != "ok" for x in page_results),
        "candidate_date_nodes": sum(x.candidate_dates for x in page_results),
        "complete": all(x.status == "ok" for x in page_results),
        "pages": [asdict(x) for x in page_results],
    }
    (OUT / "capture_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT / "parser_diagnostics.json").write_text(json.dumps(diagnostics, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT / "README.md").write_text(
        "# Lemonrock Editor blog capture\n\n"
        f"Captured: {completed}\n\n"
        f"- Detected pages: {total_pages}\n"
        f"- Successful pages: {report['successful_pages']}\n"
        f"- Failed pages: {report['failed_pages']}\n"
        f"- Candidate dated entries: {report['candidate_date_nodes']}\n\n"
        "Raw HTML is retained solely for analysis and is not intended for republication.\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2), flush=True)
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
