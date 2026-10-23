"""
Capture the walkthrough screenshots for the README.

Drives the real UI in headless Edge over CDP: asks a question, waits for the answer,
captures it, then repeats for the refusal case and the admin panel.

Usage: python scripts/capture_walkthrough.py <port> <base_url> <shots_dir>
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp_shot import Tab  # noqa: E402

# React ignores a plain value assignment, so set it through the prototype setter
# and dispatch a real input event. Submitting via requestSubmit() would use the Send
# button as the submitter, which is still disabled until React re-renders — so fire
# the submit event directly instead.
ASK_JS = """
(() => {
  const input = document.querySelector('#question');
  if (!input) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, %s);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return 'submitted';
})()
"""


BUBBLE_SELECTOR = "section div.max-w-\\[85\\%\\]"

ENTER_KEY = {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13}


def message_count(tab: Tab) -> int:
    return int(tab.evaluate(f"document.querySelectorAll('{BUBBLE_SELECTOR}').length") or 0)


def is_busy(tab: Tab) -> bool:
    return bool(
        tab.evaluate(
            "!!Array.from(document.querySelectorAll('section p'))"
            ".find(p => p.textContent.includes('Looking that up'))"
        )
    )


def click_send(tab: Tab) -> None:
    """Click the Send button with a real CDP mouse event.

    Pressing Enter is unreliable here (the form's submitter is a disabled button until
    React re-renders), so do what a user does and click.
    """
    box = tab.evaluate(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => x.textContent.trim() === 'Send');"
        " if (!b) return null; const r = b.getBoundingClientRect();"
        " return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled }; })()"
    )
    if not box:
        raise RuntimeError("Send button not found")
    if box["disabled"]:
        raise RuntimeError("Send button is disabled — the typed text did not reach React state")
    for event_type in ("mousePressed", "mouseReleased"):
        tab.command("Input.dispatchMouseEvent", {
            "type": event_type,
            "x": box["x"],
            "y": box["y"],
            "button": "left",
            "clickCount": 1,
        })


def ask(tab: Tab, question: str) -> None:
    """Type a question the way a user would and wait for the reply to render.

    Uses CDP input events rather than synthetic DOM events: React's controlled input
    only picks up value changes it can see through the real input pipeline.
    """
    before = message_count(tab)
    tab.evaluate("document.querySelector('#question').focus()")
    tab.command("Input.insertText", {"text": question})
    time.sleep(0.4)  # let React flush the controlled-input state update
    click_send(tab)

    for _ in range(80):
        time.sleep(0.5)
        if message_count(tab) > before and not is_busy(tab):
            time.sleep(0.8)  # let the citations render
            return
    raise RuntimeError(f"timed out waiting for an answer to: {question}")


def main() -> None:
    port = int(sys.argv[1])
    base = sys.argv[2]
    outdir = sys.argv[3]
    os.makedirs(outdir, exist_ok=True)

    tab = Tab(port, f"{base}/")
    tab.set_viewport(1280, 900)
    tab.navigate(f"{base}/", wait=4)

    ask(tab, "What is the refund window?")
    tab.screenshot(os.path.join(outdir, "1-answer-with-citations.png"))
    print("captured 1-answer-with-citations.png")

    ask(tab, "Who won the 1998 World Cup?")
    tab.screenshot(os.path.join(outdir, "2-refusal-out-of-scope.png"))
    print("captured 2-refusal-out-of-scope.png")

    ask(tab, "How do I request a refund?")
    tab.screenshot(os.path.join(outdir, "3-pii-redacted.png"))
    print("captured 3-pii-redacted.png")

    tab.navigate(f"{base}/admin", wait=4)
    tab.screenshot(os.path.join(outdir, "4-admin-cost-and-logs.png"))
    print("captured 4-admin-cost-and-logs.png")


if __name__ == "__main__":
    main()
