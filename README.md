# Atelier

A GNOME Shell 48 extension that turns the desktop into an atelier: **profiles**
(wallpaper, light/dark style, accent, GTK and shell theme, icons, cursor,
font, palette) you switch between with a quick picker, and a **palette taken
from the wallpaper** that colors Atelier and, if you want, GTK apps and
GNOME Terminal, and an **island** in the middle of the top bar. It started as
*BG Changer*; more of the desktop (notifications, a control centre, desktop
widgets, notes, a dock) is on its way.

- **Island**: a black capsule in place of GNOME's clock. It shows the time
  (and a microphone while an app records, a dot for unseen notifications,
  the Do Not Disturb icon). Rest the pointer on it for a glance – a big clock,
  this week, what's left of today's events and the weather, from GNOME's own
  calendar and weather. Clicking it (or <kbd>Super</kbd>+<kbd>V</kbd>) opens
  GNOME's calendar and notifications under it. The glance's power button
  opens a power menu (Lock, Suspend, Log Out, Restart, Power Off); after a
  profile switch the island briefly shows its name.
- **Switcher**: press <kbd>Super</kbd>+<kbd>W</kbd> (or click the button in the
  top bar). The island grows into it (without the island, a dark panel drops
  from the top of the screen), with two tabs:
  - *Profiles* – pick one with the arrow keys, scrolling or the mouse and press
    <kbd>Enter</kbd>: the new wallpaper is revealed by a growing circle, then
    the themes and colors switch.
  - *Wallpapers* – the pictures in `~/Pictures/Wallpapers` (or another folder).
    Picking one changes only the wallpaper; the active profile keeps it.

  <kbd>Tab</kbd> switches between the tabs.
- **Live profiles**: while a profile is active, what you change is saved into
  it – another wallpaper, light/dark, themes, palette options – whether you
  change it in Atelier or in GNOME Settings. Settings a profile leaves at
  "don't change" stay that way.
- **Settings** live in the preferences: open *Extension Manager* (or
  *Extensions*) and click the gear next to Atelier.

When Atelier starts for the first time it saves your current setup as a
profile called **Original**, so there is always a way back.

## Palette

The palette comes from the wallpaper: its colors are grouped into a few
swatches, the most fitting one becomes the source, and a full set of colors
for dark and light is built from it (Settings → Appearance). You can pick
another swatch or one of nine fixed palettes instead, and choose how colorful
it is (vibrant, muted, monochrome). The "Auto" accent of a profile uses it.

Optional, in Settings → Appearance:

- **Color GTK apps** – Atelier writes `~/.config/gtk-4.0/gtk.css` and
  `~/.config/gtk-3.0/gtk.css`: libadwaita apps take the palette's accent and a
  hint of its color, in both light and dark. Open apps need a restart. Atelier
  never overwrites a `gtk.css` it didn't write.
- **Color GNOME Terminal** – a terminal profile "Atelier" (a copy of your
  default profile with the palette's colors) becomes the default; switching
  the option off brings your profile back.

## Install

```sh
make install          # symlinks this folder into ~/.local/share/gnome-shell/extensions/atelier@local
```

On Wayland GNOME Shell only notices new extensions after you log out and back
in. Then enable it:

```sh
gnome-extensions enable atelier@local
```

Shell themes are applied through the **User Themes** extension, which has to
be enabled as well.

### Coming from BG Changer

Atelier takes over BG Changer's data the first time it starts: looks become
profiles, the shortcuts and transition settings carry over, and the wallpaper
copies move to `~/.local/share/atelier`. Disable BG Changer and remove its link
before logging in with Atelier:

```sh
gnome-extensions disable bg-changer@local
rm ~/.local/share/gnome-shell/extensions/bg-changer@local
```

## Themes: why they used to break the desktop

- **Shell themes are tied to the GNOME version.** A theme made for GNOME 42 or
  older doesn't know the quick settings menu, the new notifications and other
  parts of GNOME 48, so the shell ends up half styled and partly broken.
  Atelier flags such themes (Settings → System → Theme Check, and in the
  profile editor). Use themes that list GNOME 47/48 support.
- **Most GNOME apps ignore GTK themes.** Apps built with libadwaita (Files,
  Settings, Text Editor, …) don't read the `gtk-theme` setting at all; only
  GTK 3 apps do. A theme can still restyle them if it ships a `gtk-4.0`
  folder: turn on *Also theme GTK 4 / libadwaita apps* in a profile and
  Atelier imports that stylesheet into `~/.config/gtk-4.0/gtk.css`, following
  the light/dark style.
- **Archives in `~/.themes`** (e.g. `Theme.tar.xz`) make the User Themes
  settings fail to list themes. Extract them and remove the archive.
- If something goes wrong anyway: Settings → System → **Reset Appearance to
  GNOME Defaults**, or switch to the *Original* profile.

## Where things are stored

| What | Where |
| --- | --- |
| Profiles and settings | GSettings `org.gnome.shell.extensions.atelier` |
| Copies of the wallpapers | `~/.local/share/atelier/wallpapers/` |
| Thumbnails, generated shell styles | `~/.cache/atelier/` |
| GTK styles (optional) | `~/.config/gtk-4.0/gtk.css`, `~/.config/gtk-3.0/gtk.css` |
| Terminal colors (optional) | GNOME Terminal profile "Atelier" |

Wallpapers are copied when a profile keeps them, because the original file may
be moved or overwritten (the wallpaper portal always writes to
`~/.config/background`). Deleting a profile deletes its copies, unless the
desktop is still showing them.

## Development

| Command | What it does |
| --- | --- |
| `make check` | Validates the schemas and the syntax of every module |
| `make test` | Unit tests for the shared modules (`tests/`) |
| `make shell-test` | Runs the extension in a throwaway headless GNOME Shell (with BG Changer data to take over) and checks switching, the transition, the palette, GTK styles, terminal colors, live profiles and the Wallpapers tab; screenshots land in `tests/output/shell` |
| `make prefs` | Opens the preferences without the Extensions app (settings in memory) |
| `make prefs-screenshots` | Renders every settings section headlessly and drives the main flows |
| `make pack` | Builds `dist/atelier@local.shell-extension.zip` |

The test sessions use their own settings, data, cache and runtime
directories under `tests/output`, so they never touch the running desktop.

Layout:

- `extension.js` – takes over BG Changer's data and starts the modules
- `shell/` – runs inside GNOME Shell: `core/` (module manager, generated
  styles, GTK and terminal colors, live profiles), the profiles module
  (switcher, transition, applying profiles) and the palette module
- `prefs.js`, `prefs/` – the settings app (GTK 4 / libadwaita)
- `lib/` – shared by both: profiles, palette, migration, theme discovery,
  thumbnails, GTK stylesheets, terminal profile
- `tools/` – development harnesses

## Uninstall

```sh
gnome-extensions disable atelier@local
make uninstall
```

Switch off *Color GTK apps* and *Color GNOME Terminal* first (or use Reset
Appearance) to remove Atelier's GTK styles and terminal profile. The copied
wallpapers stay in `~/.local/share/atelier` until you delete that folder.
