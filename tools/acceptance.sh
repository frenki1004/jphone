#!/bin/sh
# End-to-end acceptance against a REAL jcode gateway (macOS, uses WebKit).
# Pairs a throwaway device, picks a folder, runs a real turn with a tool call,
# drops the socket and checks it recovers, then revokes the device again.
#
#   HOST=<your Tailscale IP> DIR=/abs/project tools/acceptance.sh
set -e
cd "$(dirname "$0")/.."
: "${HOST:?set HOST to the Tailscale IP of the Mac running jcode}"
: "${DIR:?set DIR to an absolute project path for jcode to work in}"
PORT=${PORT:-8813}
[ -x tools/shot ] || swiftc -O tools/shot.swift -o tools/shot

python3 serve.py --bind "$HOST" --port "$PORT" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1

CODE=$(jcode pair 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -i "pairing code" | grep -oE '[0-9]{3} ?[0-9]{3}' | tr -d ' ')
[ ${#CODE} -eq 6 ] || { echo "could not get a pairing code from 'jcode pair'"; exit 1; }

JS="${TMPDIR:-/tmp}/jphone-accept.js"
printf 'window.__CODE=%s;window.__DIR=%s;\n' "'$CODE'" "'$DIR'" > "$JS"
cat tools/acceptance.js >> "$JS"
PROBE='window.__R.join(String.fromCharCode(10))'
OUT=$(tools/shot "http://$HOST:$PORT/" "${TMPDIR:-/tmp}/jphone-accept.png" 393 852 75 "$(cat "$JS")" "$PROBE")
printf '%s\n' "$OUT" | sed 's/^probe: //'

# Clean up the throwaway pairing (the newest device).
DEV=$(jcode pair --list 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -oE '\([0-9a-f-]{36}\)' | tail -1 | tr -d '()')
[ -n "$DEV" ] && jcode pair --revoke "$DEV" >/dev/null 2>&1 && echo "revoked test device $DEV"

if printf '%s\n' "$OUT" | grep -q 'FAIL '; then exit 1; fi
