import {
    artUri, becameActive, choosePlayer, isPlayerName, nowPlaying, parseMetadata, playbackStatus,
} from '../lib/mpris.js';
import {assertEqual} from './util.js';

export function testPlayerNames() {
    assertEqual(isPlayerName('org.mpris.MediaPlayer2.spotify'), true);
    assertEqual(isPlayerName('org.mpris.MediaPlayer2.firefox.instance_1_42'), true);
    assertEqual(isPlayerName('org.mpris.MediaPlayer2.'), false, 'the prefix alone');
    assertEqual(isPlayerName('org.mpris.MediaPlayer2'), false);
    assertEqual(isPlayerName(':1.42'), false);
    assertEqual(isPlayerName(null), false);
}

export function testMetadata() {
    const parsed = parseMetadata({
        'mpris:trackid': '/org/mpris/MediaPlayer2/Track/1',
        'xesam:title': ' Clair de Lune ',
        'xesam:artist': ['Claude Debussy', 'Isao Tomita'],
        'mpris:artUrl': 'file:///tmp/cover.png',
        'mpris:length': 300000000,
    });
    assertEqual(parsed, {
        title: 'Clair de Lune',
        artists: ['Claude Debussy', 'Isao Tomita'],
        artist: 'Claude Debussy, Isao Tomita',
        artUrl: 'file:///tmp/cover.png',
        length: 300000000,
        trackId: '/org/mpris/MediaPlayer2/Track/1',
    });
    // Int64 may come as a BigInt.
    assertEqual(parseMetadata({'mpris:length': 5n}).length, 5);
}

export function testFaultyMetadata() {
    assertEqual(parseMetadata(null), {title: '', artists: [], artist: '', artUrl: '', length: 0, trackId: ''});
    assertEqual(parseMetadata({}).title, '');
    const faulty = parseMetadata({
        'xesam:title': 42,
        'xesam:artist': ['Somebody', 7, '', null],
        'mpris:artUrl': ['file:///x.png'],
        'mpris:length': -3,
    });
    assertEqual(faulty.title, '', 'a title not a string');
    assertEqual(faulty.artists, ['Somebody'], 'only strings among the artists');
    assertEqual(faulty.artUrl, '');
    assertEqual(faulty.length, 0);
    assertEqual(parseMetadata({'xesam:artist': 'One Artist'}).artists, ['One Artist'], 'an artist as a string');
}

export function testArtUri() {
    assertEqual(artUri('file:///home/u/cover.jpg'), 'file:///home/u/cover.jpg');
    assertEqual(artUri('https://i.scdn.co/image/ab67'), 'https://i.scdn.co/image/ab67');
    assertEqual(artUri('  http://example.com/a.png '), 'http://example.com/a.png');
    assertEqual(artUri('/home/u/cover.jpg'), '', 'a path is no URI');
    assertEqual(artUri(''), '');
    assertEqual(artUri(undefined), '');
}

export function testStatus() {
    assertEqual(playbackStatus('Playing'), 'Playing');
    assertEqual(playbackStatus('Paused'), 'Paused');
    assertEqual(playbackStatus('playing'), 'Stopped');
    assertEqual(playbackStatus(undefined), 'Stopped');
    assertEqual(becameActive(null, 'Playing'), true, 'appears playing');
    assertEqual(becameActive('Paused', 'Playing'), true);
    assertEqual(becameActive('Playing', 'Playing'), false, 'a new track while playing');
    assertEqual(becameActive('Playing', 'Paused'), false);
    assertEqual(becameActive(null, 'Stopped'), false);
}

export function testChoosePlayer() {
    assertEqual(choosePlayer([]), null);
    assertEqual(choosePlayer(null), null);
    const a = {name: 'a', status: 'Paused', lastActive: 5};
    const b = {name: 'b', status: 'Stopped', lastActive: 2};
    assertEqual(choosePlayer([a, b]), 'a', 'none playing: the last active');
    assertEqual(choosePlayer([a, {...b, status: 'Playing'}]), 'b', 'the one playing first');
    assertEqual(choosePlayer([{...a, status: 'Playing'}, {...b, status: 'Playing'}]), 'a',
        'several playing: the one that started last');
    assertEqual(choosePlayer([{...a, status: 'Playing', lastActive: 1}, {...b, status: 'Playing', lastActive: 9}]), 'b');
    assertEqual(choosePlayer([{name: 'x', status: 'Stopped'}]), 'x', 'one with no stamp');
    assertEqual(choosePlayer([a, {...b, lastActive: 9, canPlay: false}]), 'a', 'one that can\'t play is left out');
    assertEqual(choosePlayer([{...b, canPlay: false}]), null);
    assertEqual(choosePlayer([a, {...b, status: 'Playing', canPlay: false}]), 'b', 'unless it plays');
}

export function testNowPlaying() {
    assertEqual(nowPlaying(null), {
        state: 'idle', title: '', artist: '', artUrl: '', canPlayPause: false, canGoNext: false, canGoPrevious: false,
    }, 'no player: Not Playing');
    const metadata = parseMetadata({'xesam:title': 'Song', 'xesam:artist': ['Band'], 'mpris:artUrl': 'file:///c.png'});
    const player = {
        status: 'Playing', metadata, canPlay: true, canPause: true, canGoNext: true, canGoPrevious: false,
        canControl: true,
    };
    assertEqual(nowPlaying(player), {
        state: 'playing', title: 'Song', artist: 'Band', artUrl: 'file:///c.png',
        canPlayPause: true, canGoNext: true, canGoPrevious: false,
    });
    assertEqual(nowPlaying({...player, status: 'Paused'}).state, 'paused');
    assertEqual(nowPlaying({...player, canPause: false}).canPlayPause, false, 'playing, it pauses');
    assertEqual(nowPlaying({...player, status: 'Paused', canPlay: false}).canPlayPause, false, 'paused, it plays');
    const blocked = nowPlaying({...player, canControl: false});
    assertEqual([blocked.canPlayPause, blocked.canGoNext], [false, false], 'a player that can\'t be controlled');
    assertEqual(nowPlaying({...player, status: 'Stopped', metadata: parseMetadata({})}).state, 'idle',
        'stopped with no track');
    assertEqual(nowPlaying({...player, status: 'Stopped'}).state, 'paused', 'stopped on a track');
}
