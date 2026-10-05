UUID := bg-changer@local
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
JS_FILES = $(shell git ls-files --cached --others --exclude-standard '*.js')

.PHONY: all schemas install uninstall pack check test prefs shell-test clean

all: schemas

schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas --strict schemas/

# Development install: symlink the working tree into the user's extension dir.
install: schemas
	@mkdir -p "$(dir $(INSTALL_DIR))"
	@if [ -e "$(INSTALL_DIR)" ] && [ ! -L "$(INSTALL_DIR)" ]; then \
		echo "$(INSTALL_DIR) exists and is not a symlink, refusing to touch it"; exit 1; fi
	ln -sfn "$(CURDIR)" "$(INSTALL_DIR)"
	@echo "Installed. On Wayland, log out and back in, then run: gnome-extensions enable $(UUID)"

uninstall:
	@if [ -L "$(INSTALL_DIR)" ]; then rm "$(INSTALL_DIR)" && echo "Removed $(INSTALL_DIR)"; \
	else echo "No symlinked install found"; fi

pack: schemas
	@mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--extra-source=lib --extra-source=shell --extra-source=prefs .

# Syntax check every module (GJS modules are ES modules) and validate the schema.
check:
	glib-compile-schemas --strict --dry-run schemas/
	@for f in $(JS_FILES); do \
		node --experimental-default-type=module --check "$$f" || exit 1; done
	@echo "Syntax OK"

# Unit tests for the modules shared by the shell and the preferences.
test: schemas
	GSETTINGS_SCHEMA_DIR=schemas GSETTINGS_BACKEND=memory \
	XDG_DATA_HOME="$(CURDIR)/tests/output/data" XDG_CACHE_HOME="$(CURDIR)/tests/output/cache" \
	gjs -m tests/run.js

# Open the preferences window outside of GNOME Shell (settings are kept in memory).
prefs: schemas
	GSETTINGS_BACKEND=memory gjs -m tools/run-prefs.js

# Load the extension in a throwaway headless GNOME Shell with isolated settings.
shell-test: schemas
	tools/shell-test.sh

clean:
	rm -rf dist schemas/gschemas.compiled tests/output
