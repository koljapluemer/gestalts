# /// script
# requires-python = ">=3.12"
# dependencies = ["playwright==1.65.0"]
# ///
"""Renders a built viz in headless Chromium with every request blocked, at 360 and 1000 px, light and dark: uncaught
errors, console errors, blocked requests, overflow and empty renders. Writes check-<width>-<theme>.png and still.png
(800 px wide, light, cut to 5:3 at most). Adapted from thea's check.

    uv run --script check.py dist/index.html
"""

import sys
from pathlib import Path

VIEWS = ((360, "light"), (1000, "light"), (1000, "dark"))
SETTLE_MS = 800
MIN_HEIGHT = 8
MARKER = "data-gestalts-viz"


def render(browser, html: str, width: int, theme: str) -> tuple[list[str], int, bytes]:
    page = browser.new_page(viewport={"width": width, "height": 600}, color_scheme=theme)
    problems: list[str] = []
    page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append(f"uncaught: {e}"))

    def block(route):
        problems.append(f"blocked request (a viz must work offline): {route.request.url}")
        route.abort()

    page.route("**/*", block)
    try:
        page.set_content(html, wait_until="load")
        page.wait_for_timeout(SETTLE_MS)
        height = page.evaluate("() => Math.ceil(document.documentElement.getBoundingClientRect().height)")
        used = page.evaluate("() => document.documentElement.scrollWidth")
        if page.evaluate("() => !document.querySelector('.viz-root')"):
            problems.append("the runtime didn't mount: no .viz-root")
        error = page.evaluate("() => { const e = document.querySelector('.viz-error'); return e && !e.hidden ? e.textContent : null }")
        if error:
            problems.append(f"the viz showed an error: {error}")
        if height < MIN_HEIGHT:
            problems.append(f"the page is {height}px high: nothing visible was rendered")
        if used > width + 1:
            problems.append(f"horizontal overflow at {width}px wide: content is {used}px wide")
        return problems, height, page.screenshot(type="png", full_page=True)
    finally:
        page.close()


def still(browser, html: str) -> bytes:
    page = browser.new_page(viewport={"width": 800, "height": 480}, color_scheme="light")
    page.route("**/*", lambda route: route.abort())
    try:
        page.set_content(html, wait_until="load")
        page.wait_for_timeout(SETTLE_MS)
        height = page.evaluate("() => Math.ceil(document.documentElement.getBoundingClientRect().height)")
        return page.screenshot(type="png", clip={"x": 0, "y": 0, "width": 800, "height": min(max(height, 1), 480)})
    finally:
        page.close()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: check.py dist/index.html", file=sys.stderr)
        return 2
    html = Path(argv[1]).read_text(encoding="utf-8")
    if MARKER not in html:
        print(f"the page has no {MARKER}: build it with check.ts")
        return 1
    from playwright.sync_api import sync_playwright

    failed = False
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as error:  # no browser installed yet
            print(f"cannot start Chromium ({error}); install it with: uv run --with playwright==1.65.0 playwright install chromium")
            return 1
        try:
            for width, theme in VIEWS:
                problems, height, png = render(browser, html, width, theme)
                Path(f"check-{width}-{theme}.png").write_bytes(png)
                print(f"{'ok  ' if not problems else 'FAIL'} browser {width}px {theme}: {height}px high, check-{width}-{theme}.png")
                for problem in problems:
                    failed = True
                    print(f"     {problem}")
            Path("still.png").write_bytes(still(browser, html))
        finally:
            browser.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
