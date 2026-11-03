# Atelier on extensions.gnome.org

What to paste into the upload form, and the notes for the reviewer. Not
part of the extension's ZIP.

## Description (the extension's page)

Atelier makes the GNOME desktop into one look you can switch: a profile keeps
a wallpaper, the palette taken from it, the shell's and the apps' colours,
desktop widgets and the lock screen's clocks, and a quick picker switches
between profiles.

- Island: a floating bar centre with the clock, notifications, the
  microphone in use, a control centre (quick settings, calendar, notes) and
  a power menu.
- Top bar styles, a dock with pinned and running apps, glass with real
  refraction of what is behind it.
- Desktop widgets: clocks, date, calendar (with Google Tasks from GNOME Online
  Accounts), weather, GitHub contributions, photos, notes pinned to the
  screen's edge.
- Lock screen: its own clocks, a padlock island and a password popup, and an
  optional depth effect (what stands near in the wallpaper in front of the
  clock).
- The palette goes to GTK apps and GNOME Terminal too.

Optional parts that reach outside GNOME Shell are off until the user turns
them on in the settings: Google Tasks (via GNOME Online Accounts), a GitHub
user's public contributions, the depth effect's models, and Other
Extensions (see below).

## Screenshot

`docs/screenshots/desktop.jpg` (1920 × 1080): the widgets, the dock and the
island on one desktop. It is from 2026-10-08, before the newer glass; a fresh
one comes from `make showcase`.

## Upload

1. `make pack` builds `dist/atelier@knespii.github.io.shell-extension.zip`.
2. Sign in at https://extensions.gnome.org, then Upload Extension.
3. Paste the notes below into the field for the reviewer, if the form has
   one, or answer the review with them.

## Notes for the reviewer

### Session modes: `unlock-dialog`

Atelier draws its own lock screen (shell/lockscreen): the island with the
padlock, the clocks as widgets, the password popup. On locking, everything
else stops in `_syncSession()` (extension.js), keybindings included, and
starts again on unlock. Only shell/lockscreen runs while locked; it takes no
keyboard input apart from the password popup, which hands it to GNOME's
`AuthPrompt`. `disable()` carries the comment the guidelines ask for.

### Other extensions

Atelier never enables or disables another extension. It reads their state and,
for three things, works with them:

1. **Dash to Dock / Ubuntu Dock** (shell/dock/module.js): Atelier's own dock
   stays off while either is enabled, so there are never two docks. It only
   reads `Main.extensionManager.lookup(uuid).state` and listens to
   `extension-state-changed`.
2. **Dynamic Music Pill** (shell/dock/musicPill.js): the pill puts itself into
   Dash to Dock's row through `statusArea['dash-to-dock']._box`. With Dash to
   Dock off, Atelier offers its own dock's row at that handle, so the pill
   sits in Atelier's dock. The pill keeps its widget; Atelier gives the
   handle back on `disable()` and asks the pill to move back. Nothing happens
   without the pill installed.
3. **Other Extensions settings section** (shell/otherExtensions.js,
   lib/otherExtensions.js, prefs/otherExtensionsPage.js): some settings of
   other extensions break Atelier's surfaces (Blur my Shell's lock screen
   blur, for example). Atelier tells the user once, in a notification, and
   offers a switch per setting in its preferences. Only after the user turns
   one on does Atelier keep that one key of the other extension's GSettings
   at the value shown. It stores the previous value and puts it back when
   the user turns the switch off. While Atelier is disabled it watches
   nothing and writes nothing. If the user changes the key themselves,
   Atelier stops keeping it.

### The Python worker (lib/depthWorker.py)

The depth effect runs two ONNX models (Depth Anything V2, BiRefNet) on the
wallpaper. GJS has no ONNX runtime, so this one part is Python
(onnxruntime, numpy, Pillow). It is:

- off by default, and only started while the user has the effect on;
- run as a normal user process with `Gio.Subprocess`, one at a time, and
  force-exited in `disable()` (also when the screen locks);
- never installing anything: the preferences show the `apt install` command
  for the user to run themselves;
- given models the user downloads with a button in the preferences, from
  Hugging Face at a pinned revision, checked against their size and SHA-256,
  or the user's own ONNX file chosen in a file dialog. Nothing is
  downloaded otherwise.

The worker is GPL-2.0-or-later like the rest of Atelier.

### Other subprocess: lib/claudeUsageWorker.js

A GJS script (not Python) that the Claude widget runs, only while the widget
is on screen. It reads local Claude Code history files in `~/.claude/projects`
and counts tokens. Nothing is sent anywhere.

### Network

- Google Tasks: GNOME Online Accounts' OAuth token, kept in memory only; only
  when the user adds the calendar widget with tasks.
- GitHub: the public contributions page of a user the user types in; no token.
- Depth models: see above.

No telemetry; nothing about the user is sent anywhere.

### `run_dispose()`

Only on `GnomeDesktop.WallClock`, as GNOME's own unlockDialog.js does: the
clock keeps its timeout and time-zone watch until disposed. Each call has a
comment.

### Fonts

fonts/ has Inter and Roboto Flex, both under the SIL Open Font License (the
licence files are next to them), for the lock screen's clocks.
