#!/bin/sh
# Regenerate README screenshots from the offline demo (no jcode needed).
# Usage: tools/screenshots.sh   (serves web/ on localhost:8799 while it runs)
set -e
cd "$(dirname "$0")/.."
[ -x tools/shot ] || swiftc -O tools/shot.swift -o tools/shot
mkdir -p docs/img
python3 serve.py --bind 127.0.0.1 --port 8799 >/dev/null 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
sleep 1
URL=http://127.0.0.1:8799
# Freeze animations and simulate an iPhone's notch + home bar insets.
PREP="var s=document.createElement('style');s.textContent='*,*::before,*::after{transition:none!important;animation-duration:0s!important}:root{--safe-t:47px;--safe-b:34px}';document.head.appendChild(s);0"
W=393; H=852
tools/shot "$URL/?demo"        docs/img/chat.png    $W $H 1.5 "$PREP"
tools/shot "$URL/?demo=live"   docs/img/live.png    $W $H 1.5 "$PREP"
tools/shot "$URL/?demo=drawer" docs/img/drawer.png  $W $H 1.5 "$PREP"
tools/shot "$URL/?demo=empty"  docs/img/empty.png   $W $H 1.5 "$PREP"
tools/shot "$URL/"             docs/img/pair.png    $W $H 1.5 "$PREP;var h=document.getElementById('pair-host');h.value='macbook.tail1234.ts.net';document.getElementById('pair-health').dataset.state='ok';0"
tools/shot "$URL/?demo"        docs/img/tablet.png  1024 768 1.5 "$PREP"
echo "done: docs/img/"
