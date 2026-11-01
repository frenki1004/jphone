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

# Optional: the Web Push relay (tools/push-relay.py) as its own login item.
#   ./install-macos.sh push            install / update (own venv with `cryptography`)
#   ./install-macos.sh push uninstall  remove (keeps ~/.config/jphone/push.json)
if [ "${1:-}" = "push" ]; then
  PLABEL="dev.jphone.push"
  PPLIST="$HOME/Library/LaunchAgents/$PLABEL.plist"
  VENV="$HOME/.config/jphone/venv"
  PLOG="$HOME/Library/Logs/jphone-push.log"
  if [ "${2:-}" = "uninstall" ]; then
    launchctl bootout "gui/$(id -u)/$PLABEL" 2>/dev/null || true
    rm -f "$PPLIST"
    echo "Push relay login item removed. To also revoke its jcode pairing: jcode pair --list, then jcode pair --revoke."
    exit 0
  fi
  [ -n "$PY" ] || { echo "python3 not found"; exit 1; }
  mkdir -p "$HOME/.config/jphone" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  chmod 700 "$HOME/.config/jphone"
  if [ ! -x "$VENV/bin/python" ]; then
    echo "Creating $VENV (for the one dependency, cryptography)..."
    "$PY" -m venv "$VENV"
  fi
  "$VENV/bin/python" -m pip install --quiet --upgrade cryptography
  if ! "$VENV/bin/python" -c 'import json,os,sys; sys.exit(0 if json.load(open(os.path.expanduser("~/.config/jphone/push.json"))).get("relay_token") else 1)' 2>/dev/null; then
    echo "Pairing the relay with jcode..."
    "$VENV/bin/python" "$DIR/tools/push-relay.py" --pair
  fi
  cat > "$PPLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$VENV/bin/python</string>
    <string>$DIR/tools/push-relay.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$PLOG</string>
  <key>StandardErrorPath</key><string>$PLOG</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$PLABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PPLIST"
  sleep 1
  echo "Push relay installed as a login item. Log: $PLOG"
  echo "Now in jPhone (HTTPS; on iPhone from the Home Screen): Settings -> Notify even when jPhone is closed."
  tail -n 3 "$PLOG" 2>/dev/null || true
  exit 0
fi

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
