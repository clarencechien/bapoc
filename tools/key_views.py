"""Cut the flat studio-grey background out of Gemini mockups so TRELLIS.2 gets RGBA inputs with a clean alpha.

Background = pixels close to the border colour that are connected to the border; holes filled, specks dropped
(largest piece kept), 1-pixel feather. From yukimura tools/multiview/key_views.py.

  python tools/key_views.py assets/mockups/tower-south.png ... --out assets/inputs
"""
from pathlib import Path
import argparse
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

def key(path, tol=14):
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(np.int16)
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, 0)
    near = np.abs(rgb - bg).max(2) <= tol
    lab, _ = ndimage.label(near)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    background = np.isin(lab, edge[edge > 0])
    fg = ndimage.binary_fill_holes(ndimage.binary_opening(~background, iterations=2))
    keep, n = ndimage.label(fg)
    if n > 1: fg = keep == (np.argmax(ndimage.sum(fg, keep, range(1, n + 1))) + 1)
    alpha = Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1))
    out = Image.fromarray(rgb.astype(np.uint8)); out.putalpha(alpha)
    return out, bg

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('images', nargs='+'); p.add_argument('--out', default='assets/inputs')
    p.add_argument('--tol', type=int, default=14)
    p.add_argument('--cut-below', type=int, help='Clear alpha from this row down (e.g. a drawn ground line)')
    a = p.parse_args()
    Path(a.out).mkdir(parents=True, exist_ok=True)
    for src in a.images:
        im, bg = key(src, a.tol)
        if a.cut_below:
            al = np.asarray(im)[:, :, 3].copy(); al[a.cut_below:] = 0; im.putalpha(Image.fromarray(al))
        dest = Path(a.out, Path(src).name); im.save(dest)
        ys, xs = np.nonzero(np.asarray(im)[:, :, 3] > 128)
        print(dest, 'bg', bg.tolist(), 'bbox', xs.min(), ys.min(), xs.max(), ys.max())
