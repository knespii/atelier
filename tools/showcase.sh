#!/bin/sh
# Show Atelier at its best in a throwaway headless GNOME Shell and take the
# pictures for the README (docs/screenshots) with tools/showcase.js: a few
# profiles of GNOME's own wallpapers, widgets, notes, the dock. Settings
# (keyfile backend) and data live in tests/output/showcase, the runtime dir
# and the cache in /tmp, so the running session is never touched.
#
# The monitor is a 4K one at scale 2: the desktop as on a 1920×1080 one, in
# twice the detail.
#
# Usage: make showcase
#        ATELIER_SHOWCASE_FRAMES=<folder> tools/showcase.sh
#                      (also a few moments in slow motion, frame by frame,
#                      into that folder: what a video is made of; with
#                      ATELIER_SHOWCASE_TAKES=<name>,... only those again)
set -eu

cd "$(dirname "$0")/.."
REPO="$PWD"
ROOT="$REPO/tests/output/showcase"
UUID="atelier@local"
BG=/usr/share/backgrounds/gnome
FRAMES="${ATELIER_SHOWCASE_FRAMES:-}"
if [ -n "$FRAMES" ]; then
    mkdir -p "$FRAMES"
    FRAMES=$(cd "$FRAMES" && pwd)
fi

rm -rf "$ROOT"
mkdir -p "$ROOT/config/glib-2.0/settings" "$ROOT/data/gnome-shell/extensions" "$ROOT/data/atelier" "$ROOT/bin" \
    "$REPO/docs/screenshots"
# Sockets' paths have to fit in 108 bytes, too few under a deep checkout (a
# git worktree, say): the runtime dir, with the Wayland socket, and the
# cache are in /tmp.
RUNTIME=$(mktemp -d)
CACHE=$(mktemp -d)
ln -s "$REPO" "$ROOT/data/gnome-shell/extensions/$UUID"

# The helper services the session starts go with it, also when this is
# stopped, and so do its runtime dir and cache. (No input method: one left
# behind once ate all the memory.)
cleanup() {
    for dir in /proc/[0-9]*; do
        if grep -qzxF "ATELIER_SHOWCASE_OUTPUT=$ROOT" "$dir/environ" 2>/dev/null; then
            kill "${dir#/proc/}" 2>/dev/null || true
        fi
    done
    rm -rf "$RUNTIME" "$CACHE"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
printf '#!/bin/sh\nexit 0\n' > "$ROOT/bin/ibus-daemon"
chmod +x "$ROOT/bin/ibus-daemon"

# Pictures for the Wallpapers tab
mkdir -p "$ROOT/data/Wallpapers"
for name in ring-d tarka-d swoosh-l; do
    cp "$BG/$name.jxl" "$ROOT/data/Wallpapers/"
done

# Claude Code's history, made up: a working afternoon in this block, a few
# days before it.
CLAUDE="$ROOT/claude"
mkdir -p "$CLAUDE/projects/-home-atelier"
answer() {
    printf '{"type":"assistant","timestamp":"%s","requestId":"req_%s","sessionId":"session","message":{"id":"msg_%s","role":"assistant","usage":{"input_tokens":3,"output_tokens":%s,"cache_creation_input_tokens":4000,"cache_read_input_tokens":90000}}}\n' \
        "$(date -u -d "$1" +%Y-%m-%dT%H:%M:%S.000Z)" "$2" "$2" "$3"
}
{
    i=0
    for minutes in 150 140 125 110 95 80 70 55 40 30 20 12 5; do
        i=$((i + 1))
        answer "-$minutes min" "b$i" $((2400 + i * 330))
    done
    for days in 1 2 3 4 6; do
        for n in 1 2 3; do
            answer "-$days days -$n hours" "d$days$n" $((9000 + days * 1700 + n * 900))
        done
    done
} > "$CLAUDE/projects/-home-atelier/session.jsonl"

# Notes on the edges of the screen.
NOW=$(date +%s)000
cat > "$ROOT/data/atelier/notes.json" <<EOF
[{"id":"note-groceries","title":"Saturday","text":"- [x] Coffee beans\n- [ ] Oat milk\n- [ ] Lemons\n- [ ] Flowers","color":"yellow","created":$NOW,"modified":$NOW,"archived":false,"pin":"left"},
 {"id":"note-ideas","title":"Ideas","text":"Moodboard for the new posters\nPrint the photos from the trip","color":"mint","created":$NOW,"modified":$NOW,"archived":false,"pin":"left"}]
EOF

profile() {
    # id, name, wallpaper, color scheme, accent
    printf '{"id":"%s","name":"%s","wallpaper":"%s","colorScheme":"%s","accentColor":"%s","iconTheme":"Adwaita","cursorTheme":"Adwaita"}' \
        "$1" "$2" "$BG/$3" "$4" "$5"
}
PROFILES="[$(profile midnight Midnight sheet-d.jxl prefer-dark auto),\
$(profile lagoon Lagoon glass-chip-l.jxl prefer-light auto),\
$(profile ember Ember amber-d.jxl prefer-dark auto),\
$(profile dune Dune fold-l.jxl prefer-light auto),\
$(profile berry Berry swoosh-d.jxl prefer-dark auto),\
$(profile candy Candy pills-d.jxl prefer-dark auto)]"
WIDGETS='[{"id":"clock","kind":"clock","size":"square","x":0,"y":0},{"id":"date","kind":"date","size":"square","x":2,"y":0},{"id":"calendar","kind":"calendar","size":"large","x":0,"y":2},{"id":"weather","kind":"weather","size":"card","x":0,"y":6},{"id":"github","kind":"github","size":"card","x":0,"y":8}]'

cat > "$ROOT/config/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID']
favorite-apps=['org.gnome.Nautilus.desktop', 'org.gnome.Calendar.desktop', 'org.gnome.TextEditor.desktop', 'org.gnome.Terminal.desktop', 'org.gnome.Weather.desktop', 'org.gnome.Loupe.desktop', 'org.gnome.Settings.desktop']

[org/gnome/desktop/background]
picture-uri='file://$BG/sheet-d.jxl'
picture-uri-dark='file://$BG/sheet-d.jxl'

[org/gnome/desktop/interface]
color-scheme='prefer-dark'
clock-format='24h'
# (A steady cursor in slow motion.)
cursor-blink=false

[org/gnome/desktop/notifications]
show-banners=true

[org/gnome/shell/extensions/atelier]
profiles='$PROFILES'
active-profile='midnight'
first-run-done=true
migrated-from-bg-changer=true
wallpaper-folder='$ROOT/data/Wallpapers'

[org/gnome/shell/extensions/atelier/bar]
style='spread'
surface='glass'
island-shape='notch'

[org/gnome/shell/extensions/atelier/desktop]
widgets='$WIDGETS'
EOF

status=0
env -u XDG_SESSION_ID -u DISPLAY -u WAYLAND_SOCKET -u GNOME_KEYRING_CONTROL -u SSH_AUTH_SOCK \
    WAYLAND_DISPLAY=atelier-showcase-0 XDG_RUNTIME_DIR="$RUNTIME" GVFS_DISABLE_FUSE=1 PATH="$ROOT/bin:$PATH" \
    XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$CACHE" \
    CLAUDE_CONFIG_DIR="$CLAUDE" GSETTINGS_BACKEND=keyfile ATELIER_SHOWCASE_OUTPUT="$ROOT" \
    ATELIER_SHOWCASE_DOCS="$REPO/docs/screenshots" ATELIER_SHOWCASE_FRAMES="$FRAMES" \
    dbus-run-session -- timeout --kill-after=5 1800 \
    gnome-shell --headless --virtual-monitor 3840x2160 --no-x11 \
        --wayland-display=atelier-showcase-0 --force-animations \
        --automation-script="$REPO/tools/showcase.js" \
    > "$ROOT/shell.log" 2>&1 || status=$?

echo "gnome-shell exited with status $status (log: $ROOT/shell.log)"
grep -E "JS ERROR|JS WARNING|Atelier" "$ROOT/shell.log" | head -40 || true
if [ -f "$ROOT/results.txt" ]; then
    cat "$ROOT/results.txt"
    ! grep -q '^FAIL' "$ROOT/results.txt"
else
    echo "No results written"
    exit 1
fi
