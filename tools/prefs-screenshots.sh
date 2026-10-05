#!/bin/sh
# Render the preference pages to tests/output/prefs and drive the main flows
# (tools/run-prefs.js --selftest). The window is shown in a throwaway headless
# GNOME Shell, so nothing appears on the real desktop; settings stay in memory.
set -eu

cd "$(dirname "$0")/.."
ROOT="$PWD/tests/output/prefs"
SOCKET=atelier-prefs-0

rm -rf "$ROOT"
mkdir -p "$ROOT/config" "$ROOT/data" "$ROOT/cache"
mkdir -m 700 "$ROOT/runtime"

# A private runtime dir keeps the helper services this session starts away
# from the sockets of the real session (keyring, gvfs, document portal...).
env -u XDG_SESSION_ID -u DISPLAY -u WAYLAND_DISPLAY -u GNOME_KEYRING_CONTROL -u SSH_AUTH_SOCK \
    XDG_RUNTIME_DIR="$ROOT/runtime" \
    XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$ROOT/cache" \
    GSETTINGS_BACKEND=memory GDK_DEBUG=no-portals NO_AT_BRIDGE=1 ROOT="$ROOT" SOCKET="$SOCKET" \
    dbus-run-session -- sh -c '
        gnome-shell --headless --virtual-monitor 1920x1200 --no-x11 \
            --wayland-display="$SOCKET" > "$ROOT/shell.log" 2>&1 &
        shell=$!
        for _ in $(seq 100); do
            [ -S "$XDG_RUNTIME_DIR/$SOCKET" ] && break
            sleep 0.1
        done
        status=0
        WAYLAND_DISPLAY="$SOCKET" \
        GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0 LD_LIBRARY_PATH=/usr/lib/gnome-shell \
            timeout 90 gjs -m tools/run-prefs.js --sample --screenshots "$ROOT" --selftest || status=$?
        kill "$shell" 2>/dev/null || true
        wait "$shell" 2>/dev/null || true
        exit $status
    '
ls "$ROOT"/*.png
