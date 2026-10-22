"""Relo's sound studio: many lowkey variants for every moment, built to the sound language (docs/SOUND.md).

    marketing/films/.venv/bin/python scripts/sounds/studio.py <out-dir>

Writes <out-dir>/<code>.wav and <out-dir>/library.json (the audit and the Sound Bench read both). Codes are SLOT-NN
(TAB-04); a pair's sides are SLOT-NN.<side> (NCH-03.open). Every variant is one voice x one motif x one register, all
from E major pentatonic, all in the same small room, mastered and loudness-set by tier. Nothing here ships until the
owner approves it on the bench.
"""
import itertools
import json
import os
import sys

import numpy as np
import pyloudnorm as pyln
import soundfile as sf

from dsp import (SR, fade_out, master, mix, room, transpose, v_felt, v_glass_free_pad, v_keys, v_pop, v_sine, v_sub,
                 v_tap)

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

# ---------- the language (one place; the doc explains each) ----------
SCALE = {"E", "F#", "G#", "B", "C#"}
REF = -28.0  # notification loudness (LUFS over the sounding part); every tier is relative to it
TIER = {"micro": REF - 11, "transition": REF - 7, "status": REF - 4, "notification": REF, "interruptive": REF + 2.5, "hero": REF + 1}
CAP = {"micro": 0.15, "transition": 0.30, "status": 0.45, "notification": 0.95, "interruptive": 1.1, "hero": 4.5}
ROOM = {"micro": (0.15, 0.10), "transition": (0.22, 0.16), "status": (0.25, 0.18), "notification": (0.3, 0.2),
        "interruptive": (0.3, 0.2), "hero": (2.2, 0.45)}  # (RT60 s, wet)


def voice(name, note, length=0.25, soft=1.0):
    """Every voice at one note; length scales its decay. soft > 1 rounds the onset further."""
    if name == "sine":
        return v_sine(note, length + 0.1, 0.006 * soft, length * 0.35)
    if name == "felt":
        return v_felt(note, length + 0.08, 0.004 * soft, length * 0.25)
    if name == "keys":
        return v_keys(note, length + 0.15, length * 0.45, index=0.6)
    if name == "pad":
        return v_glass_free_pad([note, transpose(note, 7)], length + 0.1, 0.022 * soft, length * 0.35, cut=1300)
    if name == "pop":
        return v_pop(note, "round")
    if name == "press":
        return v_pop(note, "deep")
    if name == "tap":
        return v_tap(note)
    raise ValueError(name)


VOICES = ["sine", "felt", "keys", "pad", "pop", "press", "tap"]
VOICE_NAME = {"sine": "Halo", "felt": "Felt", "keys": "Keys", "pad": "Pad", "pop": "Round", "press": "Press", "tap": "Touch"}


def phrase(v, notes, gap, gains=None, length=0.25, pans=None):
    gains = gains or [1.0] * len(notes)
    pans = pans or [0.0] * len(notes)
    return mix(*[(voice(v, n, length), i * gap, g, p) for i, (n, g, p) in enumerate(zip(notes, gains, pans))])


# ---------- motifs: the grammar, per slot (notes, gap s, gains) ----------
def up(a, b, gap):
    return ([a, b], gap, [0.8, 1.0])


def down(a, b, gap):
    return ([b, a], gap, [1.0, 0.75])


MIRROR_PAIRS = [("B3", "E4"), ("G#3", "C#4"), ("E3", "B3"), ("E4", "G#4"), ("C#4", "F#4")]
SLOTS = {
    # slot: (category, kind, motifs) kind: single | pair(sideA, sideB)
    "TAB": ("micro", "single", [([n], 0, [1.0]) for n in ("E4", "B3", "G#4", "C#4")]),
    "SEC": ("micro", "single", [([n], 0, [0.8]) for n in ("F#4", "B3", "E4")]),
    "TGL": ("micro", ("on", "off"), [(up(a, b, 0.03), down(a, b, 0.03)) for a, b in MIRROR_PAIRS[:3]]),
    "NCH": ("transition", ("open", "close"), [(up(a, b, 0.06), down(a, b, 0.06)) for a, b in MIRROR_PAIRS]),
    "CRD": ("transition", ("expand", "collapse"), [(up(a, b, 0.035), down(a, b, 0.035)) for a, b in MIRROR_PAIRS[:4]]),
    "WIN": ("transition", ("winopen", "winclose"), [(up(a, b, 0.07), down(a, b, 0.07)) for a, b in MIRROR_PAIRS]),
    "STR": ("status", "single", [(["E4", "B4"], 0.08, [0.8, 1.0]), (["B3", "E4"], 0.08, [0.8, 1.0]), (["G#4", "C#5"], 0.07, [0.8, 1.0])]),
    "UPD": ("status", "single", [([n], 0, [0.7]) for n in ("B4", "G#4", "E4")]),
    "ACK": ("status", "single", [(["E4"], 0, [0.9]), (["B4"], 0, [0.9]), (["E4", "E4"], 0.05, [0.7, 0.5])]),
    "DON": ("notification", "single", [(["E4", "G#4", "B4"], 0.075, [0.75, 0.85, 1.0]), (["B3", "E4", "G#4"], 0.08, [0.75, 0.85, 1.0]),
                                       (["E4", "B4"], 0.1, [0.85, 1.0]), (["C#4", "E4", "B4"], 0.08, [0.75, 0.85, 1.0])]),
    "ERR": ("notification", "single", [(["B3", "G#3"], 0.12, [1.0, 0.85]), (["G#3", "E3"], 0.12, [1.0, 0.85]),
                                       (["E4", "C#4"], 0.12, [1.0, 0.85]), (["B3", "F#3"], 0.13, [1.0, 0.85])]),
    "TRN": ("notification", "single", [(["G#4", "G#4"], 0.14, [0.9, 0.9]), (["E4", "E4"], 0.14, [0.9, 0.9]), (["B4", "B4"], 0.12, [0.9, 0.85])]),
    "LNK": ("notification", "single", [(["E4", "B4", "E5"], 0.11, [0.8, 0.85, 1.0]), (["B3", "F#4", "B4"], 0.11, [0.8, 0.85, 1.0]),
                                       (["E4", "G#4", "C#5"], 0.1, [0.8, 0.85, 1.0])]),
    "ASK": ("interruptive", "single", [(["E5", "B4", "E5"], 0.11, [0.95, 0.8, 1.0]), (["B4", "E5", "B4", "E5"], 0.09, [0.85, 0.95, 0.8, 1.0]),
                                       (["C#5", "G#4", "C#5"], 0.11, [0.95, 0.8, 1.0])]),
}


def render(category, motif, v):
    notes, gap, gains = motif
    length = {"micro": 0.09, "transition": 0.15, "status": 0.2, "notification": 0.3, "interruptive": 0.28}[category]
    pans = [(-0.15 if i % 2 == 0 else 0.15) * (len(notes) > 1) for i in range(len(notes))]
    a = phrase(v, notes, gap, gains, length, pans)
    rt, wet = ROOM[category]
    return room(a, rt, wet, dark=2600)


# ---------- heroes: launch and quit, composed (pads, an arpeggio, the sub), the inverted pair ----------
def hero(style, reverse=False, long=True):
    chord = ["E3", "B3", "E4", "G#4", "B4"] if style != "sus" else ["E3", "B3", "F#4", "B4", "E5"]
    if style == "bloom":
        a = mix((v_glass_free_pad(chord[:3], 1.6, 0.25 if not reverse else 0.01, 0.6, cut=1400), 0, 1.0),
                (v_sub("E2", 1.6, 0.2, 0.7), 0, 0.5))
    elif style == "arp":
        notes = chord[::-1] if reverse else chord
        a = mix(*[(v_keys(n, 1.1, 0.5, 0.6), i * 0.09, 0.8) for i, n in enumerate(notes)],
                (v_glass_free_pad(chord[:2], 1.3, 0.08, 0.6, cut=900), 0.05, 0.5))
    elif style == "halo":
        notes = chord[::-1] if reverse else chord
        a = mix(*[(v_sine(n, 1.2, 0.02, 0.5), i * 0.11, 0.75) for i, n in enumerate(notes)], (v_sub("E2", 1.4, 0.1, 0.6), 0, 0.4))
    else:  # sus: a dark open chord, one swell
        a = mix((v_glass_free_pad(chord, 1.8, 0.35 if not reverse else 0.01, 0.7, cut=1200, spread=0.14), 0, 1.0),
                (v_sub("E2", 1.8, 0.3, 0.8), 0, 0.45))
    if reverse and style in ("bloom", "sus"):
        # Quitting: the chord closes, a short downward bend in level and brightness.
        a = a * np.linspace(1, 0.2, len(a))[:, None]
    rt, wet = ROOM["hero"]
    if not long:  # the research's short hero: 1.5 s, a smaller hall
        a = a[: int(1.1 * SR)] * np.linspace(1, 0.6, int(1.1 * SR))[: len(a), None]
        rt, wet = 0.9, 0.35
    return room(a, rt * (0.5 if reverse else 1.0), wet)


# ---------- level, measure, write ----------
LIB = []


def active_lufs(a):
    e = np.abs(a).max(1)
    live = e > e.max() * 0.01
    seg = a[live] if live.sum() > SR * 0.02 else a
    meter = pyln.Meter(SR, block_size=min(0.4, max(0.02, len(seg) / SR * 0.95)))
    return meter.integrated_loudness(seg)


def finish(a, category):
    a = master(a, hp=110 if category in ("micro", "transition", "status") else 70)
    e = np.abs(a).max(1)
    last = np.nonzero(e > e.max() * 1e-3)[0][-1]
    capped = last + int(0.01 * SR) > int(CAP[category] * SR)
    a = a[: min(len(a), last + int(0.01 * SR), int(CAP[category] * SR))]
    # A tail the cap cuts fades over the last third (never a cliff); a natural end needs only a short fade.
    a = fade_out(a, (len(a) / SR * 1000 / 3) if capped else (25 if category != "hero" else 400))
    first = np.nonzero(np.abs(a).max(1) > 1e-4)[0][0]
    a = a[first:]  # no leading silence
    a = a * 10 ** ((TIER[category] - active_lufs(a)) / 20)
    peak = np.abs(a).max()
    ceiling = 10 ** (-3 / 20)
    return a * min(1, ceiling / peak)


def write(code, name, moment, slot, category, desc, a, pair=None):
    a = finish(a, category)
    sf.write(os.path.join(OUT, code + ".wav"), a.astype(np.float32), SR, subtype="PCM_24")
    LIB.append(dict(code=code, name=name, moment=moment, slot=slot, category=category, desc=desc, kit="Studio",
                    dur=round(len(a) / SR, 3), lufs=TIER[category], **({"pair": pair} if pair else {})))


MOMENT = {"TAB": "tab", "SEC": "section", "STR": "start", "UPD": "update", "ACK": "sent", "DON": "done", "ERR": "failed",
          "TRN": "turn", "LNK": "linked", "ASK": "ask"}
INTERVAL = {("B3", "E4"): "fourth", ("G#3", "C#4"): "low fourth", ("E3", "B3"): "low fifth", ("E4", "G#4"): "third",
            ("C#4", "F#4"): "fourth on C#"}

for slot, (category, kind, motifs) in SLOTS.items():
    n = 0
    for (mi, motif), v in itertools.product(enumerate(motifs), VOICES):
        # Pads are too big for micro sounds; pops and taps carry no melody worth three notes.
        if v == "pad" and category == "micro":
            continue
        if v in ("pop", "press", "tap") and kind == "single" and len(motif[0]) > 2:
            continue
        n += 1
        code = f"{slot}-{n:02d}"
        if kind == "single":
            notes = motif[0]
            assert all(x[:-1] in SCALE for x in notes)
            shape = " ".join(x[:-1] for x in notes)
            write(code, f"{VOICE_NAME[v]} · {shape}", MOMENT[slot], MOMENT[slot], category,
                  f"{VOICE_NAME[v]} voice, {shape} in {'a small room' if category != 'micro' else 'a whisper of room'}",
                  render(category, motif, v))
        else:
            a_side, b_side = kind
            (up_m, down_m) = motif
            label = INTERVAL.get(tuple(up_m[0]), " ".join(x[:-1] for x in up_m[0]))
            for side, m in ((a_side, up_m), (b_side, down_m)):
                write(f"{code}.{side}", f"{VOICE_NAME[v]} · {label}", side, slot.lower(), category,
                      f"{VOICE_NAME[v]} voice, a {label} rising to {a_side.replace('win', '')}, falling to {b_side.replace('win', '')}",
                      render(category, m, v), pair=code)

i = 0
for long in (True, False):
    for style in ["bloom", "arp", "halo", "sus"]:
        i += 1
        label = {"bloom": "Bloom", "arp": "Arpeggio", "halo": "Halo", "sus": "Open fifth"}[style] + ("" if long else " short")
        hall = "a deep, soft hall" if long else "a short room (1.5 s, the research's hero length)"
        write(f"LCH-{i:02d}", label, "launch", "launch", "hero", f"{label}: the chord opening in {hall}", hero(style, long=long))
        write(f"QUT-{i:02d}", label, "quit", "quit", "hero", f"{label}, inverted: the chord closing in {hall}", hero(style, reverse=True, long=long))

json.dump(LIB, open(os.path.join(OUT, "library.json"), "w"), indent=1)
print(f"{len(LIB)} files, {len({c.get('pair') or c['code'] for c in LIB})} variants -> {OUT}")
