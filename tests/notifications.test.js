import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    activeMutes, buttonMode, canonicalAppId, isMuted, muteApp, setButtonMode, unmuteApp,
} from '../lib/notifications.js';
import {assert, assertEqual} from './util.js';

function freshSettings() {
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.atelier.notifications'});
    settings.settings_schema.list_keys().forEach(key => settings.reset(key));
    return settings;
}

export function testCanonicalIdsMatchGnome() {
    assertEqual(canonicalAppId('org.gnome.Nautilus'), 'org-gnome-nautilus');
    assertEqual(canonicalAppId('org.gnome.Nautilus.desktop'), 'org-gnome-nautilus');
    assertEqual(canonicalAppId('chrome-hnpfjngllnobngcgfapefoaidbinmjnm-Default'),
        'chrome-hnpfjngllnobngcgfapefoaidbinmjnm-default', 'WhatsApp as a Chrome app');
    assertEqual(canonicalAppId('jetbrains-rider-89557d24--x'), 'jetbrains-rider-89557d24-x', 'no double dashes');
}

export function testButtonModes() {
    const settings = freshSettings();
    assertEqual(buttonMode(settings, 'chrome-hnpfjngllnobngcgfapefoaidbinmjnm-default'), 'reply-mute',
        'WhatsApp gets Reply and Mute out of the box');
    assertEqual(buttonMode(settings, 'com-anthropic-claude'), 'none', 'Claude none');
    assertEqual(buttonMode(settings, 'org-gnome-nautilus'), 'app', 'others their own');

    setButtonMode(settings, 'org-gnome-nautilus', 'none');
    assertEqual(buttonMode(settings, 'org-gnome-nautilus'), 'none');
    setButtonMode(settings, 'org-gnome-nautilus', 'app');
    assert(!settings.get_string('app-buttons').includes('nautilus'), 'the default is not stored');

    settings.set_string('app-buttons', '{"x": "nonsense"}');
    assertEqual(buttonMode(settings, 'x'), 'app', 'unknown modes fall back');
    settings.set_string('app-buttons', 'not json');
    assertEqual(buttonMode(settings, 'x'), 'app', 'broken JSON falls back');
}

export function testMutes() {
    const settings = freshSettings();
    muteApp(settings, 'whatsapp', 3600);
    muteApp(settings, 'chat', 0);
    assert(isMuted(settings, 'whatsapp') && isMuted(settings, 'chat'), 'muted for an hour and until lifted');
    assert(!isMuted(settings, 'other'));
    const until = activeMutes(settings).get('whatsapp');
    const now = Math.floor(GLib.get_real_time() / 1000000);
    assert(Math.abs(until - (now + 3600)) <= 2, `ends in an hour (${until - now}s)`);

    // A mute that has run out is ignored, and dropped on the next change.
    settings.set_string('muted', JSON.stringify({old: now - 10, chat: 0}));
    assert(!isMuted(settings, 'old'), 'expired mute is over');
    unmuteApp(settings, 'chat');
    assertEqual(JSON.parse(settings.get_string('muted')), {}, 'lifted, and the expired one is gone');
}
