import {
    LOOK, NO_SHADE, REST_LIGHT, TINTS, VARIANTS, bodyRect, boundsOf, lightToward, lookOf, materialValues, resolveVariant,
    sameLight, sameShade, shadedLook, textureFrame, tintOf,
} from '../lib/glassLook.js';
import {assert, assertEqual} from './util.js';

const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

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
    assert(LOOK.clear.frost < LOOK.regular.frost && LOOK.regular.frost === 1,
        'clear: less frosted than the surfaces are');
}

export function testMaterialValues() {
    const look = LOOK.regular;
    const values = materialValues(look, 2);
    assertEqual(values.tone, [look.saturation, look.brightness, look.veil, look.dim], 'the tone as it is');
    assertEqual(values.lens, [look.lens.width * 2, look.lens.shift * 2, look.aberration, 1],
        'lengths in the surface\'s pixels, the material on');
    assertEqual(values.rim, [look.rim.top, look.rim.bottom, look.rim.side, look.rim.width * 2], 'the rim');
    assert(near(values.sheen[2], look.sheen.angle * Math.PI / 180) && values.sheen[3] === look.grain,
        'the sheen\'s angle in radians, the grain');
    assert(near(values.sheen[0], look.sheen.alpha * look.sheen.surface) && values.sheen[0] < look.sheen.alpha,
        'a surface shows a share of the sheen (type is read on it)');
    const none = materialValues(null);
    assertEqual(none.lens[3], 0, 'none: only the shape');
    assertEqual(none.tone, [1, 1, 0, 0], 'and what is behind as it is');
}

export function testShadedLook() {
    const regular = LOOK.regular;
    assert(shadedLook(regular) === regular && shadedLook(regular, NO_SHADE) === regular, 'no shade: as it is');
    assertEqual(shadedLook(null, {dim: 0.3, veil: 0}), null, 'no glass: none');
    const darker = shadedLook(regular, {dim: 0.3, veil: 0});
    assert(near(darker.dim, 0.3) && darker.veil === regular.veil && darker.saturation === regular.saturation,
        `a dark veil under light type: its dim, the rest as it is (${darker.dim})`);
    // Clear glass, dimmed already: each lets through what the other left.
    const clear = shadedLook(LOOK.clear, {dim: 0.3, veil: 0});
    assert(near(1 - clear.dim, (1 - LOOK.clear.dim) * 0.7), `clear: on top of its own dim (${clear.dim})`);
    const lighter = shadedLook(regular, {dim: 0, veil: 0.4});
    assert(near(1 - lighter.veil, (1 - regular.veil) * 0.6) && lighter.dim === regular.dim,
        `a white veil under dark type, with its own (${lighter.veil})`);
    assert(regular.dim === 0 && LOOK.regular === regular, 'the look itself untouched');
    assert(sameShade({dim: 0.2, veil: 0}, {dim: 0.20001, veil: 0}) && !sameShade({dim: 0.2, veil: 0}, NO_SHADE),
        'shades the same as far as anyone could see');
}

export function testLightTowardThePointer() {
    const area = [100, 100, 200, 40];
    const light = LOOK.regular.light;
    assertEqual(lightToward(area, [1000, 1000], light), REST_LIGHT, 'far: from above');
    assertEqual(lightToward(area, [200, 100 - light.near - 1], light), REST_LIGHT, 'just past near: from above');
    // Beside it on the left, a little away: leaning left, still mostly from above.
    const left = lightToward(area, [60, 120], light);
    assert(left[0] < 0 && left[1] < 0 && Math.abs(left[0]) < Math.abs(left[1]),
        `beside it on the left: leaning left (${left})`);
    assert(near(Math.hypot(...left), 1), 'a direction');
    // Right at it: as far as it leans; nearer leans more.
    const touching = lightToward(area, [100, 120], light);
    const farther = lightToward(area, [20, 120], light);
    assert(touching[0] < farther[0] && farther[0] < 0, `nearer leans more (${touching} vs ${farther})`);
    const most = Math.atan2(light.lean, 1 - light.lean);
    assert(Math.abs(Math.atan2(-touching[0], -touching[1]) - most) < 1e-6,
        `at most lean of the way (${touching})`);
    // Over its middle: from above; over its right end: leaning right.
    assert(sameLight(lightToward(area, [200, 120], light), REST_LIGHT), 'over its middle: from above');
    assert(lightToward(area, [295, 120], light)[0] > 0, 'over its right end: leaning right');
    // Eased: hardly any lean as the pointer comes within reach.
    const edge = lightToward(area, [100 - light.near + 2, 120], light);
    assert(edge[0] < 0 && Math.abs(edge[0]) < 5e-3, `hardly any lean at the edge of reach (${edge})`);
    // In pixels: twice as far at scale 2.
    assert(lightToward([200, 200, 400, 80], [200 - light.near * 1.5, 240], light, 2)[0] < 0,
        'at scale 2, near is twice as far in pixels');
    assert(sameLight(lightToward([200, 200, 400, 80], [200 - light.near * 1.5, 240], light, 1), REST_LIGHT),
        'and at scale 1, not');
}

export function testBodyPastTheEdges() {
    const monitor = {x: 0, y: 0, width: 1920, height: 1080};
    assertEqual(bodyRect([800, 0, 320, 32], monitor), [800, -512, 320, 32 + 512],
        'a notch goes on above the screen, its bottom stays');
    assertEqual(bodyRect([0, 0, 1920, 32], monitor), [-512, -512, 1920 + 1024, 32 + 512],
        'a bar across the top: only its bottom edge stays');
    assertEqual(bodyRect([700, 1000, 520, 72], monitor), [700, 1000, 520, 72], 'a floating dock: all of it');
    assertEqual(bodyRect([0, 1010, 1920, 70], monitor), [-512, 1010, 1920 + 1024, 70 + 512],
        'a dock along the bottom: only its top edge stays');
    assertEqual(bodyRect([1920, 0, 300, 30], {x: 1920, y: 0, width: 1280, height: 1024}),
        [1920 - 512, -512, 300 + 512, 30 + 512], 'on another monitor, its own edges');
}

export function testTints() {
    assertEqual(tintOf(LOOK.regular, {light: false}), 'smoky', 'dark style: smoky');
    assertEqual(tintOf(LOOK.regular, {light: true}), 'light', 'light style: light');
    assertEqual(tintOf(LOOK.clear, {light: false}), 'smoky-clear', 'clear: less of it');
    assertEqual(tintOf(LOOK.clear, {light: true}), 'light-clear', 'clear in the light style');
    assertEqual(tintOf(LOOK.clear, {light: true, deep: true}), 'deep', 'deep whatever the style and variant');
    assert(TINTS.every(tint => typeof tint === 'string') && TINTS.length === 5, 'five tints');
}

export function testBounds() {
    assertEqual(boundsOf([]), null, 'none');
    assertEqual(boundsOf([[10, 20, 30, 40], [0, 50, 10, 0]]), [10, 20, 30, 40], 'empty ones left out');
    assertEqual(boundsOf([[10, 20, 30, 40], [0, 50, 10, 30]]), [0, 20, 40, 60], 'around them all');
}

export function testTextureFrame() {
    // (As measured in the headless shell: a 1920 × 108 surface's texture
    // has 1923 × 111 texels at scale 1 and 3846 × 222 at 2, a 2560 × 144
    // one 5126 × 294 at 150 % – twice its frame's size each way.)
    assertEqual(textureFrame(1920), [-2, 1923], 'two pixels before the actor, one after it');
    assertEqual(textureFrame(108), [-2, 111], 'the same at any length');
    assertEqual(textureFrame(144), [-2, 147], 'whatever the scale it is drawn at');
    assertEqual(textureFrame(100.4), [-1, 103], 'a size rounded down: its end padded the more');
    assertEqual(textureFrame(100.6), [-2, 104], 'rounded up');
    for (const length of [1, 32, 108, 972, 1080, 1920, 2560, 3840]) {
        const [start, size] = textureFrame(length);
        assert(start <= -0.75 && start + size >= length + 0.75,
            `${length}: at least 0.75 px of padding either side`);
    }
}
