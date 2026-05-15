#!/usr/bin/env python3
"""Visual smoke test for the SSR mode.

The project intentionally has no build step, so this script starts a local
static server, opens the demo in Chrome via Playwright, and compares fixed
regions in Cubemap and SSR modes. It catches the regression where SSR suppresses
the reflective material lighting and leaves the floor/sphere nearly black.
"""

from __future__ import annotations

import contextlib
import io
import shutil
import statistics
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
VIEWPORT = {"width": 1280, "height": 800}
DEVICE_SCALE_FACTOR = 1
CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)


class QuietHTTPRequestHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        return


def find_chrome() -> str | None:
    for candidate in CHROME_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    return shutil.which("google-chrome") or shutil.which("chromium")


@contextlib.contextmanager
def static_server():
    handler = partial(QuietHTTPRequestHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def luminance_median(png_bytes: bytes, box: tuple[int, int, int, int]) -> float:
    image = Image.open(io.BytesIO(png_bytes)).convert("L")
    return statistics.median(image.crop(box).getdata())


def capture_mode(page, mode: str) -> bytes:
    page.locator(f'input[value="{mode}"]').check()
    page.wait_for_timeout(900)
    return page.screenshot()


def read_float(text: str | None) -> float:
    try:
        return float(text or "")
    except ValueError:
        return 0.0


def optional_text(page, selector: str) -> str:
    locator = page.locator(selector)
    if locator.count() == 0:
        return ""
    return locator.text_content() or ""


def optional_inner_text(page, selector: str) -> str:
    locator = page.locator(selector)
    if locator.count() == 0:
        return ""
    return locator.inner_text()


def main() -> int:
    chrome = find_chrome()
    if not chrome:
        print("Chrome/Chromium executable not found.", file=sys.stderr)
        return 2

    # Coordinates are fixed by VIEWPORT. These regions cover the primary
    # reflective sphere and the central floor area without touching the UI.
    sphere_box = (380, 280, 610, 520)
    floor_box = (0, 420, 980, 760)

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

        cubemap = capture_mode(page, "cubemap")
        method_info = page.locator("#methodInfo")
        method_info_visible = method_info.count() > 0 and method_info.is_visible()
        cubemap_title = optional_text(page, "#methodInfoTitle")
        cubemap_summary = optional_text(page, "#methodInfo summary")

        ssr = capture_mode(page, "ssr")
        ssr_time = read_float(page.locator("#ssrMetric").text_content())
        ssr_title = optional_text(page, "#methodInfoTitle")
        ssr_info_text = optional_inner_text(page, "#methodInfo")
        hit_mask_label = page.locator('label:has(#showRays) span').text_content()

        page.locator("#showOffscreen").check()
        page.wait_for_timeout(300)
        offscreen_indicator = page.locator("#offscreenIndicator")
        offscreen_indicator_visible = offscreen_indicator.is_visible()
        offscreen_indicator_box = offscreen_indicator.bounding_box()
        browser.close()

    cubemap_sphere = luminance_median(cubemap, sphere_box)
    cubemap_floor = luminance_median(cubemap, floor_box)
    ssr_sphere = luminance_median(ssr, sphere_box)
    ssr_floor = luminance_median(ssr, floor_box)

    print(f"cubemap sphere median: {cubemap_sphere:.1f}")
    print(f"ssr sphere median:     {ssr_sphere:.1f}")
    print(f"cubemap floor median:  {cubemap_floor:.1f}")
    print(f"ssr floor median:      {ssr_floor:.1f}")
    print(f"ssr time metric:       {ssr_time:.2f} ms")

    failures = []
    if ssr_sphere < cubemap_sphere * 0.35 or ssr_floor < cubemap_floor * 0.35:
        failures.append("reflective surfaces are too dark")
    if ssr_time <= 0.0:
        failures.append("SSR time metric did not update")
    if not method_info_visible:
        failures.append("method info panel is not visible")
    if "Technique notes" not in cubemap_summary:
        failures.append("method info panel is not collapsible")
    if cubemap_title != "Cubemap":
        failures.append("method info panel does not describe cubemap by default")
    if ssr_title != "Screen-space reflections":
        failures.append("method info panel does not update with SSR mode")
    if "try this" not in ssr_info_text.lower() or "screen edge" not in ssr_info_text:
        failures.append("SSR method info does not include test guidance")
    if hit_mask_label != "Show SSR hit mask":
        failures.append("SSR debug label does not describe the hit-mask view")
    if not offscreen_indicator_visible:
        failures.append("off-screen indicator is not visible when enabled")
    elif (
        offscreen_indicator_box is None
        or offscreen_indicator_box["x"] < 0
        or offscreen_indicator_box["y"] < 0
        or offscreen_indicator_box["x"] + offscreen_indicator_box["width"] > VIEWPORT["width"]
        or offscreen_indicator_box["y"] + offscreen_indicator_box["height"] > VIEWPORT["height"]
    ):
        failures.append("off-screen indicator is clipped by the viewport")

    if failures:
        for failure in failures:
            print(f"SSR visual check failed: {failure}.", file=sys.stderr)
        return 1

    print("SSR visual check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
