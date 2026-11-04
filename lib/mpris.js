// What the control centre's Now Playing module makes of the media players
// on the session bus (MPRIS, https://specifications.freedesktop.org/mpris-spec/):
// a player's metadata, which player it shows, and what it shows of it. No
// GNOME imports, so the unit tests run it; shell/controlCentre/media.js
// talks to the bus.

/** Bus names of MPRIS players start with this. */
export const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

/**
 * @param {string} name - a bus name
 * @returns {boolean} whether it is a media player's
 */
export function isPlayerName(name) {
    return typeof name === 'string' && name.startsWith(MPRIS_PREFIX) && name.length > MPRIS_PREFIX.length;
}

const STATUSES = ['Playing', 'Paused', 'Stopped'];

/**
 * @param {*} status - a player's PlaybackStatus
 * @returns {string} 'Playing', 'Paused' or 'Stopped' (for anything else)
 */
export function playbackStatus(status) {
    return STATUSES.includes(status) ? status : 'Stopped';
}

/**
 * The picture's address as GNOME's media message takes it (ui/messageList.js:
 * any URI that Gio.File.new_for_uri() reads, file:// and http(s):// alike).
 *
 * @param {*} url - mpris:artUrl
 * @returns {string} a URI with a scheme, '' for none
 */
export function artUri(url) {
    if (typeof url !== 'string')
        return '';
    const trimmed = url.trim();
    return /^[a-z][a-z0-9+.-]*:\S/i.test(trimmed) ? trimmed : '';
}

const asNumber = value => {
    if (typeof value === 'bigint')
        return Number(value);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

/**
 * A player's Metadata, its values unpacked (each variant's deepUnpack()).
 * Players send faulty metadata at times, as GNOME's ui/mpris.js says: what
 * is not of the spec's type is left out (an artist as a plain string is
 * taken as one).
 *
 * @param {object|null} metadata - {'xesam:title': string, ...}
 * @returns {{title: string, artists: string[], artist: string, artUrl: string,
 *   length: number, trackId: string}} length in microseconds, 0 unknown
 */
export function parseMetadata(metadata) {
    const data = metadata && typeof metadata === 'object' ? metadata : {};
    const title = typeof data['xesam:title'] === 'string' ? data['xesam:title'].trim() : '';
    let artists = data['xesam:artist'];
    if (typeof artists === 'string')
        artists = [artists];
    artists = Array.isArray(artists)
        ? artists.filter(a => typeof a === 'string').map(a => a.trim()).filter(Boolean)
        : [];
    const trackId = typeof data['mpris:trackid'] === 'string' ? data['mpris:trackid'] : '';
    return {
        title,
        artists,
        artist: artists.join(', '),
        artUrl: artUri(data['mpris:artUrl']),
        length: Math.max(0, asNumber(data['mpris:length'])),
        trackId,
    };
}

/**
 * Whether a player's change makes it the last one active: it starts
 * playing (it appears playing, or turns to Playing).
 *
 * @param {string|null} before - its status before (null: it just appeared)
 * @param {string} after - its status now
 * @returns {boolean}
 */
export function becameActive(before, after) {
    return playbackStatus(after) === 'Playing' && before !== 'Playing';
}

/**
 * The player to show: the one playing, else the last one active. Among
 * several playing, the one that started last. One that can't play (and
 * doesn't), a browser with no media, say, is left out, as GNOME's media
 * section leaves it out (ui/mpris.js, 'can-play').
 *
 * @param {Array<{name: string, status: string, lastActive: number, canPlay: boolean}>} players
 *   - lastActive: a stamp that grows each time a player appears or starts
 *   playing; canPlay: its CanPlay, taken as true when not given
 * @returns {string|null} its bus name, null for none
 */
export function choosePlayer(players) {
    let best = null;
    for (const player of players ?? []) {
        if (player.canPlay === false && playbackStatus(player.status) !== 'Playing')
            continue;
        const playing = playbackStatus(player.status) === 'Playing';
        const rank = [playing ? 1 : 0, player.lastActive ?? 0];
        if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1]))
            best = {name: player.name, rank};
    }
    return best?.name ?? null;
}

/**
 * What the module shows of a player.
 *
 * @param {object|null} player - {status, metadata (parseMetadata()'s),
 *   canPlay, canPause, canGoNext, canGoPrevious, canControl}; null for none
 * @returns {{state: string, title: string, artist: string, artUrl: string,
 *   canPlayPause: boolean, canGoNext: boolean, canGoPrevious: boolean}}
 *   state 'idle' (Not Playing), 'playing' or 'paused'
 */
export function nowPlaying(player) {
    const status = playbackStatus(player?.status);
    const metadata = player?.metadata ?? parseMetadata(null);
    // Stopped with nothing to say: as no player at all.
    if (!player || (status === 'Stopped' && !metadata.title)) {
        return {
            state: 'idle', title: '', artist: '', artUrl: '',
            canPlayPause: Boolean(player?.canControl !== false && player?.canPlay),
            canGoNext: false, canGoPrevious: false,
        };
    }
    const control = player.canControl !== false;
    const playing = status === 'Playing';
    return {
        state: playing ? 'playing' : 'paused',
        title: metadata.title,
        artist: metadata.artist,
        artUrl: metadata.artUrl,
        canPlayPause: control && Boolean(playing ? player.canPause : player.canPlay),
        canGoNext: control && Boolean(player.canGoNext),
        canGoPrevious: control && Boolean(player.canGoPrevious),
    };
}
