#!/bin/sh
# HTTPS for jPhone and jcode's gateway in one command, with Tailscale Serve.
#
#   tools/https-setup.sh             set up (or repair) both entries
#   tools/https-setup.sh --dry-run   only print what it would run
#   tools/https-setup.sh --off       remove both entries again (combine with --dry-run)
#
# Result:  https://<mac>.<tailnet>.ts.net/       -> jPhone   (127.0.0.1:8765)
#          https://<mac>.<tailnet>.ts.net:7643   -> gateway  (127.0.0.1:7643)
# Tailscale provides the certificate, and both stay reachable only on your tailnet
# (`serve`, not `funnel`). Needs MagicDNS and HTTPS certificates enabled for the
# tailnet: https://login.tailscale.com/admin/dns
set -eu

APP_PORT="${JPHONE_PORT:-8765}"
GW_PORT="${JCODE_GATEWAY_PORT:-7643}"
DRY=0
OFF=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --off) OFF=1 ;;
    *) echo "usage: $0 [--dry-run] [--off]" >&2; exit 2 ;;
  esac
done

TS="$(command -v tailscale || true)"
[ -n "$TS" ] || [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] || TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -n "$TS" ] || { echo "tailscale CLI not found. Install Tailscale first." >&2; exit 1; }

DNS="$("$TS" status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
[ -n "$DNS" ] || { echo "Could not read this machine's Tailscale name. Is Tailscale up, with MagicDNS on?" >&2; exit 1; }

run() {
  echo "+ $*"
  [ "$DRY" = 1 ] || "$@"
}

if [ "$OFF" = 1 ]; then
  run "$TS" serve --https=443 off
  run "$TS" serve --https="$GW_PORT" off
  echo "Removed. jPhone is back to plain http://<tailscale-ip>:$APP_PORT; set jcode's bind_addr back to your Tailscale IP."
  exit 0
fi

# Refuse to replace something else already served on these ports.
"$TS" serve status --json 2>/dev/null | python3 -c '
import json, sys
dns, want = sys.argv[1], {"443": "http://127.0.0.1:" + sys.argv[2], sys.argv[3]: "http://127.0.0.1:" + sys.argv[3]}
try:
    web = json.load(sys.stdin).get("Web") or {}
except ValueError:
    web = {}
for hostport, cfg in web.items():
    port = hostport.rsplit(":", 1)[-1]
    for path, h in ((cfg or {}).get("Handlers") or {}).items():
        target = (h or {}).get("Proxy", "")
        if port in want and target.rstrip("/") != want[port]:
            sys.exit(f"Port {port} already serves {path} -> {target or h}. Remove it first (tailscale serve --https={port} off) or pick other ports.")
' "$DNS" "$APP_PORT" "$GW_PORT" || exit 1

run "$TS" serve --bg --https=443 "http://127.0.0.1:$APP_PORT"
run "$TS" serve --bg --https="$GW_PORT" "http://127.0.0.1:$GW_PORT"

cat <<EOF

Done. Two more things on this Mac:

  1. Bind jcode's gateway to localhost only, in ~/.jcode/config.toml:

       [gateway]
       enabled = true
       port = $GW_PORT
       bind_addr = "127.0.0.1"

     then restart jcode. Tailscale Serve is now the only way in from other devices.

  2. Keep jPhone's static server running (python3 serve.py, or ./install-macos.sh).
     It already listens on 127.0.0.1:$APP_PORT.

On the phone open  https://$DNS/  and pair with host  $DNS
(or run: tools/pair-qr.py --https). The first visit can take a few seconds while
Tailscale fetches the certificate.

Check from any tailnet device:
  curl -s https://$DNS:$GW_PORT/health
EOF
