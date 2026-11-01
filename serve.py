#!/usr/bin/env python3
"""Serve jPhone's static files. Standard library only.

    python3 serve.py                       # Tailscale IP (auto) + localhost, port 8765
    python3 serve.py --port 9000
    python3 serve.py --bind 100.101.102.103 --bind 127.0.0.1

jPhone talks to jcode's own gateway (port 7643) directly from the browser.
This server only hands out the HTML/CSS/JS. It never sees your messages or token.
"""
import argparse
import functools
import http.server
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


def tailscale_ip():
    """Find this machine's Tailscale IPv4 (100.64.0.0/10), CLI first, then interfaces."""
    candidates = [
        shutil.which("tailscale"),
        "/opt/homebrew/opt/tailscale/bin/tailscale",
        "/usr/local/opt/tailscale/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]
    for exe in filter(None, candidates):
        if not os.path.exists(exe):
            continue
        try:
            out = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=3).stdout.strip()
            if out:
                return out.splitlines()[0]
        except Exception:
            pass
    # Fallback: scan interfaces for a CGNAT address (Tailscale's range).
    for cmd in (["ifconfig"], ["ip", "-4", "addr"]):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
        except Exception:
            continue
        for m in re.finditer(r"inet (100\.(\d+)\.\d+\.\d+)", out):
            if 64 <= int(m.group(2)) <= 127:
                return m.group(1)
    return None


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        # Always revalidate so updates land on the phone immediately.
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        # The full CSP is a <meta> tag in index.html, so it also applies behind
        # other servers. frame-ancestors only works as a header.
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("JPHONE_QUIET"):
            return
        sys.stderr.write("%s  %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description="Serve the jPhone web app")
    ap.add_argument("--port", type=int, default=int(os.environ.get("JPHONE_PORT", 8765)))
    ap.add_argument("--bind", action="append", help="address to bind (repeatable). Default: Tailscale IP + 127.0.0.1")
    ap.add_argument("--require-tailscale", action="store_true", help="exit with an error if no Tailscale IP is found (lets a service manager retry)")
    args = ap.parse_args()

    binds = args.bind
    if not binds:
        ts = tailscale_ip()
        if not ts and args.require_tailscale:
            print("! Tailscale IP not found yet. Exiting so the service manager retries.", file=sys.stderr)
            sys.exit(3)
        binds = ([ts] if ts else []) + ["127.0.0.1"]
        if not ts:
            print("! Tailscale IP not found. Serving on localhost only. Use --bind to choose an address.", file=sys.stderr)

    handler = functools.partial(Handler, directory=ROOT)
    servers = []
    for addr in binds:
        try:
            servers.append(Server((addr, args.port), handler))
        except OSError as e:
            print(f"! could not bind {addr}:{args.port}: {e}", file=sys.stderr)
    if not servers:
        sys.exit(1)

    print("jPhone is up:")
    for s in servers:
        host = s.server_address[0]
        print(f"  http://{host}:{args.port}")
    print("Open it on your phone (with Tailscale on). Ctrl+C to stop.", flush=True)

    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
