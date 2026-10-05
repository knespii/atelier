import {
    PRESETS, VARIANTS, buildPalette, contrastRatio, extractSwatches, hexToOklch, hexToRgb,
    nearestAccent, oklabToRgbUnclamped, oklchToRgb, pickSource, rgbToHex, rgbToOklab,
} from '../lib/palette.js';
import {assert, assertEqual} from './util.js';

const HEX = /^#[0-9a-f]{6}$/;

function image(parts) {
    // parts: [[hex, count], ...] -> RGB bytes
    const bytes = [];
    for (const [hex, count] of parts) {
        const rgb = hexToRgb(hex);
        for (let i = 0; i < count; i++)
            bytes.push(...rgb);
    }
    return new Uint8Array(bytes);
}

export function testRoundTrip() {
    for (const hex of ['#000000', '#ffffff', '#3584e4', '#e62d42', '#7a6b3f', '#12ffa0']) {
        const back = rgbToHex(oklabToRgbUnclamped(rgbToOklab(hexToRgb(hex))));
        const delta = hexToRgb(back).map((v, i) => Math.abs(v - hexToRgb(hex)[i]));
        assert(Math.max(...delta) <= 1, `${hex} -> ${back}`);
    }
}

export function testGamutMapping() {
    // Very high chroma doesn't fit sRGB: the result must still be a valid color.
    const rgb = oklchToRgb([0.7, 0.4, 140]);
    assert(rgb.every(v => v >= 0 && v <= 255), `in gamut: ${rgb}`);
}

export function testExtractionIsDeterministic() {
    const pixels = image([['#1f5f9f', 700], ['#e07a1f', 250], ['#f2f2f2', 50]]);
    const a = extractSwatches(pixels, {k: 4});
    const b = extractSwatches(pixels, {k: 4});
    assertEqual(a.map(s => s.hex), b.map(s => s.hex), 'same input, same swatches');
    assert(a[0].share > 0.6, 'blue is the most common swatch');
    assert(a.every(s => HEX.test(s.hex)));
    const total = a.reduce((sum, s) => sum + s.share, 0);
    assert(Math.abs(total - 1) < 1e-9, 'shares add up');
}

export function testExtractionHonoursRowstride() {
    // 2×2 image, RGBA, rows padded to 12 bytes
    const pixels = new Uint8Array([
        255, 0, 0, 255, 255, 0, 0, 255, 9, 9, 9, 9,
        255, 0, 0, 255, 255, 0, 0, 255, 9, 9, 9, 9,
    ]);
    const swatches = extractSwatches(pixels, {channels: 4, rowstride: 12, width: 2, k: 2});
    assertEqual(swatches.map(s => s.hex), ['#ff0000'], 'padding bytes are ignored');
}

export function testSourcePrefersColorOverGray() {
    const pixels = image([['#808080', 600], ['#2a8f4a', 300], ['#0a0a0a', 100]]);
    const swatches = extractSwatches(pixels, {k: 3});
    const source = swatches[pickSource(swatches)];
    const [, C, h] = hexToOklch(source.hex);
    assert(C > 0.08 && h > 120 && h < 170, `green chosen, got ${source.hex}`);
}

export function testReadableSchemes() {
    for (const preset of Object.values(PRESETS)) {
        for (const variant of VARIANTS) {
            const palette = buildPalette({source: preset.color, variant});
            for (const name of ['dark', 'light']) {
                const s = palette[name];
                const label = `${preset.name}/${variant}/${name}`;
                assert(Object.values(s).every(v => HEX.test(v)), `${label}: valid colors`);
                assert(contrastRatio(s.onSurface, s.surface) >= 7, `${label}: text on surface`);
                assert(contrastRatio(s.onSurface, s.surfaceContainerHigh) >= 4.5, `${label}: text on cards`);
                assert(contrastRatio(s.onPrimary, s.primary) >= 4.5,
                    `${label}: text on primary ${s.onPrimary}/${s.primary}`);
                assert(contrastRatio(s.onPrimaryContainer, s.primaryContainer) >= 4.5,
                    `${label}: text on primary container`);
            }
        }
    }
}

export function testVariants() {
    const vibrant = buildPalette({source: '#2f8fb0', variant: 'vibrant'});
    const muted = buildPalette({source: '#2f8fb0', variant: 'muted'});
    const mono = buildPalette({source: '#2f8fb0', variant: 'monochrome'});
    const chroma = p => hexToOklch(p.dark.primary)[1];
    assert(chroma(vibrant) > chroma(muted), 'vibrant is more colorful than muted');
    assert(chroma(mono) < 0.01, 'monochrome has no color');
    assertEqual(mono.accent, 'slate');
    assertEqual(vibrant.accent, nearestAccent(vibrant.dark.primary));
}

export function testTerminalColors() {
    const palette = buildPalette({source: '#c8892b'});
    for (const name of ['dark', 'light']) {
        const colors = palette.terminal[name];
        assertEqual(colors.length, 16, `${name}: 16 colors`);
        assert(colors.every(c => HEX.test(c)), `${name}: valid colors`);
        // red stays red, blue stays blue (harmonized only slightly)
        const hue = c => hexToOklch(c)[2];
        assert(hue(colors[1]) < 60 || hue(colors[1]) > 350, `${name}: red ${colors[1]}`);
        assert(hue(colors[4]) > 220 && hue(colors[4]) < 290, `${name}: blue ${colors[4]}`);
    }
}

export function testNearestAccent() {
    assertEqual(nearestAccent('#2190a4'), 'teal');
    assertEqual(nearestAccent('#e62d42'), 'red');
    assertEqual(nearestAccent('#3a944a'), 'green');
    assertEqual(nearestAccent('#777777'), 'slate');
}
