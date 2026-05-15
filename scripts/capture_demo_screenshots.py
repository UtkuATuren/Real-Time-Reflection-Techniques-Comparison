#!/usr/bin/env python3
"""Capture README/demo screenshots for the reflection comparison tool."""

from __future__ import annotations

from pathlib import Path
import sys

from playwright.sync_api import sync_playwright

from verify_ssr_visual import (
    DEVICE_SCALE_FACTOR,
    ROOT,
    VIEWPORT,
    find_chrome,
    static_server,
)


OUTPUT_DIR = ROOT / "assets" / "screenshots"

SHOTS = [
    ("cubemap", "cubemap.png"),
    ("planar", "planar.png"),
    ("ssr", "ssr.png"),
    ("ssrFallback", "ssr-fallback.png"),
]


def main() -> int:
    chrome = find_chrome()
    if not chrome:
        print("Chrome/Chromium executable not found.", file=sys.stderr)
        return 2

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    with static_server() as url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=chrome,
            args=["--disable-gpu-sandbox"],
        )
        page = browser.new_page(
            viewport=VIEWPORT,
            device_scale_factor=DEVICE_SCALE_FACTOR,
        )
        page.goto(url, wait_until="networkidle", timeout=60_000)
        page.wait_for_timeout(1500)

        for mode, filename in SHOTS:
            page.locator(f'input[value="{mode}"]').check()
            page.wait_for_timeout(900)
            page.screenshot(path=str(OUTPUT_DIR / filename))
            print(f"captured {filename}")

        page.locator('input[value="planar"]').check()
        page.locator("#extraReflectors").check()
        page.wait_for_timeout(900)
        page.screenshot(path=str(OUTPUT_DIR / "planar-side-mirrors.png"))
        print("captured planar-side-mirrors.png")
        page.locator("#extraReflectors").uncheck()
        page.wait_for_timeout(300)

        page.locator('input[value="ssr"]').check()
        page.locator("#showRays").check()
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUTPUT_DIR / "ssr-hit-mask.png"))
        print("captured ssr-hit-mask.png")

        page.locator("#showRays").uncheck()
        page.locator("#showOffscreen").check()
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUTPUT_DIR / "offscreen-indicator.png"))
        print("captured offscreen-indicator.png")

        browser.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
