#!/usr/bin/env python3
# The cutout of a wallpaper for the lock screen's depth effect (lib/depth.js):
# what stands nearer than the far layer of the picture – the sky, distant
# mountains, the view out of a window – with the rest made see-through.
# How near each pixel is comes from Depth Anything V2, a model that guesses
# depth from a single picture; the sky, found by its colours, is never in
# front however near the model makes it. Another model, BiRefNet, finds the
# picture's subject – a person, an animal, a thing – as an iPhone does for
# its own depth effect; where it is sure of one (whole, sharp, neither a
# speck nor the landscape nor the sky, and not far off), the subject stands
# in front too. The cutout's edges follow the picture's own outlines. The
# shell runs it in a process of its own, in the session (never on the lock
# screen), at the lowest priority, one wallpaper at a time.
#
#   depthWorker.py --check [--model FILE] [--subject FILE]
#       what is there: the Python modules it needs, and whether each model
#       given loads
#   depthWorker.py [--model FILE] [--subject FILE] --input PICTURE
#                  --output CUTOUT.png --width W --height H
#       the cutout, of what the models given see (the depth model, the
#       subject model or both), big enough to cover a monitor of W×H as
#       GNOME's zoom does (never bigger than the picture), written whole or
#       not at all
#
# It says how it went in one line of JSON on its standard output. Exit
# status: 0 done, 2 asked wrongly, 3 a module missing, 4 failed.

import json
import os
import sys

# The Debian and Ubuntu packages each module comes in.
PACKAGES = {'onnxruntime': 'python3-onnxruntime', 'numpy': 'python3-numpy', 'PIL': 'python3-pil'}
# The model's input: this many pixels on the short side (as it was trained),
# both sides a multiple of its patches.
SHORT = 518
PATCH = 14
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)
# The subject model's input, where the model doesn't say: a square this many
# pixels a side (BiRefNet's export says so, and takes no other: its decoder
# is cut to it), the picture squeezed into it as its own processor does,
# with the same mean and deviation.
SUBJECT_SIDE = 1024
# Threads for the model: four at most (it runs at the lowest priority, so
# the desktop comes first all the same), a third of the processor's.
THREADS = max(1, min(4, (os.cpu_count() or 1) // 3))
# glibc's mallopt() for the size from which memory is mapped on its own (and
# so given back as soon as it is let go of).
M_MMAP_THRESHOLD = -3

# The far layer and what stands in front of it. The model says how near
# each pixel is (larger, nearer), here 0 (the farthest) … 1 (the nearest).
# The sky and a view through a window stand apart from the rest: a gap in
# the depths, a band where hardly any pixel is (this share of them in each
# hundredth), above a far layer of this share of the picture at least,
# looked for in the far half.
GAP = 0.002
FAR_LEAST = 0.05
GAP_LOW = 0.5
# Without a gap (misty mountains behind a town), the far layer is the
# farthest of the depths many pixels share, and what is nearer than it by
# this much stands in front.
NEARER = 1.6
# The step from the far layer to what stands in front: over this ratio of
# nearness, before the edges are fitted to the picture.
STEP = 1.5
# Fitting the edges to the picture (a guided filter, on a copy half as
# big): its window, a share of the copy's longer side, and how closely it
# follows the picture's colours.
FIT_WINDOW = 1 / 200
FIT_EPS = 1e-3
# How sharp the fitted edge is made again: the slope of its last step.
SHARPEN = 4

# The sky: looked for on a copy of the picture this wide, pixels.
SKY_WIDTH = 640
# The hues of a blue sky, 0 … 1 around the colour wheel (cyan to blue).
BLUE = (0.5, 0.7)
# How rough the sky may be: the mean step in brightness between pixels next
# to each other, on a copy twice as wide (denim, grass and leaves are rougher).
SMOOTH_BLUE = 0.02
SMOOTH_CLOUD = 0.1
# How far (in RGB, 0 … 1) a colour may be from the sky's own blue there, or
# from that blue mixed with white (the hazy edge of a cloud): bluish and
# darker – a blue shirt, a pale foot against the sky – is further.
SKY_NEAR = 0.07
# A sky worth the name: this share of the top row at least, and of the whole
# picture; and with ground under it, this share of the bottom rows. (Blue
# glimpsed between the shapes of a pattern is not one.)
SKY_TOP = 0.5
SKY_SHARE = 0.2
SKY_GROUND = 0.6
# …and of it this share blue at least.
SKY_BLUE = 0.25
# The edge of the sky, soft over about this many pixels of the cutout.
SKY_EDGE = 3
# How far the sky grows into clouds on the horizon, pixels of its copy, and
# how light (0 … 1) a blue there has to be for it.
SKY_GROW = 24
HAZE = 0.88
# The sky is kept out of what stands in front where the model makes it no
# nearer than this many times the far layer's edge (a cloud it thinks near);
# nearer than that, it is something in front with the sky showing through
# (a see-through sleeve, a window).
SKY_NEARER = 2

# The subject model's subject is held to only where the model is sure of
# it, part by part (a part: where it is at least half sure, on the sky's
# copy of the picture, each pixel joined to the four next to it). A part:
# - of this share of the picture at least (smaller, it is a crumb: a
#   pebble, a glint, a distant boat);
PART_LEAST = 0.005
# - with a sharp edge: the pixels the model hesitates over (between
#   UNSURE's chances), RIM pixels round the part at most, on the model's
#   square, at most BAND_MOST for each pixel of its outline (a sure edge is
#   about one pixel wide; a blotch the model guesses at, several);
UNSURE = (0.1, 0.9)
RIM = 6
BAND_MOST = 2.5
# - not the sky: at most this share of it sky (a cloud, the sun);
SKY_MOST = 0.3
# - not the landscape: a part from one side of the picture to the other is
#   the land, the sea or a skyline – the depth model's to place;
# - one thing, not a heap of them: at most HOLES_MOST pieces of the
#   background shut in by it, of HOLE_LEAST of the picture each at least
#   (the gaps in a heap of symbols, not a ring's hole or a pinhole);
HOLES_MOST = 8
HOLE_LEAST = 0.0002
# - not far off, with the depth model: half of it at least as near as where
#   the step up from the far layer starts (the moon, a mountain or a town in
#   the distance stay behind, as they did).
# And all it holds to together: this share of the picture at least (less is
# no subject), at most (more is the scene, not a subject), and its biggest
# part this share of it at least (a subject, or a few, not bits all over).
SUBJECT_LEAST = 0.01
SUBJECT_MOST = 0.6
COHERENT = 0.6


def say(answer, status=0):
    print(json.dumps(answer), flush=True)
    sys.exit(status)


def modules():
    """The modules needed, or None for each missing one."""
    found = {}
    for name in PACKAGES:
        try:
            found[name] = __import__(name)
        except ImportError:
            found[name] = None
    return found


def options(argv):
    names = {'--model', '--subject', '--input', '--output', '--width', '--height'}
    chosen = {'check': '--check' in argv}
    args = [a for a in argv if a != '--check']
    while args:
        name = args.pop(0)
        if name not in names or not args:
            say({'ok': False, 'error': f'unknown option {name}'}, 2)
        chosen[name[2:]] = args.pop(0)
    return chosen


def session(ort, model):
    settings = ort.SessionOptions()
    settings.intra_op_num_threads = THREADS
    settings.inter_op_num_threads = 1
    # (Without the runtime's own pool of memory, kept till the model is
    # done: half a gigabyte less at the most, for the same result.)
    settings.enable_cpu_mem_arena = False
    runner = ort.InferenceSession(model, sess_options=settings, providers=['CPUExecutionProvider'])
    # (A picture in, a map out: anything else is another model.)
    if len(runner.get_inputs()) != 1 or len(runner.get_inputs()[0].shape) != 4:
        raise ValueError('it is not a model of pictures (it takes no picture)')
    return runner


def check(found, models):
    missing = [PACKAGES[name] for name, module in found.items() if module is None]
    answer = {'ok': not missing, 'missing': missing}
    for name, model in models.items():
        if not model or missing:
            continue
        if not os.path.isfile(model):
            answer.update({'ok': False, name: 'missing'})
            continue
        try:
            session(found['onnxruntime'], model)
            answer[name] = 'ok'
        except Exception as e:  # anything the runtime says of a broken file
            answer.update({'ok': False, name: f'does not load: {e}'})
    say(answer)


def depths(found, model, picture):
    """How near each pixel is, 0 (the farthest) … 1 (the nearest), as the
    model sees the picture (SHORT pixels on its short side)."""
    np, Image = found['numpy'], found['PIL'].Image
    scale = SHORT / min(picture.size)
    width, height = (max(PATCH, round(side * scale / PATCH) * PATCH) for side in picture.size)
    small = np.asarray(picture.resize((width, height), Image.Resampling.BICUBIC), dtype=np.float32) / 255
    small = (small - np.array(MEAN, dtype=np.float32)) / np.array(STD, dtype=np.float32)
    tensor = small.transpose((2, 0, 1))[np.newaxis].astype(np.float32)
    runner = session(found['onnxruntime'], model)
    output = runner.run(None, {runner.get_inputs()[0].name: tensor})[0]
    del runner  # (its memory back before the rest)
    near = np.asarray(output, dtype=np.float32).reshape(output.shape[-2:])
    # (The nearest few pixels all 1: a speck of noise doesn't set the scale.)
    low, high = float(near.min()), float(np.percentile(near, 99.5))
    if high - low < 1e-6:
        return np.zeros(near.shape, dtype=np.float32)
    return np.clip((near - low) / (high - low), 0, 1)


def release():
    """The memory a model has let go of given back to the system (glibc's
    malloc keeps it otherwise: two gigabytes of Depth Anything's, under the
    next model's)."""
    try:
        import ctypes
        ctypes.CDLL('libc.so.6').malloc_trim(0)
    except (OSError, AttributeError):
        pass


def chances(found, model, picture):
    """How sure the subject model is that each pixel is the subject's, 0 …
    1, on its square (the picture squeezed into it)."""
    np, Image = found['numpy'], found['PIL'].Image
    runner = session(found['onnxruntime'], model)
    entry = runner.get_inputs()[0]
    # (Of the size the model has, BiRefNet's being fixed.)
    height, width = (side if isinstance(side, int) and side > 0 else SUBJECT_SIDE for side in entry.shape[2:])
    small = np.asarray(picture.resize((width, height), Image.Resampling.BILINEAR), dtype=np.float32) / 255
    small = (small - np.array(MEAN, dtype=np.float32)) / np.array(STD, dtype=np.float32)
    tensor = small.transpose((2, 0, 1))[np.newaxis].astype(np.float32)
    names = [output.name for output in runner.get_outputs()]
    output = runner.run(['output_image' if 'output_image' in names else names[-1]], {entry.name: tensor})[0]
    del runner
    # (Its logits: a sigmoid makes them chances.)
    logits = np.asarray(output, dtype=np.float32).reshape(output.shape[-2:])
    return 1 / (1 + np.exp(-np.clip(logits, -40, 40)))


def split(np, near):
    """Where the far layer ends: the nearness (0 … 1) what stands in front
    starts from, and how it was found ('gap' or 'far')."""
    share = np.histogram(near, bins=100, range=(0, 1))[0] / near.size
    below = np.cumsum(share)
    # A gap above the far layer: in the middle of it (as a ratio).
    for start in range(1, round(GAP_LOW * 100)):
        if share[start] < GAP and below[start - 1] >= FAR_LEAST:
            end = start
            while end < 100 and share[end] < GAP:
                end += 1
            return float(np.sqrt(start * end)) / 100, 'gap'
    # None: the farthest of the depths that many pixels share (over half as
    # many as the depth most share), on a scale of ratios, smoothed.
    edges = np.linspace(np.log(0.01), 0, 41)
    counts = np.histogram(np.log(np.maximum(near, 0.01)), bins=edges)[0].astype(np.float64)
    counts = np.convolve(np.pad(counts, 1, mode='edge'), [0.25, 0.5, 0.25], 'valid')
    for i, count in enumerate(counts):
        if (count >= 0.5 * counts.max() and count >= counts[max(0, i - 1)] and
                count >= counts[min(len(counts) - 1, i + 1)]):
            return float(np.exp((edges[i] + edges[i + 1]) / 2)) * NEARER, 'far'
    return 0.5, 'far'


def box(np, a, r):
    """The mean of each (2r + 1)² window of a (its edges carried on)."""
    side = 2 * r + 1
    padded = np.pad(a, [(r + 1, r), (r + 1, r)] + [(0, 0)] * (a.ndim - 2), mode='edge')
    total = padded.cumsum(0).cumsum(1)
    return (total[side:, side:] - total[:-side, side:] - total[side:, :-side] + total[:-side, :-side]) / (side * side)


def fit(np, Image, picture, mask):
    """The mask (0 … 1, as big as the picture) with its edges moved onto the
    picture's own: He's guided filter, by the picture's colours, worked out
    on copies half as big and laid over the whole one."""
    size = picture.size
    half = (max(1, size[0] // 2), max(1, size[1] // 2))
    guide = np.asarray(picture.resize(half, Image.Resampling.BOX), dtype=np.float32) / 255
    rough = np.asarray(Image.fromarray(mask.astype(np.float32), 'F').resize(half, Image.Resampling.BOX))
    r = max(2, round(max(half) * FIT_WINDOW))
    mean = box(np, guide, r)
    mean_mask = box(np, rough, r)
    together = box(np, guide * rough[..., np.newaxis], r) - mean * mean_mask[..., np.newaxis]
    spread = np.empty(guide.shape[:2] + (3, 3), dtype=np.float32)
    for i in range(3):
        for j in range(i, 3):
            both = box(np, guide[..., i] * guide[..., j], r) - mean[..., i] * mean[..., j]
            spread[..., i, j] = spread[..., j, i] = both
    spread += FIT_EPS * np.eye(3, dtype=np.float32)
    a = np.linalg.solve(spread, together[..., np.newaxis])[..., 0]
    b = mean_mask - (a * mean).sum(axis=2)
    a, b = box(np, a, r), box(np, b, r)

    def whole(channel):
        return np.asarray(Image.fromarray(channel.astype(np.float32), 'F').resize(size, Image.Resampling.BILINEAR))
    full = np.asarray(picture, dtype=np.float32) / 255
    return sum(whole(a[..., i]) * full[..., i] for i in range(3)) + whole(b)


def flood(np, Image, ImageDraw, inside, sides):
    """What of `inside` (booleans) is joined to the given sides of the picture
    ('top', 'left', 'right', 'bottom'), as PIL's flood fill finds it."""
    height, width = inside.shape
    canvas = np.zeros((height + 2, width + 2), dtype=np.uint8)
    canvas[1:-1, 1:-1] = np.where(inside, 255, 0)
    # (A frame round the picture, open on the sides asked for, to start from.)
    canvas[0, :] = 255 if 'top' in sides else 1
    canvas[-1, :] = 255 if 'bottom' in sides else 1
    canvas[1:-1, 0] = 255 if 'left' in sides else 1
    canvas[1:-1, -1] = 255 if 'right' in sides else 1
    image = Image.fromarray(canvas, 'L').copy()  # (one of its own, to draw on)
    for y, x in ((0, 0), (0, width + 1), (height + 1, 0), (height + 1, width + 1)):
        if image.getpixel((x, y)) == 255:
            ImageDraw.floodfill(image, (x, y), 128)
    side = {'top': (0, 1), 'bottom': (height + 1, 1), 'left': (1, 0), 'right': (1, width + 1)}
    for name in sides:
        y, x = side[name]
        if image.getpixel((x, y)) == 255:
            ImageDraw.floodfill(image, (x, y), 128)
    return np.asarray(image)[1:-1, 1:-1] == 128


def parts(np, Image, ImageDraw, inside):
    """The parts of `inside` (booleans), each pixel joined to the four next
    to it: the part of each pixel (0 outside them, 1 … for theirs) and how
    many there are."""
    canvas = Image.fromarray(inside.astype(np.int32), 'I')
    count = 0
    for y, x in np.argwhere(inside):
        if canvas.getpixel((int(x), int(y))) == 1:
            count += 1
            ImageDraw.floodfill(canvas, (int(x), int(y)), count + 1)
    labels = np.asarray(canvas)
    return np.where(labels > 0, labels - 1, 0), count


def sky(found, picture):
    """Where the sky is, 1 … 0, SKY_WIDTH wide: blue or the white and grey of
    clouds, smooth, joined to the top of the picture, with what lies in it
    (a cloud, a bird) counted in – and, as booleans, which of it looks like
    sky itself (not a bird in it). (None, None) when there is no sky worth
    the name (a room, a pattern, a picture without ground under it)."""
    np, Image = found['numpy'], found['PIL'].Image
    from PIL import ImageDraw, ImageFilter
    width = min(SKY_WIDTH, picture.width)
    height = max(8, round(picture.height * width / picture.width))
    small = picture.resize((width, height), Image.Resampling.BOX)
    # How rough it is: the steps in brightness on a copy twice as big, the
    # mean of each two by two (a blur would smooth denim into sky).
    grey = np.asarray(picture.resize((width * 2, height * 2), Image.Resampling.BOX).convert('L'),
                      dtype=np.float32) / 255
    steps = (np.abs(np.diff(grey, axis=1, append=grey[:, -1:])) +
             np.abs(np.diff(grey, axis=0, append=grey[-1:])))
    rough = steps.reshape(height, 2, width, 2).mean(axis=(1, 3))
    hue, saturation, value = np.moveaxis(np.asarray(small.convert('HSV'), dtype=np.float32) / 255, 2, 0)
    rgb = np.asarray(small, dtype=np.float32) / 255
    blue = ((hue >= BLUE[0]) & (hue <= BLUE[1]) & (saturation > 0.12) & (value > 0.3) &
            (rough < SMOOTH_BLUE))
    cloud = (saturation < 0.2) & (value > 0.65) & (rough < SMOOTH_CLOUD)
    if (blue | cloud)[0].mean() < SKY_TOP:
        return None, None
    # The sky's own blue, as it changes over the picture (deeper up high,
    # paler at the horizon, lighter towards the sun): a smooth surface fitted
    # to the blue joined to the top, the odd one out (a blue shirt, a pale
    # foot against it) left out of it. What is blue but far from it isn't sky.
    near = flood(np, Image, ImageDraw, blue | cloud, ('top',)) & blue
    if near.sum() > 50:
        ys, xs = np.nonzero(near)
        u, v = xs / width, ys / height
        terms = np.stack([np.ones_like(u), u, v, u * u, u * v, v * v], axis=1)
        colours = rgb[ys, xs]
        keep = np.ones(len(xs), dtype=bool)
        for _ in range(6):
            fit = np.linalg.lstsq(terms[keep], colours[keep], rcond=None)[0]
            miss = np.linalg.norm(terms @ fit - colours, axis=1)
            keep = miss < max(0.02, 2 * float(np.median(miss[keep])))
        yy, xx = np.mgrid[0:height, 0:width]
        u, v = (xx / width).ravel(), (yy / height).ravel()
        model = (np.stack([np.ones_like(u), u, v, u * u, u * v, v * v], axis=1) @ fit).reshape(height, width, 3)
        # (The nearest mix of that blue with white, and how far from it.)
        white = 1 - model
        share = np.clip((((rgb - model) * white).sum(axis=2) /
                         np.maximum((white * white).sum(axis=2), 1e-6)), 0, 1)
        miss = np.linalg.norm(rgb - model - share[..., np.newaxis] * white, axis=2)
        blue = (miss < SKY_NEAR) & (rough < SMOOTH_CLOUD)
    else:
        blue[:] = False
    # Cut thin bridges (a leaf, a wire) before it is followed from the top…
    likely = Image.fromarray(np.where(blue | cloud, 255, 0).astype(np.uint8), 'L')
    likely = likely.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    found_sky = flood(np, Image, ImageDraw, np.asarray(likely) > 0, ('top',))
    # …and what lies in it, not joined to the sides or the bottom, is the sky's.
    found_sky |= ~flood(np, Image, ImageDraw, ~found_sky, ('left', 'right', 'bottom'))
    # Sky shut in by what stands in front (between a leg and the hill, say):
    # the sky's own blue, anywhere, as long as it is more than a speck.
    if near.sum() > 50:
        patches = Image.fromarray(np.where(blue, 255, 0).astype(np.uint8), 'L')
        patches = patches.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))
        found_sky |= np.asarray(patches) > 0
    # Clouds sitting on the horizon (joined to the ground, so not lying in
    # the sky) are the sky's too: it grows into what looks like sky next to
    # it, a step at a time, but no further than SKY_GROW.
    # (Paler there than the sky's blue up high, hazier: any smooth blue as
    # light as the sky's – a pale foot against it is darker.)
    airy = blue | cloud | ((hue >= BLUE[0]) & (hue <= BLUE[1]) & (value > HAZE) & (rough < SMOOTH_CLOUD))
    for _ in range(SKY_GROW):
        grown = Image.fromarray(np.where(found_sky, 255, 0).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(3))
        more = (np.asarray(grown) > 0) & airy & ~found_sky
        if not more.any():
            break
        found_sky |= more
    rows = max(1, height // 8)
    if (found_sky[0].mean() < SKY_TOP or found_sky.mean() < SKY_SHARE or
            (~found_sky[-rows:]).mean() < SKY_GROUND or
            # (Some of it blue: white alone may be a page, a wall, a map.)
            (found_sky & near).sum() < SKY_BLUE * found_sky.sum()):
        return None, None
    # Its edge smoothed: specks gone, the outline rounded.
    mask = Image.fromarray(np.where(found_sky, 255, 0).astype(np.uint8), 'L')
    mask = mask.filter(ImageFilter.MedianFilter(5))
    return np.asarray(mask, dtype=np.float32) / 255, found_sky & airy


def soften(np, Image, ImageFilter, mask, size):
    """A mask of 0 … 1, made as big as the cutout, its edge soft over about
    SKY_EDGE pixels there (however small the mask was)."""
    height, width = mask.shape
    blurred = Image.fromarray((mask * 255).round().astype(np.uint8), 'L').filter(ImageFilter.GaussianBlur(1))
    big = np.asarray(blurred.resize(size, Image.Resampling.BICUBIC), dtype=np.float32) / 255
    # (The blur spreads the edge over about four pixels of the mask.)
    spread = 4 * size[0] / width
    step = np.clip((big - 0.5) * spread / SKY_EDGE + 0.5, 0, 1)
    return step * step * (3 - 2 * step)


def hold(found, chance, size, airy, near, edge):
    """What of the subject model's subject stands in front: 0 … 1, as big as
    the cutout (size), or None when the model is sure of none – and what it
    found, for the answer. chance: from chances(); airy: the sky's own
    pixels, on its copy (see sky()), or None; near: depths() as big as the
    cutout, or None without the depth model; edge: its far layer's."""
    np, Image = found['numpy'], found['PIL'].Image
    from PIL import ImageDraw, ImageFilter
    # Its parts, on a copy as big as the sky's.
    width = min(SKY_WIDTH, size[0])
    height = max(8, round(size[1] * width / size[0]))
    small = np.asarray(Image.fromarray(chance, 'F').resize((width, height), Image.Resampling.BILINEAR))
    labels, count = parts(np, Image, ImageDraw, small >= 0.5)
    area = np.bincount(labels.ravel(), minlength=count + 1) / labels.size
    answer = {'found': round(float(area[1:].sum()), 4), 'held': 0, 'parts': 0, 'left': []}
    if count == 0:
        return None, answer
    # How sharp each part's edge is, at the model's own size: the pixels the
    # model hesitates over near it (between UNSURE's chances, RIM pixels
    # round it at most), for each pixel of its outline.
    square = np.asarray(Image.fromarray(labels.astype(np.int32), 'I').resize(chance.shape[::-1],
                                                                             Image.Resampling.NEAREST))
    grown = np.asarray(Image.fromarray(square, 'I').filter(ImageFilter.MaxFilter(2 * RIM + 1)))
    grown = np.where(square > 0, square, grown)
    hesitant = np.bincount(grown[(chance > UNSURE[0]) & (chance < UNSURE[1])], minlength=count + 1)
    # (Its outline: where the next pixel is another's; the picture's sides are not one.)
    padded = np.pad(square, 1, mode='edge')
    inner = ((padded[:-2, 1:-1] == square) & (padded[2:, 1:-1] == square) &
             (padded[1:-1, :-2] == square) & (padded[1:-1, 2:] == square))
    band = hesitant / np.maximum(np.bincount(square[~inner], minlength=count + 1), 1)
    pixels = np.maximum(np.bincount(labels.ravel(), minlength=count + 1), 1)
    skyish = (np.bincount(labels.ravel(), weights=airy.ravel(), minlength=count + 1) / pixels
              if airy is not None else np.zeros(count + 1))
    across = (set(labels[:, 0].tolist()) & set(labels[:, -1].tolist())) - {0}
    # The pieces of the background each part shuts in (joined to none of
    # the picture's sides), each counted for the part round it.
    outside = small < 0.5
    holes, many = parts(np, Image, ImageDraw, outside & ~flood(np, Image, ImageDraw, outside,
                                                                ('top', 'bottom', 'left', 'right')))
    round_them = np.asarray(Image.fromarray(labels.astype(np.int32), 'I').filter(ImageFilter.MaxFilter(3)))
    shut = np.zeros(count + 1, dtype=int)
    for hole in np.nonzero(np.bincount(holes.ravel(), minlength=many + 1)[1:] >= HOLE_LEAST * labels.size)[0]:
        shut[round_them[holes == hole + 1].max()] += 1
    if near is not None:
        near = np.asarray(Image.fromarray(near, 'F').resize((width, height), Image.Resampling.BILINEAR))
    held, left = [], set()
    for k in range(1, count + 1):
        if area[k] < PART_LEAST:
            continue  # (a crumb: not worth a word)
        if band[k] > BAND_MOST:
            left.add('unsure')
        elif skyish[k] > SKY_MOST:
            left.add('sky')
        elif k in across:
            left.add('across')
        elif shut[k] > HOLES_MOST:
            left.add('heap')
        # (Where the step up from the far layer starts, at least.)
        elif near is not None and np.median(near[labels == k]) < edge / np.sqrt(STEP):
            left.add('far')
        else:
            held.append(k)
    # All of it together.
    total = float(area[held].sum())
    for why, wrong in (('small', total < SUBJECT_LEAST), ('big', total > SUBJECT_MOST),
                       ('scattered', area[held].max(initial=0) < COHERENT * total)):
        if held and wrong:
            left.add(why)
            held = []
    answer['left'] = sorted(left)
    if not held:
        return None, answer
    answer.update(held=round(total, 4), parts=len(held))
    keep = Image.fromarray(np.where(np.isin(labels, held), 255, 0).astype(np.uint8), 'L')
    # (With a little round it: the soft edge the model gives it is its own.)
    keep = keep.filter(ImageFilter.MaxFilter(5)).resize(size, Image.Resampling.BILINEAR)
    whole = np.asarray(Image.fromarray(chance, 'F').resize(size, Image.Resampling.BILINEAR))
    return np.where(np.asarray(keep) > 127, whole, 0), answer


def front(found, picture, near, edge, chance):
    """What stands in front, 0 … 1, as big as the picture: what is nearer
    than the far layer's edge (near: from depths(), or None without the
    depth model) and the subject the subject model is sure of (chance: from
    chances(), or None), edges fitted to the picture's own, the sky left out.
    With whether there is a sky, and what of the subject was held (None
    without the subject model)."""
    np, Image = found['numpy'], found['PIL'].Image
    from PIL import ImageFilter
    size = picture.size
    above, airy = sky(found, picture)
    rough = np.zeros((size[1], size[0]), dtype=np.float32)
    if near is not None:
        near = np.asarray(Image.fromarray(near, 'F').resize(size, Image.Resampling.BILINEAR))
        # In front: what is nearer than the far layer's edge, stepping up
        # over a ratio of STEP around it…
        rough = np.clip(np.log(np.maximum(near, 1e-4) / edge) / np.log(STEP) + 0.5, 0, 1)
    held, subject = (None, None) if chance is None else hold(found, chance, size, airy, near, edge)
    if held is not None:
        # …and the subject, as the subject model sees it.
        rough = np.maximum(rough, held)
    # Their edges then moved onto the picture's own, and made sharp again
    # (soft over a pixel or two).
    alpha = np.clip((fit(np, Image, picture, rough) - 0.5) * SHARPEN + 0.5, 0, 1)
    alpha = alpha * alpha * (3 - 2 * alpha)
    # None of the sky itself, however near the depth model makes a cloud –
    # but a see-through sleeve with the sky behind it is in front, as is
    # the subject (it is not sky, part by part).
    if above is not None:
        air = soften(np, Image, ImageFilter, airy.astype(np.float32), size)
        sky_too = np.ones(rough.shape, dtype=bool) if near is None else near < SKY_NEARER * edge
        if held is not None:
            sky_too &= held < 0.5
        alpha = alpha * (1 - air * sky_too)
    return alpha, above is not None, subject


def load(source):
    """The picture as GNOME has it: read by GdkPixbuf, as mutter reads it
    (JPEG XL and SVG too), turned as its camera says; by PIL without it."""
    from PIL import Image, ImageOps
    try:
        import gi
        gi.require_version('GdkPixbuf', '2.0')
        from gi.repository import GdkPixbuf
    except (ImportError, ValueError):
        with Image.open(source) as opened:
            return ImageOps.exif_transpose(opened).convert('RGB')
    pixbuf = GdkPixbuf.Pixbuf.new_from_file(source).apply_embedded_orientation()
    mode = 'RGBA' if pixbuf.get_has_alpha() else 'RGB'
    picture = Image.frombytes(mode, (pixbuf.get_width(), pixbuf.get_height()), pixbuf.get_pixels(),
                              'raw', mode, pixbuf.get_rowstride())
    return picture.convert('RGB')


def cutout(found, models, source, target, width, height):
    np = found['numpy']
    from PIL import Image, PngImagePlugin

    picture = load(source)
    shown = picture.size
    # As big as it is drawn over the monitor (zoomed in), no bigger.
    scale = min(1.0, max(width / shown[0], height / shown[1]))
    size = (max(1, round(shown[0] * scale)), max(1, round(shown[1] * scale)))
    # The subject model first: its memory back before the depth model's
    # (the most either needs is then the most the process needs).
    chance = near = edge = how = None
    if models.get('subject'):
        chance = chances(found, models['subject'], picture)
        release()
    if models.get('model'):
        near = depths(found, models['model'], picture)
        release()
        edge, how = split(np, near)
    picture = picture.resize(size, Image.Resampling.LANCZOS) if size != shown else picture
    alpha, above, subject = front(found, picture, near, edge, chance)
    alpha = Image.fromarray((alpha * 255).round().astype(np.uint8), 'L')
    picture.putalpha(alpha)
    # The picture's own size, as GNOME places it (see lib/depth.js
    # placement()), and the models it was made with (see there, modelsTag()).
    info = PngImagePlugin.PngInfo()
    info.add_text('atelier-width', str(shown[0]))
    info.add_text('atelier-height', str(shown[1]))
    info.add_text('atelier-models', ' '.join(os.path.basename(models[name]) if models.get(name) else '-'
                                             for name in ('model', 'subject')))
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    partial = f'{target}.partial'
    try:
        picture.save(partial, 'PNG', pnginfo=info)
        os.replace(partial, target)
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    covered = float((np.asarray(alpha) >= 128).mean())
    say({'ok': True, 'width': size[0], 'height': size[1], 'picture': list(shown),
         'far': None if edge is None else round(edge, 4), 'split': how, 'sky': above,
         'subject': subject, 'front': round(covered, 4)})


def main():
    chosen = options(sys.argv[1:])
    found = modules()
    models = {name: chosen[name] for name in ('model', 'subject') if name in chosen}
    if chosen['check']:
        check(found, models)
    missing = [PACKAGES[name] for name, module in found.items() if module is None]
    if missing:
        say({'ok': False, 'missing': missing,
             'error': f'missing {", ".join(missing)} (sudo apt install {" ".join(missing)})'}, 3)
    if not models:
        say({'ok': False, 'error': '--model or --subject is needed'}, 2)
    for name in ('input', 'output', 'width', 'height'):
        if name not in chosen:
            say({'ok': False, 'error': f'--{name} is needed'}, 2)
    try:
        width, height = int(chosen['width']), int(chosen['height'])
    except ValueError:
        say({'ok': False, 'error': 'the size has to be whole pixels'}, 2)
    try:
        os.nice(19)
    except OSError:
        pass
    # Memory let go of goes back to the system at once (glibc keeps it for
    # later otherwise): a gigabyte less at the most, for each model.
    try:
        import ctypes
        ctypes.CDLL('libc.so.6').mallopt(M_MMAP_THRESHOLD, 128 * 1024)
    except (OSError, AttributeError):
        pass
    try:
        cutout(found, models, chosen['input'], chosen['output'], width, height)
    except SystemExit:
        raise
    except Exception as e:  # the picture or the model unreadable, the disk full…
        say({'ok': False, 'error': f'{type(e).__name__}: {e}'}, 4)


if __name__ == '__main__':
    main()
