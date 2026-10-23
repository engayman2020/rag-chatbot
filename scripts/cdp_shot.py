"""
Minimal Chrome DevTools Protocol client built on the standard library.

Why not Playwright: neither `playwright` nor `websocket` is installed in this
environment, and adding a browser-automation dependency to a sales demo would be
absurd. CDP over a raw socket is ~60 lines and needs nothing.

Usage:
    python scripts/cdp_shot.py <port> <url> <outfile> [--wait 2.5] [--width 1280] [--height 900]
"""
import base64
import json
import socket
import struct
import sys
import time
import urllib.request


class WebSocket:
    """Just enough RFC 6455 to send text frames and receive fragmented binary/text."""

    def __init__(self, host: str, port: int, path: str):
        self.sock = socket.create_connection((host, port), timeout=30)
        # The Host header must carry the full host:port or Edge rejects the upgrade.
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        self._read_http_response()
        self._buffer = b""

    def _read_http_response(self) -> None:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("connection closed during WebSocket handshake")
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        status = head.split(b"\r\n", 1)[0].decode("latin1", "replace")
        if "101" not in status:
            raise RuntimeError(f"WebSocket upgrade failed: {status}")
        self._buffer = rest

    def _read_exact(self, n: int) -> bytes:
        while len(self._buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("socket closed")
            self._buffer += chunk
        out, self._buffer = self._buffer[:n], self._buffer[n:]
        return out

    def send(self, payload: str) -> None:
        data = payload.encode()
        header = bytearray([0x81])  # FIN + text
        length = len(data)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        mask = b"\x00\x00\x00\x00"  # zero mask is rejected by some clients; use a real one
        mask = bytes([0x12, 0x34, 0x56, 0x78])
        header[1] = 0x80 | (header[1] & 0x7F)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + mask + masked)

    def recv(self) -> str:
        """Return one complete message, reassembling continuation frames."""
        message = b""
        while True:
            b1, b2 = self._read_exact(2)
            fin = b1 & 0x80
            opcode = b1 & 0x0F
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read_exact(8))[0]
            payload = self._read_exact(length)
            if opcode == 0x9:  # ping
                continue
            if opcode == 0x8:  # close
                raise RuntimeError("server closed the WebSocket")
            message += payload
            if fin:
                return message.decode("utf-8", "replace")


class Tab:
    def __init__(self, port: int, url: str):
        self.port = port
        self.msg_id = 0
        self.ws = WebSocket("127.0.0.1", port, f"/devtools/page/{self._target_id(url)}")
        self.command("Page.enable")
        self.command("Runtime.enable")

    def _target_id(self, url: str) -> str:
        # Ask the browser to open the URL in a fresh tab and hand back its id.
        endpoint = f"http://127.0.0.1:{self.port}/json/new?{url}"
        req = urllib.request.Request(endpoint, method="PUT")
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read())["id"]

    def command(self, method: str, params: dict | None = None) -> dict:
        self.msg_id += 1
        self.ws.send(json.dumps({"id": self.msg_id, "method": method, "params": params or {}}))
        while True:
            reply = json.loads(self.ws.recv())
            if reply.get("id") == self.msg_id:
                if "error" in reply:
                    raise RuntimeError(f"{method} failed: {reply['error']}")
                return reply.get("result", {})

    def navigate(self, url: str, wait: float = 2.5) -> None:
        self.command("Page.navigate", {"url": url})
        time.sleep(wait)

    def evaluate(self, expression: str) -> object:
        result = self.command("Runtime.evaluate", {"expression": expression, "returnByValue": True})
        return result.get("result", {}).get("value")

    def screenshot(self, path: str) -> str:
        result = self.command("Page.captureScreenshot", {"format": "png"})
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(result["data"]))
        return path

    def screenshot_element(self, path: str, selector: str) -> str:
        """Capture one element, cropped — used for shots that must not show the page chrome."""
        box = self.measure(selector)
        if not box:
            raise RuntimeError(f"element not found: {selector}")
        # Give the viewport room for everything above the element, so the layout does not
        # shift (and the clip does not run off the bottom) when we re-measure.
        self.command("Emulation.setDeviceMetricsOverride", {
            "width": max(900, int(box["width"]) + 4),
            "height": int(box["y"] + box["height"]) + 20,
            "deviceScaleFactor": 2, "mobile": False,
        })
        time.sleep(0.4)  # let the layout settle at the new viewport before measuring again
        box = self.measure(selector)
        result = self.command("Page.captureScreenshot", {
            "format": "png",
            "captureBeyondViewport": True,
            "clip": {"x": box["x"], "y": box["y"], "width": box["width"], "height": box["height"], "scale": 2},
        })
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(result["data"]))
        return path

    def measure(self, selector: str) -> dict | None:
        return self.evaluate(
            "(() => { const el = document.querySelector(%s); if (!el) return null;"
            " const r = el.getBoundingClientRect();"
            " return { x: r.x, y: r.y, width: r.width, height: r.height }; })()" % json.dumps(selector)
        )

    def set_viewport(self, width: int, height: int) -> None:
        self.command("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
        })


def main() -> None:
    port = int(sys.argv[1])
    url = sys.argv[2]
    out = sys.argv[3]
    wait = 2.5
    width, height = 1280, 900
    for i, arg in enumerate(sys.argv):
        if arg == "--wait":
            wait = float(sys.argv[i + 1])
        if arg == "--width":
            width = int(sys.argv[i + 1])
        if arg == "--height":
            height = int(sys.argv[i + 1])

    tab = Tab(port, url)
    tab.set_viewport(width, height)
    tab.navigate(url, wait=wait)
    print(tab.screenshot(out))


if __name__ == "__main__":
    main()
