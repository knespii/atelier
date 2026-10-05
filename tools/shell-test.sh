#!/bin/sh
# Load the extension in a throwaway headless GNOME Shell and run
# tools/shell-test.js inside it. Settings (keyfile backend), data and caches
# live in tests/output/shell, so the running session is never touched.
#
# Usage: make shell-test        (results in tests/output/shell)
set -eu

cd "$(dirname "$0")/.."
REPO="$PWD"
ROOT="$REPO/tests/output/shell"
UUID="bg-changer@local"
BG=/usr/share/backgrounds/gnome

rm -rf "$ROOT"
mkdir -p "$ROOT/config/glib-2.0/settings" "$ROOT/data/gnome-shell/extensions" "$ROOT/cache"
mkdir -m 700 "$ROOT/runtime"
ln -s "$REPO" "$ROOT/data/gnome-shell/extensions/$UUID"

LOOKS="[\
{\"id\":\"amber\",\"name\":\"Amber\",\"wallpaper\":\"$BG/amber-d.jxl\",\"colorScheme\":\"prefer-dark\",\"accentColor\":\"orange\",\"iconTheme\":\"Adwaita\"},\
{\"id\":\"rainbow\",\"name\":\"LCD Rainbow\",\"wallpaper\":\"$BG/lcd-rainbow-d.jxl\",\"colorScheme\":\"prefer-dark\",\"accentColor\":\"auto\",\"gtkTheme\":\"Adwaita-dark\",\"font\":\"Cantarell 11\"},\
{\"id\":\"glass\",\"name\":\"Glass Chip\",\"wallpaper\":\"$BG/glass-chip-l.jxl\",\"colorScheme\":\"prefer-light\",\"accentColor\":\"teal\",\"gtkTheme\":\"Adwaita\",\"shellTheme\":\"\"}]"

cat > "$ROOT/config/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID', 'user-theme@gnome-shell-extensions.gcampax.github.com']

[org/gnome/desktop/background]
picture-uri='file://$BG/adwaita-d.jpg'
picture-uri-dark='file://$BG/adwaita-d.jpg'

[org/gnome/desktop/interface]
color-scheme='prefer-dark'

[org/gnome/shell/extensions/bg-changer]
looks='$LOOKS'
EOF

status=0
# A private runtime dir keeps the helper services this session starts away
# from the sockets of the real session (keyring, gvfs, document portal...).
env -u XDG_SESSION_ID -u DISPLAY -u WAYLAND_SOCKET -u GNOME_KEYRING_CONTROL -u SSH_AUTH_SOCK \
    WAYLAND_DISPLAY=bgc-test-0 XDG_RUNTIME_DIR="$ROOT/runtime" \
    XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$ROOT/cache" \
    GSETTINGS_BACKEND=keyfile BGC_TEST_OUTPUT="$ROOT" \
    dbus-run-session -- timeout --kill-after=5 120 \
    gnome-shell --headless --virtual-monitor 1920x1080 --no-x11 \
        --wayland-display=bgc-test-0 --force-animations \
        --automation-script="$REPO/tools/shell-test.js" \
    > "$ROOT/shell.log" 2>&1 || status=$?

echo "gnome-shell exited with status $status (log: $ROOT/shell.log)"
grep -E "JS ERROR|JS WARNING|BG Changer|bg-changer" "$ROOT/shell.log" | head -40 || true
echo
if [ -f "$ROOT/results.txt" ]; then
    cat "$ROOT/results.txt"
    ! grep -q '^FAIL' "$ROOT/results.txt"
else
    echo "No results written"
    exit 1
fi
