#!/bin/sh
# Render the preference pages to tests/output/prefs and drive the main flows
# (tools/run-prefs.js --selftest). The window is shown in a throwaway headless
# GNOME Shell, so nothing appears on the real desktop; settings stay in memory.
set -eu

cd "$(dirname "$0")/.."
ROOT="$PWD/tests/output/prefs"
SOCKET=atelier-prefs-0

rm -rf "$ROOT"
mkdir -p "$ROOT/config" "$ROOT/data" "$ROOT/bin"
# Sockets' paths have to fit in 108 bytes, too few under a deep checkout (a
# git worktree, say): the runtime dir and the cache are in /tmp.
RUNTIME=$(mktemp -d)
CACHE=$(mktemp -d)

# The helper services the session starts could outlive it; they go with it,
# also when this is stopped, and so do its runtime dir and cache. (No input
# method: one left behind once ate all the memory.)
cleanup() {
    for dir in /proc/[0-9]*; do
        if grep -qzxF "ATELIER_PREFS_OUTPUT=$ROOT" "$dir/environ" 2>/dev/null; then
            kill "${dir#/proc/}" 2>/dev/null || true
        fi
    done
    rm -rf "$RUNTIME" "$CACHE"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
printf '#!/bin/sh\nexit 0\n' > "$ROOT/bin/ibus-daemon"
chmod +x "$ROOT/bin/ibus-daemon"

# A private runtime dir keeps the helper services this session starts away
# from the sockets of the real session (keyring, gvfs, document portal...).
env -u XDG_SESSION_ID -u DISPLAY -u WAYLAND_DISPLAY -u GNOME_KEYRING_CONTROL -u SSH_AUTH_SOCK \
    XDG_RUNTIME_DIR="$RUNTIME" GVFS_DISABLE_FUSE=1 PATH="$ROOT/bin:$PATH" ATELIER_PREFS_OUTPUT="$ROOT" \
    XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$CACHE" \
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
