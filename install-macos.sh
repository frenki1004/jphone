#!/bin/sh
# Install jPhone as a macOS login item (LaunchAgent): starts at login, restarts if it crashes.
#   ./install-macos.sh            install / update
#   ./install-macos.sh uninstall  remove
set -e
LABEL="dev.jphone.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3)"
LOG="$HOME/Library/Logs/jphone.log"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "jPhone login item removed."
  exit 0
fi

[ -n "$PY" ] || { echo "python3 not found"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$DIR/serve.py</string>
    <string>--require-tailscale</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>JPHONE_QUIET</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <!-- Tailscale may come up after login: keep retrying until the bind works. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
echo "jPhone installed as a login item. Log: $LOG"
tail -n 4 "$LOG" 2>/dev/null || true
