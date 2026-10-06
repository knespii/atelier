#!/bin/sh
# Load the extension in a throwaway headless GNOME Shell and run
# tools/shell-test.js inside it. Settings (keyfile backend), data and caches
# live in tests/output/shell, so the running session is never touched.
#
# Usage: make shell-test        (results in tests/output/shell)
#        tools/shell-test.sh two-monitors
#                               (the same session on two monitors, with the
#                               checks for that; results in
#                               tests/output/shell-two-monitors)
set -eu

SUITE="${1:-main}"
cd "$(dirname "$0")/.."
REPO="$PWD"
ROOT="$REPO/tests/output/shell"
MONITORS="--virtual-monitor 1920x1080"
if [ "$SUITE" = two-monitors ]; then
    # The main monitor and a smaller one beside it.
    ROOT="$REPO/tests/output/shell-two-monitors"
    MONITORS="$MONITORS --virtual-monitor 1280x1024"
fi
UUID="atelier@local"
BG=/usr/share/backgrounds/gnome

rm -rf "$ROOT"
mkdir -p "$ROOT/config/glib-2.0/settings" "$ROOT/data/gnome-shell/extensions" "$ROOT/cache"
# The Wayland socket's path has to fit in 108 bytes, too few in a deep
# checkout (a git worktree, say): the runtime dir is in /tmp then.
RUNTIME="$ROOT/runtime"
if [ ${#RUNTIME} -gt 90 ]; then
    RUNTIME=$(mktemp -d)
    trap 'rm -rf "$RUNTIME"' EXIT
else
    mkdir -m 700 "$RUNTIME"
fi
ln -s "$REPO" "$ROOT/data/gnome-shell/extensions/$UUID"

# A deliberately hostile, outdated shell theme: the switcher must stay usable.
mkdir -p "$ROOT/data/themes/Hostile/gnome-shell"
cat > "$ROOT/data/themes/Hostile/gnome-shell/gnome-shell.css" <<'CSS'
stage { color: #ff00ff; font-size: 22pt; font-family: serif; }
StLabel { color: #00ff00; }
StBoxLayout { spacing: 40px; padding: 30px; background-color: rgba(255, 0, 0, 0.5); }
StButton { background-color: yellow; border: 5px solid red; border-radius: 0; }
#panel { background-color: orange; }
CSS

# A GTK theme with a GTK 4 version, for the ~/.config/gtk-4.0 links.
for f in gtk-3.0/gtk.css gtk-4.0/gtk.css gtk-4.0/gtk-dark.css gtk-4.0/assets/check.svg; do
    mkdir -p "$(dirname "$ROOT/data/themes/Modern/$f")"
    echo "/* $f */" > "$ROOT/data/themes/Modern/$f"
done

# BG Changer's library with the wallpaper currently on the desktop.
LEGACY_WALLPAPER="$ROOT/data/bg-changer/wallpapers/1234abcd-amber.jxl"
mkdir -p "$(dirname "$LEGACY_WALLPAPER")"
cp "$BG/amber-d.jxl" "$LEGACY_WALLPAPER"

# Pictures for the Wallpapers tab
mkdir -p "$ROOT/data/Wallpapers"
cp "$BG/blobs-d.svg" "$ROOT/data/Wallpapers/blobs.svg"
cp "$BG/pills-d.jxl" "$ROOT/data/Wallpapers/pills.jxl"

# Claude Code's history, made up: three answers in this block, one two days ago.
CLAUDE="$ROOT/claude"
mkdir -p "$CLAUDE/projects/-home-test-project"
answer() {
    printf '{"type":"assistant","timestamp":"%s","requestId":"req_%s","sessionId":"session","message":{"id":"msg_%s","role":"assistant","usage":{"input_tokens":3,"output_tokens":%s,"cache_creation_input_tokens":1000,"cache_read_input_tokens":20000}}}\n' \
        "$(date -u -d "$1" +%Y-%m-%dT%H:%M:%S.000Z)" "$2" "$2" "$3"
}
{
    answer '-30 min' 1 500
    answer '-20 min' 2 500
    answer '-10 min' 3 500
    answer '-10 min' 3 500 # streamed twice
    answer '-2 days' 4 4000
} > "$CLAUDE/projects/-home-test-project/session.jsonl"

PROFILES="[\
{\"id\":\"amber\",\"name\":\"Amber\",\"wallpaper\":\"$BG/amber-d.jxl\",\"colorScheme\":\"prefer-dark\",\"accentColor\":\"orange\",\"iconTheme\":\"Adwaita\"},\
{\"id\":\"rainbow\",\"name\":\"LCD Rainbow\",\"wallpaper\":\"$BG/lcd-rainbow-d.jxl\",\"colorScheme\":\"prefer-dark\",\"accentColor\":\"auto\",\"gtkTheme\":\"Adwaita-dark\",\"font\":\"Cantarell 11\"},\
{\"id\":\"glass\",\"name\":\"Glass Chip\",\"wallpaper\":\"$BG/glass-chip-l.jxl\",\"colorScheme\":\"prefer-light\",\"accentColor\":\"teal\",\"gtkTheme\":\"Adwaita\",\"shellTheme\":\"\"},\
{\"id\":\"hostile\",\"name\":\"Hostile Theme\",\"wallpaper\":\"$BG/fold-d.jxl\",\"colorScheme\":\"prefer-dark\",\"shellTheme\":\"Hostile\"},\
{\"id\":\"modern\",\"name\":\"Modern\",\"wallpaper\":\"$BG/amber-d.jxl\",\"colorScheme\":\"prefer-dark\",\"gtkTheme\":\"Modern\",\"gtk4\":true}]"

cat > "$ROOT/config/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID', 'user-theme@gnome-shell-extensions.gcampax.github.com']

[org/gnome/desktop/background]
picture-uri='file://$LEGACY_WALLPAPER'
picture-uri-dark='file://$LEGACY_WALLPAPER'

[org/gnome/desktop/interface]
color-scheme='prefer-dark'

[org/gnome/terminal/legacy/profiles:]
list=['b1dcc9dd-5262-4d8d-a863-c897e6d979b9']
default='b1dcc9dd-5262-4d8d-a863-c897e6d979b9'

[org/gnome/shell/extensions/atelier]
wallpaper-folder='$ROOT/data/Wallpapers'

# Seeded as BG Changer data, so Atelier has to take it over on start.
[org/gnome/shell/extensions/bg-changer]
looks='$PROFILES'
active-look='amber'
EOF

status=0
# A private runtime dir keeps the helper services this session starts away
# from the sockets of the real session (keyring, gvfs, document portal...).
# gvfs mounts nothing in it, so that it can be removed.
env -u XDG_SESSION_ID -u DISPLAY -u WAYLAND_SOCKET -u GNOME_KEYRING_CONTROL -u SSH_AUTH_SOCK \
    WAYLAND_DISPLAY=atelier-test-0 XDG_RUNTIME_DIR="$RUNTIME" GVFS_DISABLE_FUSE=1 \
    XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$ROOT/cache" \
    CLAUDE_CONFIG_DIR="$CLAUDE" GSETTINGS_BACKEND=keyfile ATELIER_TEST_OUTPUT="$ROOT" ATELIER_TEST_SUITE="$SUITE" \
    dbus-run-session -- timeout --kill-after=5 180 \
    gnome-shell --headless $MONITORS --no-x11 \
        --wayland-display=atelier-test-0 --force-animations \
        --automation-script="$REPO/tools/shell-test.js" \
    > "$ROOT/shell.log" 2>&1 || status=$?

echo "gnome-shell exited with status $status (log: $ROOT/shell.log)"
grep -E "JS ERROR|JS WARNING|Atelier|bg-changer" "$ROOT/shell.log" | head -40 || true
echo
if [ -f "$ROOT/results.txt" ]; then
    # Shutting down, the shell takes its UI down while JS still runs. What
    # is out of it is left to the garbage collector, which can't run its
    # handlers and says so: GNOME's actors that Atelier holds, say.
    exit_log=$(sed -n '/Shutting down GNOME Shell/,$p' "$ROOT/shell.log")
    if [ -z "$exit_log" ]; then
        echo "FAIL  the shell shuts down at the end" >> "$ROOT/results.txt"
    elif printf '%s\n' "$exit_log" | grep -m 5 -E "sweeping phase of GC|JS callback during garbage collection"; then
        echo "FAIL  nothing is left to the garbage collector as the shell shuts down" >> "$ROOT/results.txt"
    else
        echo "PASS  nothing is left to the garbage collector as the shell shuts down" >> "$ROOT/results.txt"
    fi
    # The main loop turns a while longer then: what waited for a frame or a
    # timeout must not run and touch the actors that are gone.
    if [ -n "$exit_log" ]; then
        if printf '%s\n' "$exit_log" | grep -m 5 -A 4 -E "already disposed|not in the stage"; then
            echo "FAIL  nothing touches the UI once it is gone as the shell shuts down" >> "$ROOT/results.txt"
        else
            echo "PASS  nothing touches the UI once it is gone as the shell shuts down" >> "$ROOT/results.txt"
        fi
    fi
    cat "$ROOT/results.txt"
    ! grep -q '^FAIL' "$ROOT/results.txt"
else
    echo "No results written"
    exit 1
fi
