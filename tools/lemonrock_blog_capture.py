from __future__ import annotations

import hashlib
import json
import math
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
from bs4 import BeautifulSoup, Tag

BASE = "https://www.lemonrock.com"
BLOG_URL = f"{BASE}/editor?page=blog"
OUT = Path(os.getenv("OUTPUT_DIR", "lemonrock_editor_blog_capture"))
DELAY = float(os.getenv("LEMONROCK_DELAY", "0.50"))
TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "30"))
MAX_PAGES = int(os.getenv("MAX_PAGES", "100"))
BLOG_COUNT_RE = re.compile(r"Blog\s*\((\d+)\)", re.I)
BLOG_ID_RE = re.compile(r"^bl(\d+)$")


@dataclass
class PageResult:
    page_number: int
    start: int
    url: str
    status: str
    http_status: int | None
    bytes: int
    sha256: str | None
    parsed_posts: int
    error: str | None = None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": "bndy-lemonrock-blog-research/0.2 (founder-authorised POC; contact: bndy)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Cache-Control": "no-cache",
    })
    return session


def page_url(start: int) -> str:
    if start == 0:
        return BLOG_URL
    # Lemonrock's routing requires page=blog to precede _start.
    return f"{BASE}/editor?page=blog&_start={start}"


def is_verification_page(text: str) -> bool:
    lower = text.casefold()
    return any(marker in lower for marker in (
        "bot verification",
        "verify you are human",
        "checking your browser",
        "cf-chl-",
        "captcha",
    ))


def fetch(session: requests.Session, url: str) -> requests.Response:
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            response = session.get(url, timeout=TIMEOUT)
            if response.status_code in {429, 500, 502, 503, 504}:
                time.sleep(min(30, (2 ** attempt) * 2))
                continue
            response.raise_for_status()
            if is_verification_page(response.text):
                raise RuntimeError("Bot verification page returned")
            return response
        except Exception as exc:
            last_error = exc
            if attempt < 3:
                time.sleep(min(30, (2 ** attempt) * 2))
    raise RuntimeError(f"Failed to fetch {url}: {last_error}")


def normalise_lines(text: str) -> str:
    lines: list[str] = []
    for raw_line in text.replace("\r", "\n").split("\n"):
        line = " ".join(raw_line.split())
        if not line:
            if lines and lines[-1] != "":
                lines.append("")
            continue
        if line == "___":
            lines.append("---")
        else:
            lines.append(line)
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines)


def extract_body(section: Tag) -> str:
    fragment = BeautifulSoup(str(section), "html.parser")
    root = fragment.select_one("section") or fragment

    for selector in (
        ".sechead", ".imgfit", ".dateh", ".mainh", ".lradd-cont", ".c",
        "script", "style", "noscript",
    ):
        for node in root.select(selector):
            node.decompose()

    for separator in root.select("div.sepv"):
        separator.replace_with("\n")
    for br in root.find_all("br"):
        br.replace_with("\n")

    return normalise_lines(root.get_text("\n", strip=False))


def extract_links(section: Tag, source_url: str) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []
    seen: set[str] = set()
    for anchor in section.find_all("a", href=True):
        href = anchor.get("href", "").strip()
        if not href or href.startswith("javascript:") or "blogid=" in href:
            continue
        absolute = urljoin(BASE + "/", href)
        if absolute == source_url or absolute in seen:
            continue
        seen.add(absolute)
        links.append({
            "url": absolute,
            "label": " ".join(anchor.get_text(" ", strip=True).split()),
        })
    return links


def parse_page(html: str, page_number: int, start: int, source_page_url: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    posts: list[dict[str, Any]] = []

    for position, article in enumerate(soup.select("article.r"), 1):
        section = article.select_one("section.secsepheading") or article
        title_node = section.select_one(".sechead") or section.select_one(".mainh")
        date_node = section.select_one(".dateh")
        id_node = section.select_one(".mainh[id]")
        if not title_node or not date_node or not id_node:
            continue

        id_match = BLOG_ID_RE.match(id_node.get("id", ""))
        if not id_match:
            continue
        blog_id = int(id_match.group(1))
        title = " ".join(title_node.get_text(" ", strip=True).split())
        published_text = " ".join(date_node.get_text(" ", strip=True).split())
        try:
            published_date = datetime.strptime(published_text, "%d %b %Y").date().isoformat()
        except ValueError:
            published_date = None

        source_url = f"{BASE}/editor?page=blog&blogid={blog_id}"
        body = extract_body(section)
        words = re.findall(r"\b[\w’'-]+\b", body, flags=re.UNICODE)

        posts.append({
            "blog_id": blog_id,
            "title": title,
            "published_text": published_text,
            "published_date": published_date,
            "source_url": source_url,
            "source_page_url": source_page_url,
            "archive_page_number": page_number,
            "archive_start": start,
            "position_on_page": position,
            "body": body,
            "word_count": len(words),
            "links": extract_links(section, source_url),
            "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        })

    return posts


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    raw_dir = OUT / "raw_pages"
    raw_dir.mkdir(exist_ok=True)
    started_at = now_iso()
    session = build_session()

    first_response = fetch(session, page_url(0))
    first_soup = BeautifulSoup(first_response.text, "html.parser")
    first_text = " ".join(first_soup.get_text(" ", strip=True).split())
    count_match = BLOG_COUNT_RE.search(first_text)
    reported_blog_count = int(count_match.group(1)) if count_match else None
    total_pages = math.ceil(reported_blog_count / 4) if reported_blog_count else 64
    total_pages = min(total_pages, MAX_PAGES)
    print(f"Reported posts={reported_blog_count}; pages={total_pages}", flush=True)

    page_results: list[PageResult] = []
    all_posts: list[dict[str, Any]] = []

    for page_number in range(1, total_pages + 1):
        start = (page_number - 1) * 4
        url = page_url(start)
        try:
            response = first_response if page_number == 1 else fetch(session, url)
            raw = response.content
            raw_path = raw_dir / f"page_{page_number:03d}_start_{start:03d}.html"
            raw_path.write_bytes(raw)
            parsed = parse_page(response.text, page_number, start, url)
            all_posts.extend(parsed)
            page_results.append(PageResult(
                page_number=page_number,
                start=start,
                url=url,
                status="ok",
                http_status=response.status_code,
                bytes=len(raw),
                sha256=hashlib.sha256(raw).hexdigest(),
                parsed_posts=len(parsed),
            ))
            print(f"[{page_number}/{total_pages}] posts={len(parsed)} {url}", flush=True)
        except Exception as exc:
            page_results.append(PageResult(
                page_number=page_number,
                start=start,
                url=url,
                status="failed",
                http_status=None,
                bytes=0,
                sha256=None,
                parsed_posts=0,
                error=f"{type(exc).__name__}: {exc}",
            ))
            print(f"ERROR [{page_number}/{total_pages}] {url}: {exc}", file=sys.stderr, flush=True)
        if page_number != total_pages:
            time.sleep(DELAY)

    # Dedupe only by immutable Lemonrock blog ID, retaining the first archive occurrence.
    posts_by_id: dict[int, dict[str, Any]] = {}
    duplicate_ids: list[int] = []
    for post in all_posts:
        blog_id = post["blog_id"]
        if blog_id in posts_by_id:
            duplicate_ids.append(blog_id)
            continue
        posts_by_id[blog_id] = post

    posts = sorted(
        posts_by_id.values(),
        key=lambda item: (item.get("published_date") or "", item["blog_id"]),
        reverse=True,
    )
    completed_at = now_iso()
    complete = (
        all(page.status == "ok" for page in page_results)
        and not duplicate_ids
        and (reported_blog_count is None or len(posts) == reported_blog_count)
    )

    report = {
        "started_at": started_at,
        "completed_at": completed_at,
        "source_url": BLOG_URL,
        "reported_blog_count": reported_blog_count,
        "detected_page_count": total_pages,
        "successful_pages": sum(page.status == "ok" for page in page_results),
        "failed_pages": sum(page.status != "ok" for page in page_results),
        "parsed_post_occurrences": len(all_posts),
        "unique_posts": len(posts),
        "duplicate_blog_ids": sorted(set(duplicate_ids)),
        "oldest_post_date": min((post["published_date"] for post in posts if post["published_date"]), default=None),
        "newest_post_date": max((post["published_date"] for post in posts if post["published_date"]), default=None),
        "total_words": sum(post["word_count"] for post in posts),
        "complete": complete,
        "pages": [asdict(page) for page in page_results],
    }

    (OUT / "posts_full_internal.json").write_text(
        json.dumps(posts, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    with (OUT / "posts_full_internal.jsonl").open("w", encoding="utf-8") as handle:
        for post in posts:
            handle.write(json.dumps(post, ensure_ascii=False) + "\n")
    (OUT / "capture_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT / "README.md").write_text(
        "# Lemonrock Editor blog research capture\n\n"
        f"Captured: {completed_at}\n\n"
        f"- Reported posts: {reported_blog_count}\n"
        f"- Parsed unique posts: {len(posts)}\n"
        f"- Archive pages: {total_pages}\n"
        f"- Failed pages: {report['failed_pages']}\n"
        f"- Date range: {report['oldest_post_date']} to {report['newest_post_date']}\n"
        f"- Total words: {report['total_words']:,}\n\n"
        "The full captured text is retained for analysis only and must not be republished verbatim without permission.\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2), flush=True)
    return 0 if complete else 1


if __name__ == "__main__":
    raise SystemExit(main())
