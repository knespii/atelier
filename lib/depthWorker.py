#!/usr/bin/env python3
# The cutout of a wallpaper for the lock screen's depth effect (lib/depth.js):
# the subject in front of it – what u2netp, a small model rembg uses, finds
# salient – with the rest made see-through, softly at the edges. The shell
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
    say({'ok': True, 'width': size[0], 'height': size[1], 'picture': list(shown), 'subject': round(covered, 4)})


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
