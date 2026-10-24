import {LOOK, VARIANTS, lookOf, resolveVariant} from '../lib/glassLook.js';
import {assert, assertEqual} from './util.js';

export function testVariants() {
    assertEqual(VARIANTS, ['regular', 'clear', 'off']);
    for (const variant of VARIANTS)
        assertEqual(resolveVariant(variant), variant, `${variant} as chosen`);
    assertEqual(resolveVariant('regular', {highContrast: true}), 'off', 'high contrast: solid');
    assertEqual(resolveVariant('clear', {highContrast: true}), 'off', 'whatever is chosen');
    assertEqual(resolveVariant('nonsense'), 'regular', 'anything else: regular');
}

export function testLooks() {
    assertEqual(lookOf('off'), null, 'off: no material');
    for (const variant of ['regular', 'clear']) {
        const look = lookOf(variant);
        assert(look === LOOK[variant], `${variant} has its material`);
        assert(look.rim.top > look.rim.side && look.rim.side > look.rim.bottom,
            `${variant}: the light strongest at the top, faintest at the bottom`);
        assert(look.saturation >= 1 && look.brightness >= 1, `${variant}: richer and lighter`);
    }
    assert(LOOK.clear.veil < LOOK.regular.veil && LOOK.clear.dim > LOOK.regular.dim,
        'clear: less veil, a dimming under it');
}
