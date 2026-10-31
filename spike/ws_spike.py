#!/usr/bin/env python3
"""Protocol spike: stdlib-only WebSocket client for jcode's gateway.

Captures raw events, which is how the fixtures in ./fixtures were recorded.

    JCODE_HOST=your-mac.tailnet.ts.net JCODE_TOKEN=... WD=/abs/project python3 ws_spike.py "say hi"
    ... python3 ws_spike.py --history

Get a token by pairing once:  curl -X POST http://HOST:7643/pair -d '{"code":"123456","device_id":"spike","device_name":"spike"}'
"""
import base64, json, os, socket, struct, sys, time

HOST = os.environ.get("JCODE_HOST", "127.0.0.1")
PORT = int(os.environ.get("JCODE_PORT", "7643"))
TOKEN = os.environ.get("JCODE_TOKEN", "")


def connect():
    s = socket.create_connection((HOST, PORT), timeout=60)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /ws?token={TOKEN} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
               f"Origin: http://{HOST}:8765\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += s.recv(4096)
    head, rest = buf.split(b"\r\n\r\n", 1)
    print("HANDSHAKE:", head.split(b"\r\n")[0].decode(), file=sys.stderr)
    return s, rest


def send(s, obj):
    data = (json.dumps(obj) + "\n").encode()
    mask = os.urandom(4)
    n = len(data)
    hdr = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


class Reader:
    def __init__(self, s, rest):
        self.s, self.buf = s, rest

    def need(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise EOFError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def frame(self):
        b0, b1 = self.need(2)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self.need(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self.need(8))[0]
        return b0 & 0x0F, self.need(n)


def main():
    prompt = sys.argv[1] if len(sys.argv) > 1 else "Reply with exactly: pong"
    s, rest = connect()
    r = Reader(s, rest)
    sub = {"type": "subscribe", "id": 1}
    if os.environ.get("WD"):
        sub["working_dir"] = os.environ["WD"]
    if os.environ.get("TARGET"):
        sub["target_session_id"] = os.environ["TARGET"]
    send(s, sub)
    sent, deadline = False, time.time() + 120
    while time.time() < deadline:
        op, payload = r.frame()
        if op == 8:
            print("CLOSE", payload, file=sys.stderr)
            break
        if op != 1:
            continue
        for line in payload.decode().splitlines():
            if not line.strip():
                continue
            print(line, flush=True)
            ev = json.loads(line)
            if not sent and ev.get("type") in ("ack", "history", "done") and ev.get("id", 1) == 1:
                if prompt == "--history":
                    send(s, {"type": "get_history", "id": 2})
                else:
                    send(s, {"type": "message", "id": 2, "content": prompt})
                sent = True
            if sent and prompt == "--history" and ev.get("type") == "history":
                return
            if sent and ev.get("type") == "done" and ev.get("id") == 2:
                return


main()
