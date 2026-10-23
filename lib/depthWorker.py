#!/usr/bin/env python3
# The cutout of a wallpaper for the lock screen's depth effect (lib/depth.js):
# what stands in front of the sky – a hill, a town, the trees, found by the
# picture's colours alone – and the subject – what u2netp, a small model
# rembg uses, finds salient – with the rest made see-through, softly at the
# edges. The shell
# runs it in a process of its own, in the session (never on the lock screen),
# at the lowest priority, one wallpaper at a time.
#
#   depthWorker.py --check [--model FILE]
#       what is there: the Python modules it needs, and whether the model
#       loads
#   depthWorker.py --model FILE --input PICTURE --output CUTOUT.png
#                  --width W --height H
#       the cutout, big enough to cover a monitor of W×H as GNOME's zoom
#       does (never bigger than the picture), written whole or not at all
#
# It says how it went in one line of JSON on its standard output. Exit
# status: 0 done, 2 asked wrongly, 3 a module missing, 4 failed.

import json
import os
import sys

# The Debian and Ubuntu packages each module comes in.
PACKAGES = {'onnxruntime': 'python3-onnxruntime', 'numpy': 'python3-numpy', 'PIL': 'python3-pil'}
SIZE = 320  # the model's input, pixels a side
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)
# Where the saliency (0 … 1) turns from background to subject: a soft step
# between these, so faint haze around the subject goes and its edges stay soft.
EDGE = (0.3, 0.7)

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
    names = {'--model', '--input', '--output', '--width', '--height'}
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
    # (Two threads at most: the desktop stays smooth meanwhile.)
    settings.intra_op_num_threads = 2
    settings.inter_op_num_threads = 1
    return ort.InferenceSession(model, sess_options=settings, providers=['CPUExecutionProvider'])


def check(found, model):
    missing = [PACKAGES[name] for name, module in found.items() if module is None]
    answer = {'ok': not missing, 'missing': missing}
    if model and not missing:
        if not os.path.isfile(model):
            answer.update(ok=False, model='missing')
        else:
            try:
                session(found['onnxruntime'], model)
                answer['model'] = 'ok'
            except Exception as e:  # anything the runtime says of a broken file
                answer.update(ok=False, model=f'does not load: {e}')
    say(answer)


def saliency(found, model, picture):
    """The model's map of what stands out, 0 … 1, SIZE × SIZE (as rembg reads it)."""
    np, Image = found['numpy'], found['PIL'].Image
    small = np.asarray(picture.resize((SIZE, SIZE), Image.Resampling.LANCZOS), dtype=np.float32)
    small = small / max(float(small.max()), 1e-6)
    small = (small - np.array(MEAN, dtype=np.float32)) / np.array(STD, dtype=np.float32)
    tensor = small.transpose((2, 0, 1))[np.newaxis].astype(np.float32)
    runner = session(found['onnxruntime'], model)
    output = runner.run(None, {runner.get_inputs()[0].name: tensor})[0]
    prediction = np.asarray(output, dtype=np.float32).reshape(output.shape[-2:])
    low, high = float(prediction.min()), float(prediction.max())
    if high - low < 1e-6:
        return np.zeros((SIZE, SIZE), dtype=np.float32)
    return (prediction - low) / (high - low)


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


def cutout(found, model, source, target, width, height):
    np = found['numpy']
    from PIL import Image, ImageFilter, PngImagePlugin

    picture = load(source)
    shown = picture.size
    # As big as it is drawn over the monitor (zoomed in), no bigger.
    scale = min(1.0, max(width / shown[0], height / shown[1]))
    size = (max(1, round(shown[0] * scale)), max(1, round(shown[1] * scale)))
    mask = saliency(found, model, picture)
    low, high = EDGE
    step = np.clip((mask - low) / (high - low), 0, 1)
    step = step * step * (3 - 2 * step)
    alpha = Image.fromarray((step * 255).round().astype(np.uint8), 'L').resize(size, Image.Resampling.LANCZOS)
    # A little softer still, about a pixel in a thousand.
    alpha = alpha.filter(ImageFilter.GaussianBlur(max(1.0, max(size) / 1000)))
    subject = float((np.asarray(alpha) >= 128).mean())
    # In front: the subject, and whatever isn't sky – but none of the sky
    # itself, however much the model makes of it (a bank of clouds stands
    # out to it as a subject would; a bird in the sky doesn't look like sky).
    above, airy = sky(found, picture)
    if above is not None:
        ground = soften(np, Image, ImageFilter, 1 - above, size)
        air = soften(np, Image, ImageFilter, airy.astype(np.float32), size)
        subject_alpha = np.asarray(alpha, dtype=np.float32) / 255 * (1 - air)
        both = np.maximum(subject_alpha, ground)
        alpha = Image.fromarray((both * 255).round().astype(np.uint8), 'L')
    picture = picture.resize(size, Image.Resampling.LANCZOS) if size != shown else picture
    picture.putalpha(alpha)
    # The picture's own size, as GNOME places it (see lib/depth.js placement()).
    info = PngImagePlugin.PngInfo()
    info.add_text('atelier-width', str(shown[0]))
    info.add_text('atelier-height', str(shown[1]))
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    partial = f'{target}.partial'
    try:
        picture.save(partial, 'PNG', pnginfo=info)
        os.replace(partial, target)
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    covered = float((np.asarray(alpha) >= 128).mean())
    say({'ok': True, 'width': size[0], 'height': size[1], 'picture': list(shown), 'subject': round(subject, 4),
         'sky': above is not None, 'front': round(covered, 4)})


def main():
    chosen = options(sys.argv[1:])
    found = modules()
    if chosen['check']:
        check(found, chosen.get('model'))
    missing = [PACKAGES[name] for name, module in found.items() if module is None]
    if missing:
        say({'ok': False, 'missing': missing,
             'error': f'missing {", ".join(missing)} (sudo apt install {" ".join(missing)})'}, 3)
    for name in ('model', 'input', 'output', 'width', 'height'):
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
    try:
        cutout(found, chosen['model'], chosen['input'], chosen['output'], width, height)
    except SystemExit:
        raise
    except Exception as e:  # the picture or the model unreadable, the disk full…
        say({'ok': False, 'error': f'{type(e).__name__}: {e}'}, 4)


if __name__ == '__main__':
    main()
