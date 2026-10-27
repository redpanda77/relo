#!/usr/bin/env python3
"""Compares Relo for Mac's effects drawn by the SwiftUI Canvas (the reference) and by the Metal renderer.

Runs a Debug build's snapshot bench twice, `--relo-bench` and `--relo-bench --relo-bench-metal`, with labels left out
(`--relo-bench-nolabels`: text is rasterised by SwiftUI in both, so only shapes are compared), and prints per scene the
mean difference per channel and, per pixel, the worst and the 99.9th percentile (0…255), which leaves out single
antialiased edge pixels where CoreGraphics and a signed distance disagree by design. Fails when a scene's mean passes 0.5 or its 99.9th percentile 32.

  scripts/notch-bench-parity.py [--app path/to/Relo.app] [--keep dir] [--only prefix]
"""
import argparse
import base64
import collections
import glob
import io
import os
import subprocess
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(ROOT, "packages/contracts/fixtures/owner-state-v1.json")
MEAN_GATE, P999_GATE = 0.5, 32


def bench(binary, extra):
    with open(FIXTURE, "rb") as fixture:
        out = subprocess.run([binary, "--relo-snapshot", "--relo-bench", "--relo-bench-nolabels", *extra], stdin=fixture,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=900).stdout
    frames = {}
    for line in out.splitlines():
        parts = line.split(b" ", 2)
        if len(parts) == 3 and parts[0] == b"relo-bench":
            frames[parts[1].decode()] = parts[2]
    return frames


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default=None)
    parser.add_argument("--keep", default=None, help="write both renders' PNGs here")
    parser.add_argument("--only", default="", help="compare only frames whose name starts with this")
    args = parser.parse_args()
    app = args.app or next(iter(sorted(glob.glob(os.path.expanduser(
        "~/Library/Developer/Xcode/DerivedData/boringNotch-*/Build/Products/Debug/Relo.app")))), None)
    if not app:
        sys.exit("no Debug build of Relo for Mac (scripts/notch-dev.sh --no-open)")
    binary = os.path.join(app, "Contents/MacOS/Relo")
    canvas, metal = bench(binary, []), bench(binary, ["--relo-bench-metal"])
    groups = collections.defaultdict(lambda: {"n": 0, "mean": 0.0, "max": 0, "p999": 0.0, "worst": ""})
    for name in sorted(canvas):
        if not name.startswith(args.only) or name not in metal:
            continue
        a = Image.open(io.BytesIO(base64.b64decode(canvas[name]))).convert("RGBA")
        b = Image.open(io.BytesIO(base64.b64decode(metal[name]))).convert("RGBA")
        if args.keep:
            for kind, image in (("canvas", a), ("metal", b)):
                os.makedirs(os.path.join(args.keep, kind), exist_ok=True)
                image.save(os.path.join(args.keep, kind, name + ".png"))
        channels = np.abs(np.asarray(a, dtype=np.int16) - np.asarray(b, dtype=np.int16))[..., :3]
        d = channels.max(axis=2)
        g = groups[name.rsplit("-", 1)[0]]
        g["n"] += 1
        g["mean"] += float(channels.mean())
        g["p999"] = max(g["p999"], float(np.percentile(d, 99.9)))
        if int(d.max()) > g["max"]:
            g["max"], g["worst"] = int(d.max()), name
    failed = False
    for key, g in sorted(groups.items()):
        mean = g["mean"] / max(1, g["n"])
        bad = mean > MEAN_GATE or g["p999"] > P999_GATE
        failed |= bad
        print(f"{'FAIL' if bad else 'ok  '} {key:14s} frames={g['n']:4d} mean={mean:.3f} p99.9={g['p999']:5.1f} "
              f"max={g['max']:3d} worst={g['worst']}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
