// Base for the island's pages, and the page hosting the switcher.

import GObject from 'gi://GObject';
import St from 'gi://St';

export const IslandPage = GObject.registerClass({
    Signals: {
        'close-request': {},
        'resized': {},
    },
}, class AtelierIslandPage extends St.BoxLayout {
    /** Ask the island to close the page. */
    close() {
        this.emit('close-request');
    }

    /** Tell the island the content changed size. */
    resized() {
        this.emit('resized');
    }
});

export const SwitcherPage = GObject.registerClass({
    Signals: {'close-request': {}},
}, class AtelierSwitcherPage extends St.Bin {
    /**
     * @param {SwitcherContent} content
     */
    _init(content) {
        super._init({style_class: 'atelier-island-switcher', child: content});
        this._content = content;
        content.connectObject('close-request', () => this.emit('close-request'), this);
    }

    /**
     * Fit the switcher to an outer width. Needs the page to be on the stage
     * (see Island.adopt), so its padding is known.
     *
     * @param {number} width
     */
    setWidth(width) {
        this._content.setWidth(width - this.get_theme_node().get_horizontal_padding());
    }

    /**
     * Give the switcher back, e.g. to a popup when the island can't show it.
     *
     * @returns {SwitcherContent}
     */
    release() {
        this._content.disconnectObject(this);
        this.set_child(null);
        return this._content;
    }

    handleKeyPress(event) {
        return this._content.handleKeyPress(event);
    }

    handleScroll(event) {
        return this._content.handleScroll(event);
    }
});
