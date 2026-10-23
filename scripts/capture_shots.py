"""Capture the live UI for the marketing shots.

Drives the real chat widget in headless Edge over CDP and captures the widget element
itself (cropped, 2x) so the shots contain no browser chrome.

Usage: python scripts/capture_shots.py <cdp_port> <base_url> <outdir>
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp_shot import Tab  # noqa: E402

BUBBLE = 'section div[class*="max-w-[85%]"]'
WIDGET = "section"


def bubbles(tab):
    return int(tab.evaluate(f"document.querySelectorAll(`{BUBBLE}`).length") or 0)


def is_busy(tab):
    return bool(
        tab.evaluate(
            "!!Array.from(document.querySelectorAll('section p')).find(p => p.textContent.includes('Looking that up'))"
        )
    )


def click_send(tab):
    box = tab.evaluate(
        "(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Send');"
        " if (!b) return null; const r = b.getBoundingClientRect();"
        " return { x: r.x + r.width/2, y: r.y + r.height/2, disabled: b.disabled }; })()"
    )
    if not box:
        raise RuntimeError("Send button not found")
    if box["disabled"]:
        raise RuntimeError("Send button still disabled — typed text did not reach React state")
    for event_type in ("mousePressed", "mouseReleased"):
        tab.command(
            "Input.dispatchMouseEvent",
            {"type": event_type, "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1},
        )


def ask(tab, question, timeout_s=40):
    before = bubbles(tab)
    tab.evaluate("document.querySelector('#question').focus()")
    tab.command("Input.insertText", {"text": question})
    time.sleep(0.5)
    click_send(tab)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(0.5)
        if bubbles(tab) > before and not is_busy(tab):
            time.sleep(1.0)  # let citations render
            return
    raise RuntimeError(f"timed out waiting for an answer to: {question}")


def expand_widget(tab):
    """The widget's message area is a fixed-height scroller, which hides older replies.

    For a shot we want the whole conversation in frame, so let the section grow to its
    content instead of clipping.
    """
    tab.evaluate(
        "(() => { const s = document.querySelector('section'); if (!s) return 'no section';"
        " s.style.minHeight = '0';"
        " const scroller = s.querySelector('div.flex-1');"
        " if (scroller) { scroller.style.overflow = 'visible'; scroller.style.flex = 'none'; }"
        " return 'expanded'; })()"
    )
    time.sleep(0.6)


def hide_dev_tools(tab):
    """Remove the Next.js dev indicator so the shot shows only the product."""
    tab.evaluate(
        "(() => { document.querySelectorAll('nextjs-portal').forEach(el => el.remove());"
        " const b = document.querySelector('[data-nextjs-dialog]');"
        " if (b) b.parentElement && b.parentElement.parentElement && b.parentElement.parentElement.remove();"
        " return 'clean'; })()"
    )
    time.sleep(0.4)


def main():
    port = int(sys.argv[1])
    base = sys.argv[2]
    outdir = sys.argv[3]
    # `--only widget|admin` lets the admin shot land in the same instant as the
    # evidence snapshot, so the numbers on the image match the panel it shows.
    argv = sys.argv[4:]
    only = "all"
    if "--only" in argv:
        only = argv[argv.index("--only") + 1]
    os.makedirs(outdir, exist_ok=True)

    if only in ("all", "widget"):
        tab = Tab(port, f"{base}/")
        tab.set_viewport(1000, 1000)
        tab.navigate(f"{base}/", wait=5)
        hide_dev_tools(tab)

        # The thumbnail: one clean, grounded exchange with a visible citation.
        ask(tab, "What is the refund window?")
        hide_dev_tools(tab)
        expand_widget(tab)
        tab.screenshot_element(os.path.join(outdir, "widget-answer.png"), WIDGET)
        print("captured widget-answer.png")

        # The contrast shot: the same corpus holds a hostile document claiming the
        # opposite answer, plus a refusal for an out-of-scope question.
        ask(tab, "Who won the 1998 World Cup?")
        hide_dev_tools(tab)
        expand_widget(tab)
        tab.screenshot_element(os.path.join(outdir, "widget-contrast.png"), WIDGET)
        print("captured widget-contrast.png")

    if only in ("all", "admin"):
        tab = Tab(port, f"{base}/admin")
        tab.set_viewport(1440, 1100)
        tab.navigate(f"{base}/admin", wait=6)
        hide_dev_tools(tab)
        tab.screenshot(os.path.join(outdir, "admin-live.png"))
        print("captured admin-live.png")


if __name__ == "__main__":
    main()
