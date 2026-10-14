#!/bin/sh
# Run a test suite against GNOME Shell 50 (Ubuntu 26.04) in a container:
# the repository goes in read-only, the results come out in
# tests/output/gnome50/<suite>/run. Nothing of the host session is touched.
#
# Usage: tools/gnome50/run.sh [main|two-monitors|dock|prefs]
#        ATELIER_TEST_ONLY=testDesktop,testNotes tools/gnome50/run.sh (some parts)
set -eu
SUITE="${1:-main}"
cd "$(dirname "$0")/../.."
REPO="$PWD"
IMAGE=atelier-gnome50
OUT="$REPO/tests/output/gnome50/$SUITE"
if ! podman image exists "$IMAGE"; then
    podman build -t "$IMAGE" tools/gnome50
fi
rm -rf "$OUT"
mkdir -p "$OUT"
if [ "$SUITE" = prefs ]; then
    CMD="tools/prefs-screenshots.sh"
else
    CMD="tools/shell-test.sh $SUITE"
fi
podman run --rm --userns=keep-id --user "$(id -u):$(id -g)" \
    --security-opt label=disable --memory 6g \
    -v "$REPO:/atelier:ro" -v "$OUT:/out" -e ATELIER_OUTPUT_ROOT=/out/run -e ATELIER_TEST_ONLY \
    -w /atelier "$IMAGE" sh -c "
        gnome-shell --version
        # GNOME 50 wants a system bus (login, parental controls): a private
        # one, empty, in the container.
        export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/tmp/system-bus
        dbus-daemon --session --address=\$DBUS_SYSTEM_BUS_ADDRESS --fork --nopidfile
        $CMD"
