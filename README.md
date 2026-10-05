# BG Changer

A GNOME Shell 48 extension for saving **looks** and switching between them.
A look is a wallpaper plus, optionally, a light/dark style, an accent color,
a GTK theme, a shell theme, icons, a cursor and an interface font.

- **Switcher**: press <kbd>Super</kbd>+<kbd>W</kbd> (or click the button in the
  top bar). A dark panel drops from the top of the screen with your looks;
  pick one with the arrow keys, scrolling or the mouse, and press
  <kbd>Enter</kbd> or click it. The new wallpaper is revealed by a growing
  circle, then the themes switch. The panel's highlight follows the system
  accent color, so with the accent set to *Auto* it matches the wallpaper.
- **Managing looks** happens in the preferences: open *Extension Manager* (or
  *Extensions*) and click the gear next to BG Changer. There you can add
  wallpapers, save your current setup as a look and edit each look.

When the extension is enabled for the first time it saves your current setup
as a look called **Original**, so there is always a way back.

## Install

```sh
make install          # symlinks this folder into ~/.local/share/gnome-shell/extensions
```

On Wayland GNOME Shell only notices new extensions after you log out and back
in. Then enable it:

```sh
gnome-extensions enable bg-changer@local
```

Shell themes are applied through the **User Themes** extension, which has to
be enabled as well.

## Themes: why they used to break the desktop

- **Shell themes are tied to the GNOME version.** A theme made for GNOME 42 or
  older doesn't know the quick settings menu, the new notifications and other
  parts of GNOME 48, so the shell ends up half styled and partly broken. The
  extension flags such themes (Settings → Theme Check, and in the editor).
  Use themes that list GNOME 47/48 support.
- **Most GNOME apps ignore GTK themes.** Apps built with libadwaita (Files,
  Settings, Text Editor, …) don't read the `gtk-theme` setting at all; only
  GTK 3 apps do. A theme can still restyle them through
  `~/.config/gtk-4.0/gtk.css` if it ships a `gtk-4.0` folder. Turn on
  *Also theme GTK 4 / libadwaita apps* in a look to have the extension link
  that stylesheet (the dark one for dark looks); open apps need a restart.
  The extension never replaces a `gtk.css` it didn't create.
- **Archives in `~/.themes`** (e.g. `Theme.tar.xz`) make the User Themes
  settings fail to list themes. Extract them and remove the archive.
- If something goes wrong anyway: Settings → **Reset Appearance to GNOME
  Defaults**, or switch to the *Original* look.

Light/dark style and the accent color work for every app, themed or not.

## Where things are stored

| What | Where |
| --- | --- |
| Looks and settings | GSettings `org.gnome.shell.extensions.bg-changer` |
| Copies of the wallpapers | `~/.local/share/bg-changer/wallpapers/` |
| Thumbnails | `~/.cache/bg-changer/thumbnails/` |
| GTK 4 theme links (optional) | `~/.config/gtk-4.0/gtk.css`, `assets` |

Wallpapers are copied when a look is saved, because the original file may be
moved or overwritten (the wallpaper portal always writes to
`~/.config/background`). Deleting a look deletes its copy.

## Development

| Command | What it does |
| --- | --- |
| `make check` | Validates the schema and the syntax of every module |
| `make test` | Unit tests for the shared modules (`tests/`) |
| `make shell-test` | Runs the extension in a throwaway headless GNOME Shell and checks the switcher, the transition and the written settings; screenshots land in `tests/output/shell` |
| `make prefs` | Opens the preferences without the Extensions app (settings in memory) |
| `make prefs-screenshots` | Renders the preference pages headlessly and drives their main flows |
| `make pack` | Builds `dist/bg-changer@local.shell-extension.zip` |

The test sessions use their own settings, data, cache and runtime
directories under `tests/output`, so they never touch the running desktop.

Layout:

- `extension.js`, `shell/` – runs inside GNOME Shell (switcher, indicator,
  transition, applying looks)
- `prefs.js`, `prefs/` – the preferences window (GTK 4 / libadwaita)
- `lib/` – shared by both: the look store, theme discovery, thumbnails,
  GTK 4 links
- `tools/` – development harnesses

## Uninstall

```sh
gnome-extensions disable bg-changer@local
make uninstall
```

The copied wallpapers stay in `~/.local/share/bg-changer` until you delete
that folder.
