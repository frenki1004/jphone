#!/bin/sh
# Runs the headless test suite with macOS's built-in JavaScriptCore (no Node needed).
# Falls back to node if jsc is not available.
set -e
cd "$(dirname "$0")/.."
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
status=0
for f in test/*.test.js; do
  echo "# $f"
  if [ -x "$JSC" ]; then
    "$JSC" -m "$f" || status=1
  else
    node --input-type=module -e "globalThis.print=console.log;globalThis.readFile=p=>require('fs').readFileSync(p,'utf8');await import('./$f')" || status=1
  fi
done
exit $status
