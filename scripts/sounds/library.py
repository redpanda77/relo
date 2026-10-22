"""Relo's sound library: candidate cues for the notch, composed from earshot's bank (no bells), to audition and pick from.

Five kits (timbre) x twelve moments (meaning). Every kit speaks the same grammar, so any cue can be swapped for
another kit's without relearning: rising = opening or good, falling = closing or bad, two equal hits = your turn,
three = needs you. Codes are MOMENT-KIT, e.g. ASK-P is "needs you" in the Pulse kit.

    marketing/films/.venv/bin/python scripts/sounds/library.py <out-dir>
writes <out-dir>/<code>.wav (48 kHz, 24-bit, loudness-matched per tier) and <out-dir>/library.json.
"""
import json
import os
import sys

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from earshot.forge import bank
from scipy.signal import butter, sosfilt

SR = 48000
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

# ---------- primitives ----------
_cache = {}


NOTES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def hz(note):
    return 440.0 * 2 ** ((NOTES[note[:-1]] + 12 * (int(note[-1]) + 1) - 69) / 12)


def S(sound_id, **kw):
    """One earshot bank render as stereo float64, cached by its arguments. A pitch above the recipe's range is
    rendered octaves lower and played back faster (shorter and brighter, which suits a blip)."""
    key = (sound_id, tuple(sorted(kw.items())))
    if key not in _cache:
        if isinstance(kw.get("pitch"), str):
            kw["pitch"] = hz(kw["pitch"])
        speed = 1
        while True:
            try:
                audio, _ = bank.render(sound_id, checks=False, **kw)
                break
            except Exception as e:  # earshot's KnobError: outside the recipe's pitch range
                if "pitch" not in kw or "range" not in str(e) or speed > 4:
                    raise
                kw["pitch"] /= 2
                speed *= 2
        audio = np.asarray(audio, np.float64)
        if speed > 1:
            audio = filt(audio, "low", SR / 2 / speed * 0.9, order=6)[::speed]
        _cache[key] = audio
    return _cache[key].copy()


def mix(*parts, tail=0.05):
    """parts: (audio, at_seconds, gain[, pan]). Returns one stereo buffer."""
    end = max(int(at * SR) + len(a) for a, at, *_ in parts) + int(tail * SR)
    out = np.zeros((end, 2))
    for a, at, gain, *rest in parts:
        pan = rest[0] if rest else 0.0
        a = a * gain * np.array([np.sqrt(1 - pan), np.sqrt(1 + pan)]) / np.sqrt(1 + abs(pan) * 0)
        i = int(at * SR)
        out[i : i + len(a)] += a
    return out


def filt(a, kind, hz, order=2):
    return sosfilt(butter(order, hz, kind, fs=SR, output="sos"), a, axis=0)


def echo(a, delay=0.075, fb=0.32, n=3, cut=5000):
    """Ping-pong taps, each darker: the 'glass room' that makes a click read as a screen, not a desk."""
    out = np.zeros((len(a) + int(delay * SR * n) + 1, 2))
    out[: len(a)] += a
    tap = a
    for k in range(1, n + 1):
        tap = filt(tap, "low", cut) * fb
        i = int(delay * SR * k)
        side = tap[:, ::-1] if k % 2 else tap
        out[i : i + len(tap)] += side
    return out


def crush(a, bits=6, hold=3):
    """Bit and sample-rate reduction for the Data kit."""
    q = 2 ** (bits - 1)
    a = np.round(a * q) / q
    return np.repeat(a[::hold], hold, axis=0)[: len(a)]


def sine(f0, f1, dur, attack=0.004, decay=0.06, fm=0.0):
    """A clean glide, Pulse kit's 'chirp' (earshot's pops carry the body; this only adds the sweep)."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f0 * (f1 / f0) ** (t / dur)
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph + fm * np.sin(ph * 2)) * np.minimum(t / attack, 1) * np.exp(-t / decay)
    return np.stack([x, x], 1) * 0.6


# ---------- the kits ----------
# Pitches sit in E major pentatonic around E6 so every kit is in one key with the others and with the voice.
LIB = []


def cue(code, name, moment, kit, desc, audio):
    LIB.append(dict(code=code, name=name, moment=moment, kit=kit, desc=desc, audio=audio))


# P: Pulse. Clean sine blips and glides; the most "UI" of the five.
def pop(p, kind="bloop", **kw):
    return S(f"pro_pop/{kind}", pitch=p, **kw)


cue("OPN-P", "Lift", "open", "Pulse", "two blips a fourth apart, upward",
    mix((pop("B5", "boop"), 0, 0.7), (pop("E6", "boop"), 0.055, 0.9)))
cue("CLS-P", "Settle", "close", "Pulse", "the same two blips, downward",
    mix((pop("E6", "boop"), 0, 0.8), (pop("B5", "boop"), 0.055, 0.7)))
cue("EXP-P", "Unfold", "expand", "Pulse", "one rising chirp",
    mix((sine(1320, 1980, 0.09, decay=0.04), 0, 0.6), (pop("B6", "tink"), 0.05, 0.5)))
cue("COL-P", "Fold", "collapse", "Pulse", "one falling chirp",
    mix((sine(1980, 1320, 0.09, decay=0.04), 0, 0.6), (pop("E6", "tink"), 0.05, 0.4)))
cue("STR-P", "Ignite", "start", "Pulse", "three quick blips climbing E-G#-B",
    mix((pop("E6"), 0, 0.6), (pop("G#6"), 0.06, 0.7), (pop("B6"), 0.12, 0.85)))
cue("UPD-P", "Blink", "update", "Pulse", "a single faint high blip",
    mix((pop("B6", "tink"), 0, 0.6)))
cue("DON-P", "Resolve", "done", "Pulse", "a fifth up, landing on the root an octave higher",
    mix((pop("B5"), 0, 0.7), (pop("E6"), 0.09, 0.8), (pop("E7", "tink"), 0.18, 0.55), tail=0.25))
cue("ERR-P", "Drop", "failed", "Pulse", "two low blips falling a tritone, dry",
    mix((pop("A#4", "thup"), 0, 0.9), (pop("E4", "thup"), 0.12, 1.0)))
cue("ASK-P", "Ping", "ask", "Pulse", "the signature: three blips, high-low-high, in a small room",
    echo(mix((pop("B6"), 0, 0.9), (pop("E6"), 0.085, 0.8), (pop("B6"), 0.17, 0.9)), delay=0.11, fb=0.25, n=2))
cue("TRN-P", "Nudge", "turn", "Pulse", "two equal soft blips, a knock",
    mix((pop("G#5", "boop"), 0, 0.8), (pop("G#5", "boop"), 0.13, 0.8)))
cue("ACK-P", "Tick", "sent", "Pulse", "one short confirm blip",
    mix((pop("E7", "tink"), 0, 0.7)))
cue("LNK-P", "Handshake", "linked", "Pulse", "a call and an answer, then one high confirm",
    echo(mix((pop("E6"), 0, 0.7), (pop("B6"), 0.1, 0.7), (pop("E6"), 0.3, 0.6, -0.4), (pop("B6"), 0.4, 0.6, 0.4),
             (pop("E7", "tink"), 0.55, 0.5)), delay=0.12, fb=0.3, n=3))


# G: Glass. Crisp high transients with a short ping-pong room; precise, premium, quiet.
cue("OPN-G", "Pane", "open", "Glass", "glass tick then a lighter one, opening out in stereo",
    echo(mix((S("pro_hover_tick/glass"), 0, 0.8, -0.3), (S("pro_click/glass"), 0.045, 0.6, 0.3)), n=2))
cue("CLS-G", "Seal", "close", "Glass", "a glass tap, darker, centred",
    filt(mix((S("pro_tap/glass"), 0, 0.9), (S("pro_hover_tick/soft"), 0.03, 0.4)), "low", 6000))
cue("EXP-G", "Facet", "expand", "Glass", "a single glass key with its reflection",
    echo(mix((S("pro_typing_key/glass"), 0, 0.8)), delay=0.05, n=2))
cue("COL-G", "Bevel", "collapse", "Glass", "a soft glass tick, no reflection",
    mix((S("pro_hover_tick/soft"), 0, 0.8), (S("pro_tap/glass"), 0.02, 0.4)))
cue("STR-G", "Prism", "start", "Glass", "three glass ticks spreading left to right",
    echo(mix((S("pro_click/glass"), 0, 0.6, -0.6), (S("pro_hover_tick/glass"), 0.05, 0.7, 0),
             (S("pro_hover_tick/ping"), 0.1, 0.8, 0.6)), n=2))
cue("UPD-G", "Glint", "update", "Glass", "one tiny glass ping",
    mix((S("pro_hover_tick/ping"), 0, 0.6)))
cue("DON-G", "Clear", "done", "Glass", "a glass tap, then a bright ping that rings in the room",
    echo(mix((S("pro_tap/glass"), 0, 0.8), (S("pro_hover_tick/ping"), 0.08, 0.8), (pop("E7", "tink"), 0.08, 0.35)),
         delay=0.09, fb=0.35, n=4))
cue("ERR-G", "Crack", "failed", "Glass", "a glass knock and a dull low tap, no ring",
    mix((S("pro_tap/knock"), 0, 0.9), (filt(S("pro_tap/glass", pitch="D2"), "low", 2500), 0.09, 1.0)))
cue("ASK-G", "Signal", "ask", "Glass", "three bright glass pings, high-low-high, ringing",
    echo(mix((S("pro_hover_tick/ping"), 0, 0.9), (pop("B6", "tink"), 0, 0.4), (S("pro_click/glass"), 0.09, 0.8),
             (pop("E6", "tink"), 0.09, 0.4), (S("pro_hover_tick/ping"), 0.18, 0.9), (pop("B6", "tink"), 0.18, 0.45)),
         delay=0.1, fb=0.32, n=4))
cue("TRN-G", "Tap tap", "turn", "Glass", "two glass taps, a polite knock on the screen",
    echo(mix((S("pro_tap/glass"), 0, 0.8), (S("pro_tap/glass"), 0.14, 0.75)), delay=0.06, fb=0.2, n=1))
cue("ACK-G", "Check", "sent", "Glass", "one glass click",
    mix((S("pro_click/glass"), 0, 0.8)))
cue("LNK-G", "Lattice", "linked", "Glass", "glass ticks cascading into a long shimmer",
    echo(mix(*[(S("pro_hover_tick/glass"), 0.05 * k, 0.5 + 0.08 * k, -0.6 + 0.24 * k) for k in range(6)],
             (S("pro_shimmer/m3", dur=1.0), 0.25, 0.35)), delay=0.09, fb=0.3, n=3))


# S: Servo. Switches, latches and zips: physical, haptic, like hardware docking.
cue("OPN-S", "Deploy", "open", "Servo", "a short zip up into a latch",
    mix((S("pro_zip/up", dur=0.16), 0, 0.5), (S("toggle/on"), 0.11, 0.8)))
cue("CLS-S", "Stow", "close", "Servo", "a short zip down into a soft latch",
    mix((S("pro_zip/down", dur=0.16), 0, 0.5), (S("toggle/off"), 0.11, 0.8)))
cue("EXP-S", "Detent", "expand", "Servo", "a rocker switch, one notch",
    mix((S("toggle/rocker"), 0, 0.8)))
cue("COL-S", "Release", "collapse", "Servo", "a micro toggle",
    mix((S("toggle/micro"), 0, 0.8)))
cue("STR-S", "Engage", "start", "Servo", "a switch flip and a latch, then a servo whir upward",
    mix((S("fit/snap/switch_flip"), 0, 0.8), (S("toggle/latch"), 0.08, 0.6), (S("pro_zip/up_hi", dur=0.22), 0.14, 0.3)))
cue("UPD-S", "Step", "update", "Servo", "one dry detent tick",
    mix((S("hover_tick/detent"), 0, 0.6)))
cue("DON-S", "Lock", "done", "Servo", "two latches closing, the second firmer, a confirming thump",
    mix((S("toggle/on"), 0, 0.7), (S("toggle/latch"), 0.1, 0.9), (S("pro_pop_in/round"), 0.1, 0.6)))
cue("ERR-S", "Jam", "failed", "Servo", "a switch that catches: rocker, stutter, low knock",
    mix((S("toggle/rocker"), 0, 0.8), (S("toggle/micro"), 0.05, 0.6), (S("pro_pop_in/deep"), 0.12, 1.0)))
cue("ASK-S", "Actuate", "ask", "Servo", "three crisp actuations rising in pitch, with a zip",
    mix((S("toggle/on", ), 0, 0.8), (S("fit/snap/switch_flip"), 0.1, 0.8), (S("toggle/latch"), 0.2, 0.9),
        (S("pro_zip/up_hi", dur=0.2), 0.18, 0.35)))
cue("TRN-S", "Knock", "turn", "Servo", "two firm mechanical knocks",
    mix((S("pro_pop_in/knock"), 0, 0.9), (S("pro_pop_in/knock"), 0.15, 0.85)))
cue("ACK-S", "Clack", "sent", "Servo", "one keyboard thock",
    mix((S("fit/key/thock", dur=0.2), 0, 0.8)))
cue("LNK-S", "Dock", "linked", "Servo", "zip in, two latches, a seated thump and air",
    mix((S("pro_zip/down_warm"), 0, 0.5), (S("toggle/on"), 0.3, 0.8), (S("toggle/latch"), 0.38, 0.9),
        (S("pro_pop_in/round"), 0.38, 0.7), (S("pro_whoosh_big/tonal", dur=0.6), 0.32, 0.2)))


# D: Data. Bit-crushed blips, typing bursts and glitch: a terminal talking.
def bits(a, **kw):
    return crush(a, **kw)


cue("OPN-D", "Boot", "open", "Data", "a two-blip handshake, crushed",
    bits(mix((S("pro_typing_key/blip"), 0, 0.8), (pop("B6", "boop"), 0.04, 0.6))))
cue("CLS-D", "Halt", "close", "Data", "a crushed blip falling",
    bits(mix((pop("B6", "boop"), 0, 0.6), (pop("E6", "boop"), 0.04, 0.6))))
cue("EXP-D", "Fetch", "expand", "Data", "a tiny typing burst",
    mix((S("pro_typing_run/tick", dur=0.14), 0, 0.6)))
cue("COL-D", "Flush", "collapse", "Data", "one crushed key",
    bits(mix((S("pro_typing_key/crackle"), 0, 0.7)), bits=5))
cue("STR-D", "Exec", "start", "Data", "a burst of rising data blips",
    mix((S("pro_riser/nblips_hi", dur=0.35), 0, 0.6), (S("pro_typing_key/blip"), 0.33, 0.8)))
cue("UPD-D", "Packet", "update", "Data", "a single packet blip",
    bits(mix((S("pro_typing_key/blip"), 0, 0.6)), bits=7))
cue("DON-D", "Exit 0", "done", "Data", "keys, then two clean blips up a fifth",
    mix((S("pro_typing_run/tick", dur=0.12), 0, 0.4), (pop("B6"), 0.12, 0.7), (pop("E7", "tink"), 0.2, 0.7), tail=0.15))
cue("ERR-D", "Corrupt", "failed", "Data", "a short glitch stutter into a low crushed blip",
    mix((S("pro_glitch/sparse", dur=0.22), 0, 0.5), (bits(pop("E4", "thup"), bits=4, hold=6), 0.2, 1.0)))
cue("ASK-D", "Interrupt", "ask", "Data", "three crushed blips high-low-high, a modem's question",
    bits(mix((pop("B6"), 0, 0.9), (pop("E6"), 0.08, 0.8), (pop("B6"), 0.16, 0.9),
             ), bits=6, hold=2))
cue("TRN-D", "Prompt", "turn", "Data", "a cursor blinking twice",
    bits(mix((pop("G#6", "tink"), 0, 0.7), (pop("G#6", "tink"), 0.16, 0.7)), bits=6, hold=2))
cue("ACK-D", "Enter", "sent", "Data", "one return key",
    mix((S("pro_typing_key/tick"), 0, 0.8)))
cue("LNK-D", "Sync", "linked", "Data", "two streams of blips meeting, resolving up",
    mix((S("pro_riser/nblips", dur=0.5), 0, 0.4, -0.6), (S("pro_riser/nblips_hi", dur=0.5), 0.05, 0.4, 0.6),
        (pop("E6"), 0.55, 0.7), (pop("B6"), 0.63, 0.7), (pop("E7", "tink"), 0.71, 0.6)))


# F: Flux. Air, sweeps and sub: cinematic tech, the softest edges, felt more than heard.
cue("OPN-F", "Inhale", "open", "Flux", "a short airy sweep up",
    filt(S("swish/soft", dur=0.28, apex=0.2), "high", 400))
cue("CLS-F", "Exhale", "close", "Flux", "a short airy sweep down",
    filt(S("whoosh_fast/tight", dur=0.3, apex=0.06), "high", 300))
cue("EXP-F", "Bloom", "expand", "Flux", "a soft pop-in with air",
    mix((S("pro_pop_in/airy"), 0, 0.8), (filt(S("swipe/flick", dur=0.18, apex=0.05), "high", 1500), 0, 0.3)))
cue("COL-F", "Sink", "collapse", "Flux", "a warm zip down",
    mix((S("pro_zip/down_warm", dur=0.25), 0, 0.8)))
cue("STR-F", "Spool", "start", "Flux", "an air-gated riser that lands on a soft pop",
    mix((S("pro_riser/air_gate", dur=0.45), 0, 0.5), (S("pro_pop_in/airy"), 0.42, 0.8)))
cue("UPD-F", "Breath", "update", "Flux", "a faint air tick",
    mix((S("pro_hover_tick/air"), 0, 0.7)))
cue("DON-F", "Arrive", "done", "Flux", "a zap bloom, warm and short",
    S("pro_logo_sting/zap_bloom", dur=0.8))
cue("ERR-F", "Undertow", "failed", "Flux", "a quick sub drop under a dull tap",
    mix((S("pro_sub_drop/quick", dur=0.6), 0, 0.9), (S("pro_tap/soft"), 0, 0.7)))
cue("ASK-F", "Beacon", "ask", "Flux", "a chirp-hum sting: a rising tone with weight under it",
    S("pro_logo_sting/chirp_hum", dur=0.85))
cue("TRN-F", "Pulse", "turn", "Flux", "two air-cushioned pops",
    mix((S("pro_pop_in/round"), 0, 0.8), (S("pro_pop_in/round"), 0.16, 0.75)))
cue("ACK-F", "Puff", "sent", "Flux", "one airy pop",
    mix((S("pro_pop_in/airy"), 0, 0.8)))
# Pairs for the notch and its cards: one choice gives both directions, made of the same material and mirrored.
# Opening rises (the second hit lands a fourth or fifth up, slightly louder: arriving); closing is the same two hits
# falling (the second softer: leaving). Everything sits low, under ~2.5 kHz: a soft press, never a tick.
def pair(code, name, kind, desc, opening, closing):
    first, second = ("open", "close") if kind == "notch" else ("expand", "collapse")
    for side, audio in ((first, opening), (second, closing)):
        cue(f"{code}.{side}", name, side, "Pair", desc, audio)
        LIB[-1]["pair"] = code


def mirrored(hit, low, high, gap, cut):
    """The pair's two sides from one hit: low then high (opening), high then low (closing)."""
    return (filt(mix((hit(low), 0, 0.75), (hit(high), gap, 0.9)), "low", cut),
            filt(mix((hit(high), 0, 0.9), (hit(low), gap, 0.7)), "low", cut))


def seal(note):
    return mix((S("pro_tap/glass", pitch=note), 0, 0.8), (S("pro_pop_in/airy"), 0.004, 0.6))


def hush(note):
    return mix((S("pro_tap/soft", pitch=note), 0, 0.8), (S("pro_pop_in/deep"), 0.004, 0.6))


def roundpop(note):
    return S("pro_pop_in/round", pitch=note)


def cushion(note):
    return mix((S("pro_tap/finger", pitch=note), 0, 0.7), (S("pro_pop_in/knock", pitch=note), 0.006, 0.6))


pair("NCH-A", "Seal", "notch", "a dark glass tap with a warm pop: B to E rising to open, E to B falling to close",
     *mirrored(seal, "B2", "E3", 0.06, 2500))
pair("NCH-B", "Hush", "notch", "a soft finger tap over a deep pop: A to E rising to open, falling to close",
     *mirrored(hush, "A2", "E3", 0.065, 2000))
pair("NCH-C", "Velvet", "notch", "a dark breath of air: swelling into a soft tap to open, a soft tap breathing out to close",
     filt(mix((S("whoosh_fast/tight", dur=0.26, apex=0.2), 0, 0.6), (S("pro_tap/soft", pitch="E3"), 0.2, 0.75)), "low", 1600),
     filt(mix((S("pro_tap/soft", pitch="B2"), 0, 0.75), (S("whoosh_fast/tight", dur=0.26, apex=0.04), 0, 0.6)), "low", 1600))
pair("CRD-A", "Thumb", "card", "a rounded low pop, two quick touches: rising to expand, falling to collapse",
     *mirrored(roundpop, "A2", "E3", 0.035, 1800))
pair("CRD-B", "Press", "card", "one deep pop: a little higher to expand, a little lower to collapse",
     filt(S("pro_pop_in/deep", pitch="E3"), "low", 1500), filt(S("pro_pop_in/deep", pitch="B2"), "low", 1500))
pair("CRD-C", "Cushion", "card", "a finger tap and a knock-pop: rising to expand, falling to collapse",
     *mirrored(cushion, "B2", "E3", 0.03, 2000))


cue("LNK-F", "Orbit", "linked", "Flux", "a reverse bloom swelling into the sweep-hit",
    mix((S("logo_sting/reverse_bloom", dur=1.4), 0, 0.6), (S("pro_logo_sting/sweep_hit", dur=0.9), 0.3, 0.5)))


# ---------- the app launching and quitting: a synth pad in a deep room ----------
# The only cues synthesized here rather than taken from the bank (earshot has no pads); its transients ride on top.
from scipy.signal import fftconvolve, sosfilt_zi  # noqa: E402

rng = np.random.default_rng(11)


def saws(note, n, voices=5, spread=0.14):
    """A supersaw: detuned saws (spread in semitones), each voice its own phase, panned across the field."""
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    for v in range(voices):
        d = spread * (v / (voices - 1) - 0.5) * 2 if voices > 1 else 0
        f = hz(note) * 2 ** (d / 12)
        x = 2 * ((t * f + rng.random()) % 1) - 1
        pan = (v / (voices - 1) - 0.5) * 1.2 if voices > 1 else 0
        out += np.stack([x * np.sqrt((1 - pan) / 2), x * np.sqrt((1 + pan) / 2)], 1)
    return out / voices


def sweep(a, f0, f1, curve=1.0, q=0.9, block=256):
    """A low-pass whose cutoff moves from f0 to f1 (exponential, shaped by curve), block by block with its state kept."""
    n = len(a)
    out = np.empty_like(a)
    zi = None
    for i in range(0, n, block):
        x = (i / max(1, n - 1)) ** curve
        fc = min(f0 * (f1 / f0) ** x, SR * 0.45)
        sos = butter(2, fc, "low", fs=SR, output="sos")
        if zi is None:
            zi = np.stack([sosfilt_zi(sos)] * 2, -1) * 0
        out[i : i + block], zi = sosfilt(sos, a[i : i + block], axis=0, zi=zi)
    return out


def adsr(n, attack, release, curve=2.0):
    t = np.arange(n) / SR
    up = np.minimum(t / attack, 1) ** curve
    down = np.clip((n / SR - t) / release, 0, 1) ** curve
    return (up * down)[:, None]


def room(a, rt60=3.5, pre=0.03, wet=0.45, dark=4500, width=1.0):
    """A deep synthetic hall: decorrelated noise with an exponential decay that also darkens as it falls."""
    n = int(rt60 * 1.2 * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-6.9 * t / rt60)[:, None]
    ir = np.concatenate([filt(ir[: n // 3], "low", dark), filt(ir[n // 3 :], "low", dark * 0.45)])
    ir[:, 1] = ir[:, 0] * (1 - width) + ir[:, 1] * width
    ir = np.concatenate([np.zeros((int(pre * SR), 2)), filt(ir, "high", 180)])
    ir /= np.sqrt((ir ** 2).sum() / 2)
    tail = np.stack([fftconvolve(a[:, c], ir[:, c]) for c in range(2)], 1)
    dry = np.zeros_like(tail)
    dry[: len(a)] = a
    return dry * (1 - wet) + tail * wet * 0.5


def sub(note, n, attack=0.05, release=0.6):
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * hz(note) * t)
    return np.stack([x, x], 1) * adsr(n, attack, release)


def fm(note, dur, index=2.0, ratio=2.0, decay=0.5):
    """A glassy FM pluck (a sine modulated by its octave), for arpeggios: tech, never a bell's inharmonic ring."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(note)
    env_ = np.exp(-t / decay)
    x = np.sin(2 * np.pi * f * t + index * env_ * np.sin(2 * np.pi * f * ratio * t)) * env_ * np.minimum(t / 0.004, 1)
    return np.stack([x, x], 1)


def chord(notes, dur, attack, release, f0, f1, curve=1.0, voices=5, spread=0.14):
    n = int(dur * SR)
    a = sum(saws(nt, n, voices, spread) for nt in notes) / len(notes)
    return sweep(a, f0, f1, curve) * adsr(n, attack, release)


def bend(a, semis):
    """Pitch the buffer down (negative semis) along its length by reading it ever slower: a power-down sag."""
    n = len(a)
    rate = 2 ** (np.linspace(0, semis, n) / 12)
    pos = np.cumsum(rate)
    pos = pos[pos < n - 1]
    i = pos.astype(int)
    fr = (pos - i)[:, None]
    return a[i] * (1 - fr) + a[i + 1] * fr


def drive(a, amount=1.8):
    """Tape-style saturation: thickens the saws with harmonics, the 'expensive' part of a big pad."""
    return np.tanh(a * amount) / np.tanh(amount)


def haas(a, ms=11):
    """Widen: the right channel a few ms late, so the pad fills the room instead of the centre."""
    d = int(ms / 1000 * SR)
    out = a.copy()
    out[d:, 1] = a[:-d, 1]
    return out


def big(notes, dur, attack, release, f0, f1, curve=0.8, spread=0.32):
    """The pad: seven-voice supersaws across octaves, driven, filtered, widened."""
    return haas(drive(chord(notes, dur, attack, release, f0, f1, curve=curve, voices=7, spread=spread), 2.2))


def swell(a, length=0.8, rt60=3.0):
    """Reverse reverb: the sound's own tail played backwards, rising into its hit."""
    tail = room(a[: int(0.35 * SR)], rt60=rt60, wet=1.0)
    r = tail[::-1]
    r = r[-int(length * SR):]
    return r * np.linspace(0, 1, len(r))[:, None] ** 1.5


def shimmer_room(a, rt60=5.0, octave_gain=0.35):
    """A shimmer hall: the room fed with the sound an octave up as well (twice the speed), so the tail glows."""
    up = filt(a, "low", SR / 4, order=6)[::2]
    up = np.concatenate([up, np.zeros((len(a) - len(up), 2))])
    return room(a + up * octave_gain, rt60=rt60, wet=0.6, dark=6000)


def boom(n_at, gain=0.8):
    """A sub hit: earshot's soft sub drop with a felt-more-than-heard sine under it."""
    return mix((S("pro_sub_drop/soft", dur=1.4), 0, gain), (sub("E1", int(1.6 * SR), 0.01, 1.4), 0, gain * 0.6))


WIDE = ["E2", "B2", "E3", "G#3", "B3", "D#4", "F#4", "B4"]
SW = 0.75  # the swell's length: every launch hit lands here

cue("LCH-A", "Ignition", "launch", "Synth", "a reverse swell into a wide driven Emaj9 that opens its filter over a sub boom, 5 s shimmer hall",
    shimmer_room(mix((swell(big(WIDE, 0.4, 0.005, 0.3, 4000, 4000), SW), 0, 0.7),
                     (big(WIDE, 2.4, 0.01, 1.6, 350, 9000, curve=0.5), SW, 1.0),
                     (boom(0), SW, 0.9)), rt60=5.0))
cue("LCH-B", "Horizon", "launch", "Synth", "a slow three-octave bloom with no hit at all, the filter opening like a sunrise, deep hall",
    shimmer_room(mix((big(["E1", "E2", "B2", "E3", "G#3", "B3", "F#4", "E5"], 3.0, 1.1, 1.4, 150, 7000, curve=1.3, spread=0.4), 0, 1.0),
                     (sub("E1", int(3.0 * SR), 1.0, 1.4), 0, 0.5)), rt60=5.5, octave_gain=0.45))
cue("LCH-C", "Monolith", "launch", "Synth", "a dark sus2 chord slammed in by a sub impact, then a slow octave shimmer rising out of it",
    shimmer_room(mix((swell(big(["E2", "B2", "F#3", "B3", "E4"], 0.4, 0.005, 0.3, 2500, 2500), SW, rt60=4.0), 0, 0.6),
                     (big(["E2", "B2", "F#3", "B3", "E4"], 2.2, 0.01, 1.6, 1800, 600, curve=0.6, spread=0.25), SW, 1.0),
                     (big(["B4", "E5", "F#5"], 1.8, 0.9, 1.0, 800, 6000, curve=1.2), SW + 0.3, 0.45),
                     (S("pro_impact/deep"), SW, 0.45), (boom(0), SW, 0.8)), rt60=5.0, octave_gain=0.5))
# Quitting waits for its sound, so these stay short: under 2 s with the tail.
cue("QUT-A", "Power down", "quit", "Synth", "the Ignition chord hit then closing its filter and sagging three semitones into the room",
    room(bend(mix((big(WIDE, 1.0, 0.005, 0.8, 7000, 200, curve=0.5), 0, 1.0), (sub("E1", int(1.0 * SR), 0.005, 0.8), 0, 0.6)), -3),
         rt60=1.8, wet=0.5))
cue("QUT-B", "Fade", "quit", "Synth", "a wide chord falling an octave as it fades, no transient",
    room(bend(mix((big(["B2", "E3", "G#3", "B3", "E4"], 1.1, 0.06, 0.9, 5000, 400, curve=0.8, spread=0.4), 0, 1.0)), -12),
         rt60=1.8, wet=0.55))
cue("QUT-C", "Sleep", "quit", "Synth", "a dark sus2 chord sinking into a sub drop",
    room(mix((bend(big(["E2", "B2", "F#3", "B3"], 1.0, 0.01, 0.8, 2500, 250, curve=0.6), -5), 0, 1.0),
             (S("pro_sub_drop/soft", dur=1.0), 0, 0.7)), rt60=1.6, wet=0.5))


# ---------- three modern-tech kits: soft tones, warm pad stabs, round electric-piano plucks ----------
# The owner's direction: modern tech, mid-low register, no bells, no high ticks, no risers, no data bursts. Every voice
# here is harmonic (no inharmonic ring), rounded at the top (low-passed under ~4 kHz) and sits in a small soft room.


def tail_fade(a, ms=25):
    """Every note ends at zero, so a note cut short never clicks."""
    k = min(len(a), int(ms / 1000 * SR))
    a[-k:] *= np.linspace(1, 0, k)[:, None]
    return a


def tone(note, dur=0.6, attack=0.012, decay=0.28, harm=0.18, cents=6):
    """A soft synth tone: a sine with a little second harmonic, detuned a few cents left and right for width."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(note)
    env_ = np.minimum(t / attack, 1) * np.exp(-t / decay)
    side = [np.sin(2 * np.pi * f * 2 ** (c / 1200) * t) + harm * np.sin(4 * np.pi * f * 2 ** (c / 1200) * t) for c in (-cents, cents)]
    return tail_fade(np.stack(side, 1) * env_[:, None] * 0.5)


def keys(note, dur=0.7, decay=0.45, index=1.1):
    """A round electric-piano pluck: FM at ratio 1 (harmonic, never a bell), its brightness falling fast."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(note)
    idx = index * np.exp(-t / 0.07)
    x = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * t)) * np.minimum(t / 0.003, 1) * np.exp(-t / decay)
    return tail_fade(filt(np.stack([x, x], 1), "low", 3500) * 0.6)


def stab(notes, dur=0.5, release=0.35, cut=(2800, 500)):
    """A warm pad stab: a soft supersaw chord whose filter closes as it decays."""
    # No Haas widening here: on a short stab it combs when the Mac's speakers sum to mono; the room gives width.
    return drive(chord(notes, dur, 0.01, release, cut[0], cut[1], curve=0.6, voices=5, spread=0.12), 1.4)


def seq(make, notes, step, gains=None, **kw):
    gains = gains or [1.0] * len(notes)
    return mix(*[(make(nt, **kw), i * step, g) for i, (nt, g) in enumerate(zip(notes, gains))])


def soft(a, rt=1.0, wet=0.28, cut=4000):
    return filt(room(a, rt60=rt, wet=wet, dark=3500), "low", cut)


# H: Halo. Soft synth tones in a small room: the calmest, most "OS".
cue("STR-H", "Wake", "start", "Halo", "two soft tones a fifth apart, E then B", soft(seq(tone, ["E4", "B4"], 0.09, [0.8, 0.9])))
cue("UPD-H", "Glow", "update", "Halo", "one faint soft tone", soft(tone("B4", 0.4, decay=0.15)))
cue("DON-H", "Settle", "done", "Halo", "E, G sharp, B, landing on a held E chord", soft(mix(
    (seq(tone, ["E4", "G#4", "B4"], 0.08, [0.7, 0.75, 0.85]), 0, 1.0),
    (mix((tone("E4", 1.0, 0.03, 0.5), 0, 0.4), (tone("B4", 1.0, 0.03, 0.5), 0, 0.3)), 0.22, 1.0)), rt=1.4, wet=0.32))
cue("ERR-H", "Dip", "failed", "Halo", "two low tones falling a tritone, darker and dry", filt(seq(tone, ["B3", "F3"], 0.13, [0.9, 1.0], decay=0.22, harm=0.3), "low", 2200))
cue("ASK-H", "Call", "ask", "Halo", "the signature in soft tones: E, B, E, a little brighter, in a room", soft(seq(tone, ["E5", "B4", "E5"], 0.11, [0.9, 0.75, 0.95], harm=0.25), rt=1.2, wet=0.3))
cue("TRN-H", "Knock", "turn", "Halo", "two equal soft tones on G sharp", soft(seq(tone, ["G#4", "G#4"], 0.15, decay=0.18)))
cue("ACK-H", "Touch", "sent", "Halo", "one short soft tone", soft(tone("E5", 0.25, decay=0.08), rt=0.6, wet=0.2))
cue("LNK-H", "Bond", "linked", "Halo", "two tones answering each other, then the chord opens", soft(mix(
    (tone("E4"), 0, 0.8, -0.4), (tone("B4"), 0.14, 0.8, 0.4),
    (mix(*[(tone(nt, 1.4, 0.05, 0.7), 0, 0.3) for nt in ["E4", "G#4", "B4", "D#5"]]), 0.32, 1.0)), rt=1.8, wet=0.38))
cue("LCH-H", "Daybreak", "launch", "Halo", "a slow arpeggio of soft tones over a warm pad, in a deep hall", shimmer_room(mix(
    (seq(tone, ["E3", "B3", "E4", "G#4", "B4"], 0.12, [0.6, 0.65, 0.7, 0.75, 0.8], dur=1.6, decay=0.8), 0, 1.0),
    (stab(["E2", "B2", "E3", "G#3"], 2.2, 1.6, (900, 1800)), 0.1, 0.5), (sub("E1", int(2.2 * SR), 0.2, 1.4), 0, 0.4)), rt60=4.0, octave_gain=0.25))
cue("QUT-H", "Dusk", "quit", "Halo", "the arpeggio falling back down into the room", room(mix(
    (seq(tone, ["B4", "G#4", "E4", "B3"], 0.09, [0.8, 0.7, 0.65, 0.6], dur=0.9, decay=0.4), 0, 1.0),
    (sub("E1", int(0.9 * SR), 0.01, 0.7), 0, 0.35)), rt60=1.6, wet=0.45))

# O: Orbit. Warm pad stabs with a sub under them: cinematic, the launch synths' small cousins.
cue("STR-O", "Ignite", "start", "Orbit", "a short warm stab, E then B on top", soft(mix((stab(["E3", "B3", "E4"], 0.35, 0.25), 0, 0.8), (stab(["B3", "E4", "B4"], 0.35, 0.25), 0.08, 0.7))))
cue("UPD-O", "Pulse", "update", "Orbit", "one tiny muted stab", soft(stab(["E3", "B3"], 0.18, 0.14, (1500, 400)), rt=0.6, wet=0.2))
cue("DON-O", "Land", "done", "Orbit", "a warm E major stab that opens, with a soft sub", soft(mix(
    (stab(["E3", "G#3", "B3", "E4"], 0.7, 0.55, (800, 3000)), 0, 1.0), (sub("E2", int(0.7 * SR), 0.01, 0.5), 0, 0.4)), rt=1.5, wet=0.35))
cue("ERR-O", "Stall", "failed", "Orbit", "a dark stab that sinks a little, closing its filter", room(bend(stab(["E2", "B2", "F3"], 0.5, 0.4, (1800, 250)), -2), rt60=0.9, wet=0.25))
cue("ASK-O", "Beacon", "ask", "Orbit", "two warm stabs, low then high, like a held breath", soft(mix(
    (stab(["E3", "B3", "E4"], 0.3, 0.22), 0, 0.85), (stab(["B3", "E4", "G#4", "B4"], 0.5, 0.4, (3200, 900)), 0.16, 1.0)), rt=1.4, wet=0.33))
cue("TRN-O", "Nudge", "turn", "Orbit", "two equal muted stabs", soft(seq(lambda n, **k: stab([n, "B3"], 0.22, 0.16, (1800, 500)), ["E3", "E3"], 0.17)))
cue("ACK-O", "Seat", "sent", "Orbit", "a very short soft stab", soft(stab(["E3", "B3", "E4"], 0.14, 0.1, (2200, 600)), rt=0.5, wet=0.18))
cue("LNK-O", "Dock", "linked", "Orbit", "a stab, a second answering it, then the chord blooms open", shimmer_room(mix(
    (stab(["E3", "B3"], 0.3, 0.2), 0, 0.7), (stab(["B3", "E4"], 0.3, 0.2), 0.14, 0.7),
    (stab(["E3", "B3", "D#4", "G#4"], 1.3, 1.0, (700, 3500)), 0.3, 0.9), (sub("E1", int(1.3 * SR), 0.05, 1.0), 0.3, 0.4)), rt60=2.5, octave_gain=0.2))
cue("LCH-O", "Liftoff", "launch", "Orbit", "a big warm Emaj9 stab opening wide over a sub boom, then a long hall", shimmer_room(mix(
    (big(["E2", "B2", "E3", "G#3", "D#4", "F#4"], 2.4, 0.02, 1.8, 500, 4500, curve=0.5, spread=0.25), 0, 1.0),
    (boom(0), 0, 0.8)), rt60=4.5, octave_gain=0.3))
cue("QUT-O", "Landing", "quit", "Orbit", "the stab closing and sinking with the sub", room(bend(mix(
    (stab(["E2", "B2", "E3", "G#3"], 1.0, 0.8, (3000, 250)), 0, 1.0), (sub("E1", int(1.0 * SR), 0.01, 0.8), 0, 0.5)), -3), rt60=1.6, wet=0.45))

# K: Keys. Round electric-piano plucks: warm, musical, tactile.
cue("STR-K", "Begin", "start", "Keys", "two round plucks, E then B", soft(seq(keys, ["E4", "B4"], 0.08, [0.8, 0.9])))
cue("UPD-K", "Tap", "update", "Keys", "one quiet low pluck", soft(keys("B3", 0.35, 0.18), rt=0.6, wet=0.2))
cue("DON-K", "Resolve", "done", "Keys", "a quick E major roll landing on the root", soft(seq(keys, ["E4", "G#4", "B4", "E5"], 0.06, [0.6, 0.65, 0.7, 0.8], dur=1.0, decay=0.5), rt=1.3, wet=0.3))
cue("ERR-K", "Miss", "failed", "Keys", "two low plucks falling a tritone, short", filt(seq(keys, ["B3", "F3"], 0.12, [0.9, 1.0], decay=0.25, index=1.4), "low", 2200))
cue("ASK-K", "Ring", "ask", "Keys", "the signature as plucks: E, B, E, with a soft chord under the last", soft(mix(
    (seq(keys, ["E5", "B4", "E5"], 0.11, [0.9, 0.75, 0.95]), 0, 1.0), (mix((keys("G#4", 0.8, 0.4), 0, 0.4), (keys("B4", 0.8, 0.4), 0, 0.35)), 0.22, 1.0)), rt=1.2, wet=0.3))
cue("TRN-K", "Knock", "turn", "Keys", "two equal round plucks on G sharp", soft(seq(keys, ["G#4", "G#4"], 0.15, decay=0.25)))
cue("ACK-K", "Pip", "sent", "Keys", "one short muted pluck", soft(keys("E4", 0.2, 0.08, index=0.8), rt=0.5, wet=0.15))
cue("LNK-K", "Chord", "linked", "Keys", "a slow rolled Emaj9 on keys, ringing out", soft(seq(keys, ["E3", "B3", "D#4", "G#4", "B4"], 0.09, [0.6, 0.65, 0.7, 0.75, 0.8], dur=1.6, decay=0.9), rt=2.0, wet=0.4))
cue("LCH-K", "Overture", "launch", "Keys", "a rolled chord on keys over a swelling warm pad and sub, deep hall", shimmer_room(mix(
    (seq(keys, ["E2", "B2", "E3", "G#3", "D#4", "B4"], 0.1, [0.6, 0.6, 0.65, 0.7, 0.75, 0.8], dur=2.2, decay=1.2), 0, 1.0),
    (stab(["E2", "B2", "E3", "G#3"], 2.2, 1.6, (500, 2000)), 0.15, 0.45), (boom(0), 0, 0.5)), rt60=4.5, octave_gain=0.25))
cue("QUT-K", "Coda", "quit", "Keys", "the chord rolled downward, fading into the room", room(seq(keys, ["B4", "G#4", "E4", "B3", "E3"], 0.07, [0.8, 0.7, 0.65, 0.6, 0.6], dur=1.0, decay=0.5), rt60=1.6, wet=0.45))


# ---------- interface: notch tabs, the Settings window, its sections, switches ----------
# Lowkey and professional, in the approved low style (Halo tones, the Hush and Press pairs): quieter than the notch,
# nothing above ~1.5 kHz. Windows and switches are mirrored pairs (rising to open or turn on, falling to close or off).
def ui_pair(code, name, slot, sides, desc, first, second):
    for side, audio in zip(sides, (first, second)):
        cue(f"{code}.{side}", name, side, "Interface", desc, audio)
        LIB[-1]["pair"] = code
        LIB[-1]["slot"] = slot


def ui_single(code, name, slot, desc, audio):
    cue(code, name, slot, "Interface", desc, audio)
    LIB[-1]["slot"] = slot


def dim(a, cut=1500):
    return filt(a, "low", cut)


ui_single("TAB-A", "Detent", "tab", "one very short soft tone, like a notch in a dial", dim(tone("E4", 0.12, 0.004, 0.035), 1800))
ui_single("TAB-B", "Slide", "tab", "a small rounded pop, quieter than a card", dim(S("pro_pop_in/round", pitch="E3")))
ui_single("TAB-C", "Pluck", "tab", "a muted electric-piano pluck", dim(keys("B3", 0.3, 0.05, index=0.7)))
ui_single("TAB-D", "Felt", "tab", "a soft felt tap, barely there", dim(S("pro_tap/soft", pitch="B2"), 1300))

ui_pair("WIN-A", "Unfold", "window", ("winopen", "winclose"), "two soft tones: E to B rising to open, B to E falling to close",
        soft(seq(tone, ["E4", "B4"], 0.07, [0.75, 0.9], dur=0.35, decay=0.12), rt=0.7, wet=0.22, cut=2200),
        soft(seq(tone, ["B4", "E4"], 0.07, [0.9, 0.7], dur=0.35, decay=0.12), rt=0.7, wet=0.22, cut=2200))
ui_pair("WIN-B", "Sheet", "window", ("winopen", "winclose"), "a dark breath of air landing on a low pop to open; the pop breathing out to close",
        dim(mix((S("whoosh_fast/tight", dur=0.24, apex=0.18), 0, 0.5), (S("pro_pop_in/deep", pitch="E3"), 0.18, 0.8)), 1400),
        dim(mix((S("pro_pop_in/deep", pitch="B2"), 0, 0.8), (S("whoosh_fast/tight", dur=0.24, apex=0.04), 0, 0.5)), 1400))
ui_pair("WIN-C", "Panel", "window", ("winopen", "winclose"), "a muted warm stab, E then B rising to open, falling to close",
        soft(mix((stab(["E3", "B3"], 0.16, 0.12, (1400, 500)), 0, 0.8), (stab(["B3", "E4"], 0.18, 0.14, (1400, 500)), 0.07, 0.9)), rt=0.7, wet=0.2, cut=1800),
        soft(mix((stab(["B3", "E4"], 0.16, 0.12, (1400, 500)), 0, 0.9), (stab(["E3", "B3"], 0.18, 0.14, (1400, 500)), 0.07, 0.75)), rt=0.7, wet=0.2, cut=1800))
ui_pair("WIN-D", "Hush", "window", ("winopen", "winclose"), "the notch's Hush pair, a touch softer: one family for the notch and the window",
        *[a * 0.8 for a in mirrored(hush, "A2", "E3", 0.065, 2000)])

ui_single("SEC-A", "Step", "section", "a faint soft tone on G sharp", dim(tone("G#4", 0.1, 0.004, 0.03), 1800))
ui_single("SEC-B", "Touch", "section", "a tiny low tap", dim(S("pro_tap/finger", pitch="B2"), 1300))
ui_single("SEC-C", "Mute", "section", "a muted pluck, shorter than a tab", dim(keys("E4", 0.25, 0.035, index=0.6)))

ui_pair("TGL-A", "Switch", "toggle", ("on", "off"), "a quick tone pair: B up to E for on, E down to B for off",
        dim(seq(tone, ["B3", "E4"], 0.035, [0.7, 0.9], dur=0.12, decay=0.04), 2000),
        dim(seq(tone, ["E4", "B3"], 0.035, [0.9, 0.7], dur=0.12, decay=0.04), 2000))
ui_pair("TGL-B", "Latch", "toggle", ("on", "off"), "the Press pop: a little higher for on, a little lower for off",
        dim(S("pro_pop_in/deep", pitch="E3")), dim(S("pro_pop_in/deep", pitch="B2")))
ui_pair("TGL-C", "Rocker", "toggle", ("on", "off"), "a soft tap and a low tone: rising for on, falling for off",
        dim(mix((S("pro_tap/soft", pitch="B2"), 0, 0.7), (tone("E4", 0.1, 0.004, 0.035), 0.03, 0.6)), 1800),
        dim(mix((tone("E4", 0.1, 0.004, 0.035), 0, 0.6), (S("pro_tap/soft", pitch="B2"), 0.03, 0.7)), 1800))


# ---------- level, check, write ----------
# Loudness by tier: the more it may interrupt, the louder; interface sounds sit near the floor.
TIER = {"ask": -21, "failed": -23, "done": -24, "turn": -25, "linked": -23, "start": -27,
        "sent": -28, "update": -32, "launch": -22, "quit": -25, "open": -30, "close": -30, "expand": -31, "collapse": -31,
        "tab": -34, "section": -36, "winopen": -31, "winclose": -31, "on": -34, "off": -34}
FADE = int(0.015 * SR)
meta = []
for c in LIB:
    a = np.asarray(c.pop("audio"), np.float64)
    if a.ndim == 1:
        a = np.stack([a, a], 1)
    a = a - a.mean(0)  # no DC
    # trim the inaudible tail (-60 dB), then fade so a cut never clicks
    env = np.abs(a).max(1)
    last = np.nonzero(env > env.max() * 1e-3)[0][-1]
    a = a[: min(len(a), last + FADE)]
    a[-FADE:] *= np.linspace(1, 0, FADE)[:, None]
    # Room tails fade by a length per moment: the voice waits for the cue, and quitting waits for its sound.
    cap = {"launch": 4.5, "quit": 2.0, "linked": 2.2, "done": 1.3, "ask": 1.3, "start": 0.9, "turn": 0.9,
           "failed": 0.9, "update": 0.6, "sent": 0.5,
           "tab": 0.25, "section": 0.2, "winopen": 0.6, "winclose": 0.6, "on": 0.25, "off": 0.25}.get(c["moment"])
    if cap and len(a) > cap * SR:
        a = a[: int(cap * SR)]
        long = int(min(0.6, cap * 0.4) * SR)
        a[-long:] *= np.linspace(1, 0, long)[:, None] ** 2
    meter = pyln.Meter(SR, block_size=min(0.4, len(a) / SR * 0.95))
    loud = meter.integrated_loudness(a)
    a = pyln.normalize.loudness(a, loud, TIER[c["moment"]])
    peak = np.abs(a).max()
    if peak > 10 ** (-1 / 20):
        a *= 10 ** (-1 / 20) / peak
    sf.write(os.path.join(OUT, c["code"] + ".wav"), a.astype(np.float32), SR, subtype="PCM_24")
    meta.append({**c, "dur": round(len(a) / SR, 3), "lufs": TIER[c["moment"]]})
    print(f"{c['code']:6} {c['name']:11} {len(a) / SR:5.2f}s")
json.dump(meta, open(os.path.join(OUT, "library.json"), "w"), indent=1)
print(f"{len(meta)} cues -> {OUT}")
