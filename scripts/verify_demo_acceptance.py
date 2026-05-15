#!/usr/bin/env python3
"""End-to-end acceptance checks for the reflection comparison demo."""

from __future__ import annotations

from io import BytesIO
import sys
import time

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from verify_ssr_visual import (
    DEVICE_SCALE_FACTOR,
    VIEWPORT,
    find_chrome,
    read_float,
    static_server,
)


MODE_TITLES = {
    "cubemap": "Cubemap",
    "planar": "Planar reflection",
    "ssr": "Screen-space reflections",
    "ssrFallback": "SSR with cubemap fallback",
}

VIEWPORT_BOX = (0, 48, 980, 800)
FLOOR_BOX = (0, 420, 980, 760)
SIDE_MIRROR_BOX = (0, 70, 980, 760)
SSR_MISS_BOX = (0, 420, 980, 760)
TEAL_OBJECT_BOX = (610, 420, 810, 570)
TEAL_REFLECTION_BOX = (610, 560, 810, 735)


def fail(message: str, failures: list[str]) -> None:
    failures.append(message)


def screenshot_image(page) -> Image.Image:
    return Image.open(BytesIO(page.screenshot())).convert("RGB")


def luminance_stats(image: Image.Image, box: tuple[int, int, int, int]) -> tuple[float, float]:
    crop = image.crop(box).convert("L")
    stat = ImageStat.Stat(crop)
    return stat.mean[0], stat.stddev[0]


def mean_abs_diff(a: Image.Image, b: Image.Image, box: tuple[int, int, int, int]) -> float:
    diff = ImageChops.difference(a.crop(box), b.crop(box)).convert("L")
    return ImageStat.Stat(diff).mean[0]


def count_pixels(image: Image.Image, box: tuple[int, int, int, int], predicate) -> int:
    count = 0
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            if predicate(image.getpixel((x, y))):
                count += 1
    return count


def pixel_centroid(
    image: Image.Image,
    box: tuple[int, int, int, int],
    predicate,
) -> tuple[float, float, int]:
    total_x = 0
    total_y = 0
    count = 0
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            if predicate(image.getpixel((x, y))):
                total_x += x
                total_y += y
                count += 1

    if count == 0:
        return 0.0, 0.0, 0
    return total_x / count, total_y / count, count


def is_dark_teal_reflection(pixel: tuple[int, int, int]) -> bool:
    r, g, b = pixel
    return r < 90 and 20 < g < 150 and 20 < b < 160 and g > r * 1.35 and b > r * 1.1


def is_teal_object(pixel: tuple[int, int, int]) -> bool:
    r, g, b = pixel
    return r < 150 and g > 90 and b > 70 and g > r * 1.15


def is_ssr_miss_pixel(pixel: tuple[int, int, int]) -> bool:
    r, g, b = pixel
    return r > 120 and g < 90 and b < 90 and r > g * 1.7 and r > b * 1.7


def check_planar_geometry(
    cubemap: Image.Image,
    planar: Image.Image,
    failures: list[str],
) -> tuple[int, int]:
    object_x, object_y, object_count = pixel_centroid(planar, TEAL_OBJECT_BOX, is_teal_object)
    reflection_x, reflection_y, reflection_count = pixel_centroid(
        planar,
        TEAL_REFLECTION_BOX,
        is_dark_teal_reflection,
    )
    cubemap_reflection_count = count_pixels(cubemap, TEAL_REFLECTION_BOX, is_dark_teal_reflection)

    if object_count < 1500:
        fail(f"planar teal source object was not detected: pixels={object_count}", failures)
    if reflection_count < 1500:
        fail(f"planar teal reflection was not detected: pixels={reflection_count}", failures)
    if reflection_count <= cubemap_reflection_count * 8 + 500:
        fail(
            "planar teal reflection is not clearly stronger than cubemap "
            f"(planar={reflection_count}, cubemap={cubemap_reflection_count})",
            failures,
        )
    if object_count and reflection_count:
        if abs(object_x - reflection_x) > 55:
            fail(
                "planar teal reflection is not horizontally aligned with the source object "
                f"(object x={object_x:.1f}, reflection x={reflection_x:.1f})",
                failures,
            )
        if reflection_y <= object_y + 80:
            fail(
                "planar teal reflection is not below the source object "
                f"(object y={object_y:.1f}, reflection y={reflection_y:.1f})",
                failures,
            )

    return reflection_count, cubemap_reflection_count


def check_ssr_fallback_misses(
    ssr: Image.Image,
    ssr_fallback: Image.Image,
    hit_mask: Image.Image,
    failures: list[str],
) -> tuple[int, float, float]:
    miss_count = 0
    diff_total = 0.0
    ssr_luma_total = 0.0
    fallback_luma_total = 0.0

    for y in range(SSR_MISS_BOX[1], SSR_MISS_BOX[3]):
        for x in range(SSR_MISS_BOX[0], SSR_MISS_BOX[2]):
            if not is_ssr_miss_pixel(hit_mask.getpixel((x, y))):
                continue
            miss_count += 1
            ssr_pixel = ssr.getpixel((x, y))
            fallback_pixel = ssr_fallback.getpixel((x, y))
            diff_total += sum(abs(fallback_pixel[i] - ssr_pixel[i]) for i in range(3)) / 3
            ssr_luma_total += sum(ssr_pixel) / 3
            fallback_luma_total += sum(fallback_pixel) / 3

    if miss_count == 0:
        fail("SSR hit mask did not expose miss pixels for fallback validation", failures)
        return 0, 0.0, 0.0

    mean_diff = diff_total / miss_count
    luma_delta = (fallback_luma_total - ssr_luma_total) / miss_count

    if miss_count < 20_000:
        fail(f"too few SSR miss pixels for fallback validation: {miss_count}", failures)
    if mean_diff < 8:
        fail(f"SSR fallback barely changes SSR miss pixels: diff={mean_diff:.1f}", failures)
    if luma_delta < 6:
        fail(f"SSR fallback does not brighten miss pixels enough: delta={luma_delta:.1f}", failures)

    return miss_count, mean_diff, luma_delta


def check_side_mirror_toggle(page, failures: list[str]) -> dict[str, float]:
    toggle = page.locator("#extraReflectors")
    if toggle.count() == 0:
        fail("side mirror toggle is missing", failures)
        return {}
    if toggle.is_checked():
        fail("side mirror toggle should be off by default", failures)
        toggle.uncheck()

    diffs: dict[str, float] = {}
    for mode in MODE_TITLES:
        page.locator(f'input[value="{mode}"]').check()
        page.wait_for_timeout(650)
        if toggle.is_checked():
            toggle.uncheck()
            page.wait_for_timeout(500)
        without_mirrors = screenshot_image(page)
        toggle.check()
        page.wait_for_timeout(700)
        with_mirrors = screenshot_image(page)
        diff = mean_abs_diff(without_mirrors, with_mirrors, SIDE_MIRROR_BOX)
        diffs[mode] = diff
        if diff < 2.5:
            fail(f"side mirrors did not visibly affect {mode}: diff={diff:.1f}", failures)

    page.locator('input[value="cubemap"]').check()
    page.wait_for_timeout(450)
    if not toggle.is_checked():
        fail("side mirror toggle did not persist after mode switching", failures)

    toggle.uncheck()
    page.wait_for_timeout(450)
    return diffs


def set_range(page, selector: str, value: str) -> None:
    page.locator(selector).evaluate(
        """(el, value) => {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }""",
        value,
    )


def main() -> int:
    chrome = find_chrome()
    if not chrome:
        print("Chrome/Chromium executable not found.", file=sys.stderr)
        return 2

    failures: list[str] = []
    console_messages: list[str] = []
    page_errors: list[str] = []

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
        page.on("console", lambda msg: console_messages.append(f"{msg.type}: {msg.text}"))
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        started = time.perf_counter()
        page.goto(url, wait_until="networkidle", timeout=60_000)
        page.wait_for_timeout(1500)
        load_ms = (time.perf_counter() - started) * 1000

        if load_ms > 10_000:
            fail(f"page load took too long: {load_ms:.0f} ms", failures)

        if not page.locator('input[value="hybrid"]').is_disabled():
            fail("Hybrid ray tracing radio is not disabled", failures)

        side_mirror_diffs = check_side_mirror_toggle(page, failures)

        mode_images: dict[str, Image.Image] = {}
        for mode, expected_title in MODE_TITLES.items():
            page.locator(f'input[value="{mode}"]').check()
            page.wait_for_timeout(650)
            checked = page.locator('input[name="mode"]:checked').input_value()
            if checked != mode:
                fail(f"{mode} radio did not become active", failures)

            title = page.locator("#methodInfoTitle").text_content()
            if title != expected_title:
                fail(f"{mode} method title was {title!r}", failures)

            image = screenshot_image(page)
            mode_images[mode] = image
            mean, stddev = luminance_stats(image, VIEWPORT_BOX)
            if mean < 10 or stddev < 8:
                fail(f"{mode} viewport looks blank: mean={mean:.1f}, stddev={stddev:.1f}", failures)

        planar_reflection_count, cubemap_reflection_count = check_planar_geometry(
            mode_images["cubemap"],
            mode_images["planar"],
            failures,
        )

        page.locator('input[value="cubemap"]').check()
        page.wait_for_timeout(500)
        set_range(page, "#roughness", "0")
        page.wait_for_timeout(500)
        rough_low = screenshot_image(page)
        set_range(page, "#roughness", "1")
        page.wait_for_timeout(500)
        rough_high = screenshot_image(page)
        if page.locator("#roughnessValue").text_content() != "1.00":
            fail("roughness readout did not update to 1.00", failures)
        rough_diff = mean_abs_diff(rough_low, rough_high, FLOOR_BOX)
        if rough_diff < 5:
            fail(f"roughness did not visibly affect the floor: diff={rough_diff:.1f}", failures)

        before_camera = screenshot_image(page)
        page.locator("#lookAtHidden").click()
        page.wait_for_timeout(800)
        hidden_camera = screenshot_image(page)
        if mean_abs_diff(before_camera, hidden_camera, VIEWPORT_BOX) < 4:
            fail("Look at Hidden Cube did not visibly change the camera", failures)

        page.locator("#resetView").click()
        page.wait_for_timeout(800)
        reset_camera = screenshot_image(page)
        if mean_abs_diff(hidden_camera, reset_camera, VIEWPORT_BOX) < 4:
            fail("Reset View did not visibly change the camera back", failures)

        set_range(page, "#roughness", "0.2")
        page.wait_for_timeout(500)
        page.locator('input[value="ssr"]').check()
        page.wait_for_timeout(650)
        page.locator("#showDepth").check()
        page.wait_for_timeout(250)
        page.locator("#showRays").check()
        page.wait_for_timeout(250)
        if page.locator("#showDepth").is_checked():
            fail("depth debug stayed checked after enabling hit-mask debug", failures)
        if not page.locator("#showRays").is_checked():
            fail("hit-mask debug did not stay checked", failures)
        if read_float(page.locator("#ssrMetric").text_content()) <= 0:
            fail("SSR timing metric did not update", failures)

        hit_mask = screenshot_image(page)
        page.locator("#showRays").uncheck()
        page.wait_for_timeout(500)
        ssr_no_fallback = screenshot_image(page)
        page.locator('input[value="ssrFallback"]').check()
        page.wait_for_timeout(650)
        ssr_with_fallback = screenshot_image(page)
        fallback_miss_count, fallback_miss_diff, fallback_luma_delta = check_ssr_fallback_misses(
            ssr_no_fallback,
            ssr_with_fallback,
            hit_mask,
            failures,
        )

        page.locator("#showOffscreen").check()
        page.wait_for_timeout(300)
        if not page.locator("#offscreenIndicator").is_visible():
            fail("off-screen indicator did not become visible", failures)

        page.locator("#methodInfo summary").click()
        page.wait_for_timeout(200)
        if page.locator("#methodInfo").evaluate("el => el.open"):
            fail("method info did not collapse", failures)
        page.locator("#methodInfo summary").click()
        page.wait_for_timeout(200)
        if not page.locator("#methodInfo").evaluate("el => el.open"):
            fail("method info did not reopen", failures)

        page.locator("#aboutBtn").click()
        page.wait_for_timeout(250)
        if not page.locator("#aboutModal").is_visible():
            fail("About modal did not open", failures)
        about_text = page.locator("#aboutModal").inner_text()
        if "CENG510" not in about_text or "Cubemaps" not in about_text or "SSR" not in about_text:
            fail("About modal is missing core project content", failures)
        if page.locator('#aboutModal a[href*="jcgt.org"]').count() == 0:
            fail("About modal does not link the McGuire & Mara SSR paper", failures)
        if page.locator('#aboutModal a[href*="selfshadow.com"]').count() == 0:
            fail("About modal does not link the Karis PBR reference", failures)
        page.locator(".modal__close").click()
        page.wait_for_timeout(250)
        if page.locator("#aboutModal").is_visible():
            fail("About modal did not close", failures)

        for _ in range(12):
            for mode in MODE_TITLES:
                page.locator(f'input[value="{mode}"]').check()
                page.wait_for_timeout(80)

        browser.close()

    if console_messages:
        fail("browser console was not clean: " + " | ".join(console_messages), failures)
    if page_errors:
        fail("page errors occurred: " + " | ".join(page_errors), failures)

    print(f"load time: {load_ms:.0f} ms")
    if side_mirror_diffs:
        print(
            "side mirror diffs: "
            + ", ".join(f"{mode}={diff:.1f}" for mode, diff in side_mirror_diffs.items())
        )
    print(f"roughness floor diff: {rough_diff:.1f}")
    print(
        "planar teal reflection pixels: "
        f"{planar_reflection_count} (cubemap comparison: {cubemap_reflection_count})"
    )
    print(
        "SSR fallback miss pixels: "
        f"{fallback_miss_count}, diff={fallback_miss_diff:.1f}, "
        f"luma delta={fallback_luma_delta:.1f}"
    )
    print(f"console messages: {len(console_messages)}")
    print(f"page errors: {len(page_errors)}")

    if failures:
        for failure in failures:
            print(f"Demo acceptance failed: {failure}.", file=sys.stderr)
        return 1

    print("Demo acceptance passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
