#!/usr/bin/env python3
"""jPhone push relay: notifications when jPhone is closed. Optional.

jcode's gateway only talks to connected clients, and phones suspend jPhone in
the background. This small service runs on the Mac next to jcode. It watches
the sessions you send messages to (as its own paired device, read-only) and,
when a turn finishes or fails, sends a Web Push to your phone. Messages are
end-to-end encrypted (RFC 8291): the push service (Apple, Google, Mozilla)
only sees ciphertext, timing and size.

Needs one package that the standard library lacks: `cryptography`.

    tools/push-relay.py --pair        # once: pair the relay with jcode
    tools/push-relay.py               # run (./install-macos.sh push runs it at login)

Then in jPhone (HTTPS, on iPhone from the Home Screen): Settings -> Push.
The app reaches the relay through serve.py at /push/, so nothing else is exposed.
"""
import argparse
import base64
import hashlib
import hmac
import http.server
import json
import os
import re
import shutil
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # pragma: no cover
    ec = None

STATE_PATH = os.path.expanduser(os.environ.get("JPHONE_PUSH_STATE", "~/.config/jphone/push.json"))
DEFAULT_PORT = 8766
WATCH_FOR = 6 * 3600  # keep watching a session this long after the last message from jPhone
# Request ids are per connection, and a `done` for another client's request
# carries that client's id. Ours sit far above anything a client counts up to,
# so a peer's `done` #2 is never mistaken for our own ack.
SUB_ID, STATE_ID, PING_ID = 2_000_000_001, 2_000_000_002, 2_000_000_003
OWN_IDS = frozenset((SUB_ID, STATE_ID, PING_ID))
SEEN_FRESH = 45  # jPhone was on screen this recently -> no push, you are looking at it
TOKEN_CACHE = 600
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s):
    s = s.strip().replace("+", "-").replace("/", "_")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# --- Web Push encryption (RFC 8291 / RFC 8188 aes128gcm) and VAPID (RFC 8292) ------------


def _hmac(key, data):
    return hmac.new(key, data, hashlib.sha256).digest()


def _point(pub):
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def encrypt(plaintext, ua_public, auth_secret, as_private=None, salt=None, rs=4096):
    """Encrypt one push message. `ua_public`/`auth_secret` come from the browser's subscription (bytes)."""
    if len(plaintext) > 3993:
        raise ValueError("push payload too large")
    as_private = as_private or ec.generate_private_key(ec.SECP256R1())
    salt = salt or os.urandom(16)
    # Raises ValueError for a point that is not on P-256 (RFC 8291 section 7).
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    as_public = _point(as_private.public_key())
    ecdh = as_private.exchange(ec.ECDH(), ua_key)
    ikm = _hmac(_hmac(auth_secret, ecdh), b"WebPush: info\x00" + ua_public + as_public + b"\x01")
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]
    ct = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)
    return salt + struct.pack(">IB", rs, len(as_public)) + as_public + ct


def vapid_header(endpoint, private_key, subject, now=None):
    aud = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(endpoint))
    claims = {"aud": aud, "exp": int(now or time.time()) + 12 * 3600, "sub": subject}
    signing_input = b64u(b'{"typ":"JWT","alg":"ES256"}') + "." + b64u(json.dumps(claims, separators=(",", ":")).encode())
    r, s = decode_dss_signature(private_key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
    jwt = signing_input + "." + b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={jwt}, k={b64u(_point(private_key.public_key()))}"


def send_push(sub, payload, private_key, subject, ttl=3600):
    """POST one message. Returns the HTTP status (201 = accepted; 404/410 = subscription gone)."""
    body = encrypt(json.dumps(payload).encode(), unb64u(sub["keys"]["p256dh"]), unb64u(sub["keys"]["auth"]))
    req = urllib.request.Request(
        sub["endpoint"],
        data=body,
        method="POST",
        headers={
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(ttl),
            "Urgency": "high",
            "Authorization": vapid_header(sub["endpoint"], private_key, subject),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def valid_endpoint(url):
    u = urllib.parse.urlsplit(url or "")
    return u.scheme == "https" and bool(u.hostname) and len(url) < 2048


# --- Turn tracking (pure, mirrors web/lib/notify.js) -------------------------------------


def friendly(session_id):
    m = re.match(r"session_([a-z0-9-]+)_\d+", session_id or "")
    return m.group(1) if m else ""


def one_line(text, limit=180):
    t = re.sub(r"```[\s\S]*?```", " [code] ", str(text))
    t = re.sub(r"[*_`#>]+", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[: limit - 1] + "…" if len(t) > limit else t


class TurnTracker:
    """Feed it the events an observer socket sees. Returns ("finished"|"error", detail) when a turn ends.

    Our own request ids are passed in `own_ids` so acks for the observer's
    subscribe/ping never count as a turn ending.
    """

    def __init__(self, session_id):
        self.session_id = session_id
        self.title = None
        self.active = False
        self.reply = ""

    @property
    def label(self):
        return self.title or friendly(self.session_id)

    def feed(self, ev, own_ids=()):
        t = ev.get("type")
        if t == "session_renamed":
            self.title = ev.get("title") or None
        elif t == "peer_user_message":
            self.active, self.reply = True, ""
        elif t == "state" and ev.get("is_processing"):
            self.active = True
        elif t == "text_delta" and self.active:
            self.reply += ev.get("text") or ""
        elif t == "text_replace" and self.active:
            self.reply = ev.get("text") or ""
        elif t == "tool_start" and self.active:
            self.reply = ""  # the answer is what comes after the last tool
        elif t == "interrupted":
            self.active = False  # a Stop you pressed is not news
        elif t == "error" and self.active and ev.get("id") not in own_ids:
            self.active = False
            return ("error", ev.get("message") or "The turn failed.")
        elif t == "done" and self.active and ev.get("id") not in own_ids:
            self.active = False
            return ("finished", self.reply)
        return None


def notice(kind, detail, label, hide):
    tag = "jphone-" + (label or "turn")
    if kind == "error":
        if hide:
            return {"title": "jcode stopped with an error", "body": "Open jPhone to see what happened.", "tag": tag}
        return {"title": "jcode error" + (f" · {label}" if label else ""), "body": one_line(detail), "tag": tag}
    if hide:
        return {"title": "jcode finished", "body": "Your turn. Open jPhone to see the reply.", "tag": tag}
    return {"title": "jcode finished" + (f" · {label}" if label else ""), "body": one_line(detail) or "Done.", "tag": tag}


# --- Minimal stdlib WebSocket client for the gateway -------------------------------------


class GatewaySocket:
    def __init__(self, host, port, token, timeout=60):
        self.s = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(
            (
                f"GET /ws?token={urllib.parse.quote(token)} HTTP/1.1\r\nHost: {host}:{port}\r\n"
                f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                f"Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.s.recv(4096)
            if not chunk:
                raise ConnectionError("gateway closed during handshake")
            buf += chunk
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n")[0].decode(errors="replace")
        if " 101 " not in status + " ":
            self.s.close()
            raise PermissionError(status)
        self.s.settimeout(timeout)
        self.lock = threading.Lock()

    def _frame(self, opcode, data):
        mask = os.urandom(4)
        n = len(data)
        if n < 126:
            hdr = struct.pack(">BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            hdr = struct.pack(">BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            hdr = struct.pack(">BBQ", 0x80 | opcode, 0x80 | 127, n)
        with self.lock:
            self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def send(self, obj):
        self._frame(1, (json.dumps(obj) + "\n").encode())

    def _need(self, n):
        idle = 0
        while len(self.buf) < n:
            try:
                chunk = self.s.recv(65536)
            except socket.timeout:
                # Quiet session: keep the socket alive. Three silent pings in a row = dead link.
                idle += 1
                if idle > 3:
                    raise ConnectionError("gateway stopped answering")
                self.send({"type": "ping", "id": PING_ID})
                continue
            idle = 0
            if not chunk:
                raise EOFError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def events(self):
        """Yields parsed JSON events. Raises on close or timeout."""
        partial = b""
        while True:
            b0, b1 = self._need(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._need(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._need(8))[0]
            payload = self._need(n)
            op = b0 & 0x0F
            if op == 8:
                raise EOFError("closed")
            if op == 9:
                self._frame(10, payload)
                continue
            if op not in (0, 1):
                continue
            partial += payload
            if not b0 & 0x80:
                continue
            for line in partial.decode(errors="replace").splitlines():
                if line.strip():
                    try:
                        yield json.loads(line)
                    except ValueError:
                        pass
            partial = b""

    def close(self):
        try:
            self._frame(8, b"")
        except OSError:
            pass
        self.s.close()


# --- State --------------------------------------------------------------------------------


class Store:
    def __init__(self, path=STATE_PATH):
        self.path = path
        self.lock = threading.RLock()
        try:
            with open(path) as f:
                self.data = json.load(f)
        except FileNotFoundError:
            self.data = {}
        self.data.setdefault("subscriptions", {})  # endpoint -> {sub, owner, hide, seen}

    def save(self):
        with self.lock:
            os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
            tmp = self.path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(self.data, f, indent=1)
            os.replace(tmp, self.path)

    def vapid_key(self):
        with self.lock:
            if "vapid_private" not in self.data:
                k = ec.generate_private_key(ec.SECP256R1())
                self.data["vapid_private"] = k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
                self.save()
            return serialization.load_pem_private_key(self.data["vapid_private"].encode(), None)


def token_owner(token):
    return hashlib.sha256(token.encode()).hexdigest()[:24]


# --- Relay --------------------------------------------------------------------------------


class Relay:
    def __init__(self, store, gw_host, gw_port, subject, sender=send_push):
        self.store = store
        self.gw_host, self.gw_port = gw_host, gw_port
        self.subject = subject
        self.sender = sender
        self.key = store.vapid_key()
        self.public_key = b64u(_point(self.key.public_key()))
        self.watches = {}  # session_id -> {"owners": set, "until": float, "thread": Thread}
        self.valid_tokens = {}  # owner -> checked_at
        self.lock = threading.Lock()

    # Device tokens are checked against jcode itself: a phone is allowed here
    # exactly when jcode would let it connect.
    def authorize(self, token):
        if not token or len(token) > 256:
            return None
        owner = token_owner(token)
        if time.time() - self.valid_tokens.get(owner, 0) < TOKEN_CACHE:
            return owner
        try:
            GatewaySocket(self.gw_host, self.gw_port, token).close()
        except PermissionError:
            return None
        except OSError as e:
            raise ConnectionError(f"jcode gateway unreachable at {self.gw_host}:{self.gw_port}: {e}")
        self.valid_tokens[owner] = time.time()
        return owner

    def subscribe(self, owner, sub, hide):
        if not (isinstance(sub, dict) and valid_endpoint(sub.get("endpoint")) and isinstance(sub.get("keys"), dict)):
            raise ValueError("bad subscription")
        keys = sub["keys"]
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64u(keys.get("p256dh", "")))
        if len(unb64u(keys.get("auth", ""))) != 16:
            raise ValueError("bad auth secret")
        with self.store.lock:
            subs = self.store.data["subscriptions"]
            subs[sub["endpoint"]] = {"sub": {"endpoint": sub["endpoint"], "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}}, "owner": owner, "hide": bool(hide), "seen": 0}
            self.store.save()

    def unsubscribe(self, owner, endpoint):
        with self.store.lock:
            entry = self.store.data["subscriptions"].get(endpoint)
            if entry and entry["owner"] == owner:
                del self.store.data["subscriptions"][endpoint]
                self.store.save()

    def seen(self, owner, endpoint, visible):
        with self.store.lock:
            entry = self.store.data["subscriptions"].get(endpoint)
            if entry and entry["owner"] == owner:
                entry["seen"] = time.time() if visible else 0  # in memory only, not worth a disk write

    def watch(self, owner, session_id):
        if not re.fullmatch(r"session_[A-Za-z0-9_-]{1,120}", session_id or ""):
            raise ValueError("bad session id")
        with self.lock:
            w = self.watches.get(session_id)
            if w and w["thread"].is_alive():
                w["owners"].add(owner)
                w["until"] = time.time() + WATCH_FOR
                return
            w = {"owners": {owner}, "until": time.time() + WATCH_FOR}
            w["thread"] = threading.Thread(target=self._observe, args=(session_id, w), daemon=True, name=f"watch-{friendly(session_id)}")
            self.watches[session_id] = w
            w["thread"].start()

    def _observe(self, session_id, w):
        tracker = TurnTracker(session_id)
        backoff = 1
        while time.time() < w["until"] or tracker.active:
            ws = None
            try:
                ws = GatewaySocket(self.gw_host, self.gw_port, self.store.data["relay_token"], timeout=30)
                # Attach read-only: no working_dir, no takeover, history skipped.
                ws.send({"type": "subscribe", "id": SUB_ID, "target_session_id": session_id, "client_instance_id": f"jphone-push-{friendly(session_id)}", "client_has_local_history": True})
                ws.send({"type": "state", "id": STATE_ID})
                log(f"watching {tracker.label}")
                backoff = 1
                for ev in ws.events():
                    if ev.get("type") == "session" and ev.get("session_id") not in (None, session_id):
                        log(f"{tracker.label}: gateway attached us to another session, stopping")
                        w["until"] = 0
                        break
                    result = tracker.feed(ev, OWN_IDS)
                    if result:
                        self.dispatch(w["owners"], result[0], result[1], tracker.label)
                    if time.time() > w["until"] and not tracker.active:
                        break
            except PermissionError as e:
                log(f"relay token rejected ({e}). Run: tools/push-relay.py --pair")
                time.sleep(60)
            except (OSError, EOFError, ConnectionError) as e:
                log(f"{tracker.label}: {e or type(e).__name__}, reconnecting in {backoff}s")
                time.sleep(backoff)
                backoff = min(60, backoff * 2)
            finally:
                if ws:
                    ws.close()
        with self.lock:
            if self.watches.get(session_id) is w:
                del self.watches[session_id]
        log(f"stopped watching {tracker.label}")

    def dispatch(self, owners, kind, detail, label, test=False):
        sent = 0
        now = time.time()
        with self.store.lock:
            targets = [(ep, dict(e)) for ep, e in self.store.data["subscriptions"].items() if e["owner"] in owners]
        for endpoint, entry in targets:
            if not test and now - entry.get("seen", 0) < SEEN_FRESH:
                continue  # jPhone is on screen on that phone
            payload = notice(kind, detail, label, entry.get("hide", True))
            try:
                status = self.sender(entry["sub"], payload, self.key, self.subject)
            except Exception as e:  # network trouble: try again next turn
                log(f"push failed: {e}")
                continue
            if status in (404, 410):
                log("subscription expired, removing it")
                with self.store.lock:
                    self.store.data["subscriptions"].pop(endpoint, None)
                    self.store.save()
            elif status >= 300:
                log(f"push service answered {status}")
            else:
                sent += 1
        if sent:
            log(f"pushed '{kind}' for {label} to {sent} device(s)")
        return sent


# --- HTTP API (reached through serve.py at /push/) --------------------------------------


class Api(http.server.BaseHTTPRequestHandler):
    relay = None
    server_version = "jphone-push"

    def log_message(self, fmt, *args):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/push/info":
            return self.reply(200, {"push": True, "vapid_key": self.relay.public_key})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 16384:
            return self.reply(413, {"error": "too large"})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.reply(400, {"error": "bad json"})
        auth = self.headers.get("Authorization", "")
        try:
            owner = self.relay.authorize(auth[7:] if auth.startswith("Bearer ") else "")
        except ConnectionError as e:
            return self.reply(502, {"error": str(e)})
        if not owner:
            return self.reply(401, {"error": "This device is not paired with jcode."})
        r = self.relay
        try:
            if self.path == "/push/subscribe":
                r.subscribe(owner, body.get("subscription"), body.get("hide", True))
            elif self.path == "/push/unsubscribe":
                r.unsubscribe(owner, body.get("endpoint"))
            elif self.path == "/push/watch":
                r.watch(owner, body.get("session_id"))
            elif self.path == "/push/seen":
                r.seen(owner, body.get("endpoint"), bool(body.get("visible")))
            elif self.path == "/push/test":
                sent = r.dispatch({owner}, "finished", "This is what a finished turn looks like.", "test", test=True)
                return self.reply(200, {"ok": True, "sent": sent})
            else:
                return self.reply(404, {"error": "not found"})
        except ValueError as e:
            return self.reply(400, {"error": str(e)})
        self.reply(200, {"ok": True})


class ApiServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# --- Setup --------------------------------------------------------------------------------


def pair_relay(store, gw_host, gw_port, code=None):
    if not code:
        exe = shutil.which("jcode")
        if not exe:
            sys.exit("jcode is not on PATH. Run `jcode pair` and pass --code.")
        p = subprocess.run([exe, "pair"], capture_output=True, text=True, timeout=30)
        out = ANSI.sub("", p.stdout + p.stderr)  # jcode prints the code on either stream
        m = re.search(r"Pairing code:\s*(\d{3})\s?(\d{3})", out)
        if not m:
            sys.exit("Could not read a pairing code from `jcode pair`:\n" + out)
        code = m.group(1) + m.group(2)
    req = urllib.request.Request(
        f"http://{gw_host}:{gw_port}/pair",
        data=json.dumps({"code": re.sub(r"\D", "", code), "device_id": "jphone-push-relay", "device_name": "jPhone push relay"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"Pairing failed: {e.read().decode(errors='replace')}")
    with store.lock:
        store.data["relay_token"] = res["token"]
        store.save()
    print(f"Paired the push relay with {res.get('server_name', 'jcode')}. Token saved in {store.path} (mode 600).")


def find_gateway(arg):
    if arg:
        host, _, port = arg.rpartition(":") if re.search(r":\d+$", arg) else (arg, "", "7643")
        return host.strip("[]"), int(port)
    for host in ("127.0.0.1",):
        try:
            socket.create_connection((host, 7643), timeout=2).close()
            return host, 7643
        except OSError:
            pass
    try:  # gateway bound to the Tailscale IP only
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
        from serve import tailscale_ip

        ip = tailscale_ip()
        if ip:
            return ip, 7643
    except Exception:
        pass
    return "127.0.0.1", 7643


def main():
    ap = argparse.ArgumentParser(description="Web Push relay for jPhone (optional).")
    ap.add_argument("--pair", action="store_true", help="pair the relay with jcode (runs `jcode pair`), then exit")
    ap.add_argument("--code", help="with --pair: use this pairing code instead of running `jcode pair`")
    ap.add_argument("--gateway", help="jcode gateway HOST:PORT (default: 127.0.0.1:7643, else the Tailscale IP)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("JPHONE_PUSH_PORT", DEFAULT_PORT)), help=f"local API port for serve.py (default {DEFAULT_PORT}, localhost only)")
    # Apple rejects a `localhost` contact (403 BadJwtToken), so the default is a
    # syntactically real address. It is only shown to push services, never mailed.
    ap.add_argument("--subject", default=os.environ.get("JPHONE_PUSH_SUBJECT", "mailto:jphone-relay@example.com"), help="VAPID contact (mailto: or https: URL)")
    args = ap.parse_args()
    if ec is None:
        sys.exit("The push relay needs the `cryptography` package:\n  python3 -m pip install --user cryptography\n(or ./install-macos.sh push, which sets up its own environment)")

    store = Store()
    gw_host, gw_port = find_gateway(args.gateway)
    if args.pair:
        return pair_relay(store, gw_host, gw_port, args.code)
    if not store.data.get("relay_token"):
        sys.exit("The relay is not paired with jcode yet. Run: tools/push-relay.py --pair")

    relay = Relay(store, gw_host, gw_port, args.subject)
    Api.relay = relay
    srv = ApiServer(("127.0.0.1", args.port), Api)
    log(f"jPhone push relay on 127.0.0.1:{args.port}, gateway {gw_host}:{gw_port}, {len(store.data['subscriptions'])} device(s) subscribed")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
