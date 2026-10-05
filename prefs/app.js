// The settings app: sections in a searchable sidebar, the chosen section on
// the right — a small control center for everything Atelier does.

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

/**
 * @typedef {object} Section
 * @property {string} id
 * @property {string} title
 * @property {string} icon - icon name
 * @property {string} group - sidebar heading
 * @property {string[]} keywords - extra words search should find
 * @property {Function} create - () => Gtk.Widget (an Adw.PreferencesPage)
 */

const normalize = text => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

export const AtelierView = GObject.registerClass(
class AtelierView extends Adw.Bin {
    /**
     * @param {Section[]} sections
     */
    _init(sections) {
        super._init();
        this._sections = sections;
        this._pages = new Map();
        this._query = '';

        this.toastOverlay = new Adw.ToastOverlay();
        this.set_child(this.toastOverlay);

        this._split = new Adw.NavigationSplitView({
            min_sidebar_width: 220,
            max_sidebar_width: 280,
            sidebar_width_fraction: 0.27,
        });
        this.toastOverlay.set_child(this._split);

        // Sidebar
        this._search = new Gtk.SearchEntry({
            placeholder_text: 'Search settings',
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 6,
        });
        this._list = new Gtk.ListBox({css_classes: ['navigation-sidebar']});
        for (const section of sections)
            this._list.append(this._createRow(section));
        this._list.set_header_func((row, before) => {
            const heading = !before || before.section.group !== row.section.group
                ? new Gtk.Label({label: row.section.group, xalign: 0, css_classes: ['atelier-sidebar-heading']})
                : null;
            row.set_header(heading);
        });
        this._list.set_filter_func(row => this._matches(row.section));
        this._list.connect('row-selected', (_, row) => {
            if (row)
                this._show(row.section);
        });
        this._search.connect('search-changed', () => {
            this._query = normalize(this._search.text.trim());
            this._list.invalidate_filter();
            this._list.invalidate_headers();
            this._selectFirstVisible();
        });

        const sidebarBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        sidebarBox.append(this._search);
        sidebarBox.append(new Gtk.ScrolledWindow({
            child: this._list,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));
        const sidebar = new Adw.ToolbarView({content: sidebarBox});
        sidebar.add_top_bar(new Adw.HeaderBar({
            title_widget: new Adw.WindowTitle({title: 'Atelier'}),
            show_end_title_buttons: false,
        }));
        this._split.sidebar = new Adw.NavigationPage({title: 'Atelier', child: sidebar});

        // Content
        this._content = new Adw.ToolbarView();
        this._content.add_top_bar(new Adw.HeaderBar());
        this._contentPage = new Adw.NavigationPage({title: '', child: this._content});
        this._split.content = this._contentPage;

        this._list.select_row(this._list.get_row_at_index(0));
    }

    /**
     * @param {string} id
     */
    showSection(id) {
        for (let i = 0, row; (row = this._list.get_row_at_index(i)); i++) {
            if (row.section.id === id) {
                this._list.select_row(row);
                return;
            }
        }
    }

    /** Disconnect the pages from the settings (when the window closes). */
    disconnectPages() {
        for (const page of this._pages.values())
            page.disconnectSettings?.();
        this._pages.clear();
    }

    _createRow(section) {
        const row = new Gtk.ListBoxRow();
        row.section = section;
        const box = new Gtk.Box({spacing: 12, margin_top: 8, margin_bottom: 8, margin_start: 6});
        box.append(new Gtk.Image({icon_name: section.icon}));
        box.append(new Gtk.Label({label: section.title, xalign: 0, hexpand: true}));
        row.set_child(box);
        return row;
    }

    _matches(section) {
        if (!this._query)
            return true;
        return [section.title, ...section.keywords].some(word => normalize(word).includes(this._query));
    }

    _selectFirstVisible() {
        const selected = this._list.get_selected_row();
        if (selected && this._matches(selected.section))
            return;
        for (let i = 0, row; (row = this._list.get_row_at_index(i)); i++) {
            if (this._matches(row.section)) {
                this._list.select_row(row);
                return;
            }
        }
    }

    _show(section) {
        let page = this._pages.get(section.id);
        if (!page) {
            page = section.create();
            this._pages.set(section.id, page);
        }
        this._content.set_content(page);
        this._contentPage.title = section.title;
        this._split.show_content = true;
    }
});
