"""Relo for Windows' sound set: the Mac's cues (apps/notch/boringNotch/Resources/Sounds/*.caf, written by render.sh)
copied sample for sample into 16-bit PCM WAV (apps/windows/public/sounds/<cue>.wav). Lossless: the CAFs are
LEI16 @ 48 kHz, so the WAV carries exactly the same samples, and WebView2 decodes WAV everywhere.
Usage: python scripts/sounds/to_wav.py   (needs soundfile + numpy; run after render.sh)"""
import pathlib

import numpy as np
import soundfile as sf

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "apps/notch/boringNotch/Resources/Sounds"
DST = ROOT / "apps/windows/public/sounds"
DST.mkdir(parents=True, exist_ok=True)
for caf in sorted(SRC.glob("*.caf")):
    data, rate = sf.read(caf, dtype="int16", always_2d=True)
    out = DST / f"{caf.stem}.wav"
    sf.write(out, data, rate, subtype="PCM_16", format="WAV")
    back, rate2 = sf.read(out, dtype="int16", always_2d=True)
    assert rate == rate2 and np.array_equal(data, back), caf.name
    print(f"{caf.stem}: {len(data) / rate:.3f}s {rate} Hz ch={data.shape[1]} peak={np.abs(data).max() / 32768:.3f} {out.stat().st_size} B")
