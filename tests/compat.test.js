import {chromeParams, majorVersion} from '../lib/compat.js';
import {assertEqual} from './util.js';

export function testMajorVersion() {
    assertEqual(majorVersion('48.7'), 48);
    assertEqual(majorVersion('50.1'), 50);
    assertEqual(majorVersion('49.rc'), 49);
    assertEqual(majorVersion(''), 0);
}

export function testChromeParams() {
    const params = {affectsStruts: true, affectsInputRegion: false};
    assertEqual(chromeParams(params, 48), params, 'up to 49 as they are');
    assertEqual(chromeParams(params, 50), {affectsStruts: true}, 'from 50 without the input region');
    assertEqual(chromeParams({trackFullscreen: true}, 50), {trackFullscreen: true});
}
