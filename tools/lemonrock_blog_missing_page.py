from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

URL = "https://www.lemonrock.com/editor?page=blog&_start=176"
OUT = Path(os.getenv("OUTPUT_DIR", "lemonrock_editor_blog_missing"))


def is_verification(text: str) -> bool:
    lower = text.casefold()
    return any(x in lower for x in ("bot verification", "verify you are human", "cf-chl-", "captcha"))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update({
        "User-Agent": "bndy-lemonrock-blog-research/0.2 (founder-authorised POC; targeted retry)",
        "Accept-Language": "en-GB,en;q=0.9",
    })
    last = None
    for attempt in range(6):
        try:
            response = session.get(URL, timeout=30)
            response.raise_for_status()
            if is_verification(response.text):
                raise RuntimeError("Bot verification page returned")
            (OUT / "page_045_start_176.html").write_bytes(response.content)
            report = {
                "url": URL,
                "http_status": response.status_code,
                "bytes": len(response.content),
                "retrieved_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "success": True,
            }
            (OUT / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report, indent=2))
            return 0
        except Exception as exc:
            last = exc
            time.sleep(5 + attempt * 5)
    report = {"url": URL, "success": False, "error": f"{type(last).__name__}: {last}"}
    (OUT / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    raise RuntimeError(report["error"])


if __name__ == "__main__":
    raise SystemExit(main())
