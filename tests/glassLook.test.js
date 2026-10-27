import {
    EDGE, FACES, LOOK, REST_LIGHT, SMALL, VARIANTS, blurTaps, bodyRect, boundsOf, edgeReach,
    dimmedLook, faceColor, faceOf, lensDepth, lensOf, lightToward, lookOf, materialValues, resolveVariant, sameLight, sameNumbers,
    smallness, textureFrame,
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
        assert(look.lens.bevel === 20 && look.lens.depth === 60 && look.lens.dispersion === 0,
            `${variant}: Apple's bevel, no colour fringe`);
        assert(look.glint > 0 && look.glint < 1, `${variant}: a glint`);
    }
    assert(LOOK.regular.blur === 2 && LOOK.clear.blur === 0, 'regular lightly blurred, clear not at all');
    assert(LOOK.clear.glint > LOOK.regular.glint, 'clear glass glints more');
    assert(LOOK.regular.contour.dark > LOOK.regular.contour.light && LOOK.clear.contour.dark === LOOK.clear.contour.light,
        'a darker contour in the dark style; clear glass\'s its own');
    assertEqual(faceOf(LOOK.regular, {light: true}), 'light', 'regular: GNOME\'s style\'s face');
    assertEqual(faceOf(LOOK.regular, {light: false}), 'dark', 'dark in its dark style');
    assertEqual(faceOf(LOOK.clear, {light: true}), 'clear', 'clear: its own');
    assertEqual(faceOf(null, {light: true}), null, 'none: none');
}

export function testFaces() {
    const grey = v => [v, v, v];
    const close = (a, b, message) => assert(a.every((v, i) => Math.abs(v - b[i]) < 1e-6), `${message} (${a})`);
    // Light glass lifts black (to its lift) and keeps white white.
    close(faceColor(grey(0), 'light'), grey(FACES.light.lift), 'light glass over black: its lift');
    assert(faceColor(grey(1), 'light')[0] > 0.98, 'light glass over white: white');
    // Dark glass: nearly clear under a light dark wash – a straight line
    // from black, white a light grey – what is behind a little richer.
    close(faceColor(grey(0), 'dark'), grey(FACES.dark.lift), 'dark glass over black: as dark');
    const white = faceColor(grey(1), 'dark')[0];
    assert(near(white, FACES.dark.lift + FACES.dark.T) && white > 0.6 && white < 0.75, `dark glass over white: ${white}`);
    assert(near(faceColor(grey(0.5), 'dark')[0], FACES.dark.lift + FACES.dark.T / 2), 'its greys on a straight line');
    const sky = faceColor([0.4, 0.6, 0.95], 'dark');
    const chroma = rgb => Math.max(...rgb) - Math.min(...rgb);
    assert(sky[2] > sky[1] && sky[1] > sky[0] && chroma(sky) / Math.max(...sky) > 0.55 / 0.95,
        `a sky stays blue, a little richer (${sky})`);
    for (const face of ['light', 'dark', 'clear'])
        assert(FACES[face].g >= FACES[face].T, `${face}: no less colourful than it lets light through`);
    // Small controls of dark glass: lighter over light backdrops.
    assert(faceColor(grey(0.9), 'dark', {small: 1})[0] > faceColor(grey(0.9), 'dark')[0],
        'a small control lighter');
    close(faceColor(grey(0.4), 'light', {small: 1}), faceColor(grey(0.4), 'light'), 'light glass the same small');
    // Clear: nearly what is behind, a little lifted.
    const clear = faceColor(grey(0.5), 'clear')[0];
    assert(clear > 0.5 && clear < 0.65, `clear glass over grey: ${clear}`);
    // Neutral: a grey stays grey; colour stays its hue, a little richer.
    const red = faceColor([0.8, 0.2, 0.2], 'light');
    assert(red[0] > red[1] && near(red[1], red[2]), `a red stays red (${red})`);
    // One glass everywhere: no darker face for what is styled for a dark
    // surface (its shade keeps that legible).
    assertEqual(Object.keys(FACES).sort(), ['clear', 'dark', 'light'], 'the faces there are');
    assert(faceColor([1, 0, 0], 'light').every(v => v >= 0 && v <= 1), 'within 0 … 1');
}

export function testSmallness() {
    assertEqual(SMALL, [40, 80]);
    assertEqual(smallness(32), 1, 'the island at rest: a small control');
    assertEqual(smallness(100), 0, 'a panel: not');
    assert(near(smallness(60), 0.5), 'half way between');
}

export function testLens() {
    assertEqual(lensDepth(0, 20, 60), 60, 'the whole depth at the very edge');
    assertEqual(lensDepth(20, 20, 60), 0, 'nothing from the bevel\'s end in');
    assertEqual(lensDepth(50, 20, 60), 0, 'the middle flat');
    assertEqual(lensDepth(5, 0, 60), 0, 'no bevel: no lens');
    // Where it looks up (d + depth) falls, then rises again: the outer part
    // of the bevel is a mirrored copy, some 0.55 (depth twice the bevel: a
    // small part) to 0.68 of it (three times).
    for (const [bevel, depth] of [[20, 60], [12, 24]]) {
        const at = d => d + lensDepth(d, bevel, depth);
        let turn = 0;
        for (let d = 0.01; d < bevel; d += 0.01) {
            if (at(d) < at(turn) - 1e-9)
                turn = d;
        }
        assert(turn > 0.55 * bevel && turn < 0.69 * bevel,
            `${bevel}, ${depth}: mirrored over the outer ${(turn / bevel).toFixed(3)} of the bevel`);
    }
    assertEqual(lensOf(LOOK.regular.lens, 200), {bevel: 20, depth: 60}, 'a panel: the whole bevel');
    const circle = lensOf(LOOK.regular.lens, 48);
    assert(near(circle.bevel, 16) && near(circle.depth, 31.2), `a 48 px circle: a third, 0.65 of it (${JSON.stringify(circle)})`);
    const capsule = lensOf(LOOK.regular.lens, 24);
    assert(near(capsule.bevel, 8) && near(capsule.depth, 15.6), 'a 24 px capsule: its rim bends too');
    const between = lensOf(LOOK.regular.lens, 96);
    assert(between.bevel === 20 && between.depth > 48 && between.depth < 60, `96 px: between (${between.depth})`);
    assertEqual(lensOf(LOOK.regular.lens, 400, 2), {bevel: 40, depth: 120}, 'in pixels at scale 2');
}

export function testBlurTaps() {
    assertEqual(blurTaps(0), {taps: 1, offset: 0, weight: 0}, 'clear glass: one tap');
    const five = blurTaps(0.8);
    assert(five.taps === 5 && near(4 * five.weight * five.offset ** 2, 0.64), `a light blur: five, its spread (${five.weight})`);
    const nine = blurTaps(4);
    assert(nine.taps === 9 && near(2 * nine.weight * nine.offset ** 2, 16), 'more: nine, the Gaussian\'s spread');
}

export function testMaterialValues() {
    const look = LOOK.regular;
    const values = materialValues(look, 2, {light: false, shadow: true, density: 2});
    assertEqual(values.lens, [40, 120, 0, 1], 'lengths in the surface\'s pixels, the material on');
    const taps = blurTaps(look.blur * 2 * 2);
    assertEqual(values.blur, [taps.taps, taps.offset / 2, taps.weight, look.grain],
        'the blur\'s taps for its texels, apart in pixels; the grain');
    const dark = FACES.dark;
    assertEqual(values.face, [dark.lift, dark.T, dark.lambda, dark.g], 'the dark style\'s face');
    assertEqual(values.small, [dark.small.T, dark.small.lambda, 2, 0], 'and its small controls\'');
    assert(!('deep' in values), 'no deep glass\'s');
    assertEqual(values.glint, [look.glint, EDGE.glint.side, EDGE.glint.near * 2, EDGE.glint.far * 2], 'the glint');
    assertEqual(values.edge, [EDGE.bevel.amount, EDGE.bevel.reach * 2, EDGE.contour.width * 2, look.contour.dark],
        'the bevel and the contour');
    assertEqual(values.shadow, [EDGE.shadow.y * 2, EDGE.shadow.sigma * 2, EDGE.shadow.alpha, 0], 'the shadow');
    const light = materialValues(look, 1, {light: true});
    assertEqual(light.lightFace, [FACES.light.lift, FACES.light.T, FACES.light.lambda, FACES.light.g],
        'the light style\'s face beside the dark one');
    assertEqual(light.face, values.face, 'the dark one whatever the style');
    assertEqual(light.style, [1, look.contour.light], 'the light style\'s, and its contour');
    assertEqual(materialValues(look, 1, {light: 0.25}).style[0], 0.25, 'on the way from one style to the other');
    assertEqual(values.style, [0, look.contour.light], 'the dark style');
    assertEqual(light.shadow[2], 0, 'no shadow unless asked');
    const clear = materialValues(LOOK.clear, 1, {light: true});
    assert(clear.face[1] === FACES.clear.T && clear.lightFace[1] === FACES.clear.T, 'clear glass\'s own in either');
    const none = materialValues(null);
    assertEqual(none.lens[3], 0, 'none: only the shape');
    // Its dim: the look's (the glass-dim setting's), or on its way there.
    assertEqual(values.dim, 0, 'not darkened by default');
    assertEqual(materialValues(dimmedLook(look, 0.3), 1).dim, 0.3, 'darkened as the setting has it');
    assertEqual(materialValues(dimmedLook(look, 0.3), 1, {dim: 0.1}).dim, 0.1, 'or on its way there');
    assertEqual(none.dim, 0, 'none without glass');
    assert(edgeReach(true) > EDGE.shadow.y + 2 * EDGE.shadow.sigma && edgeReach(false) < 2,
        'drawn as far out as the shadow goes, or the contour');
}

export function testSameNumbers() {
    assert(sameNumbers({dim: 0.2}, {dim: 0.20001}) && !sameNumbers({dim: 0.2}, {}),
        'the same as far as anyone could see, none missing counted as 0');
    assert(sameNumbers({light: 0}, {}) && !sameNumbers({light: 1}, {light: 0.5}), 'whatever is eased');
}

export function testDimmedLook() {
    const look = dimmedLook(LOOK.regular, 0.4);
    assert(look.dim === 0.4 && look.blur === LOOK.regular.blur && look.lens === LOOK.regular.lens,
        'the look, darkened');
    assert(Object.isFrozen(look) && LOOK.regular.dim === undefined, 'a look of its own, the variant\'s as it is');
    assertEqual(dimmedLook(lookOf('off'), 0.4), null, 'solid surfaces: none');
}

export function testLightTowardThePointer() {
    const area = [100, 100, 200, 40];
    const light = LOOK.regular.light;
    assert(near(REST_LIGHT[0], REST_LIGHT[1]) && REST_LIGHT[0] < 0 && near(Math.hypot(...REST_LIGHT), 1),
        'at rest: from the top left');
    assertEqual(lightToward(area, [1000, 1000], light), REST_LIGHT, 'far: from the top left');
    assertEqual(lightToward(area, [200, 100 - light.near - 1], light), REST_LIGHT, 'just past near: the same');
    // Beside it on the left, a little away: leaning left.
    const left = lightToward(area, [60, 120], light);
    assert(left[0] < REST_LIGHT[0] && left[1] < 0, `beside it on the left: leaning left (${left})`);
    assert(near(Math.hypot(...left), 1), 'a direction');
    // Right at it: as far as it leans; nearer leans more.
    const touching = lightToward(area, [100, 120], light);
    const farther = lightToward(area, [20, 120], light);
    assert(touching[0] < farther[0] && farther[0] < REST_LIGHT[0], `nearer leans more (${touching} vs ${farther})`);
    const [lx, ly] = [REST_LIGHT[0] * (1 - light.lean) - light.lean, REST_LIGHT[1] * (1 - light.lean)];
    assert(near(touching[0], lx / Math.hypot(lx, ly)) && near(touching[1], ly / Math.hypot(lx, ly)),
        `at most lean of the way (${touching})`);
    // Over its middle: at rest; over its right end: leaning right.
    assert(sameLight(lightToward(area, [200, 120], light), REST_LIGHT), 'over its middle: at rest');
    assert(lightToward(area, [295, 120], light)[0] > REST_LIGHT[0], 'over its right end: leaning right');
    // Eased: hardly any lean as the pointer comes within reach.
    const edge = lightToward(area, [100 - light.near + 2, 120], light);
    assert(edge[0] < REST_LIGHT[0] && Math.abs(edge[0] - REST_LIGHT[0]) < 5e-3,
        `hardly any lean at the edge of reach (${edge})`);
    // In pixels: twice as far at scale 2.
    assert(lightToward([200, 200, 400, 80], [200 - light.near * 1.5, 240], light, 2)[0] < REST_LIGHT[0],
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
