"""Shared synthesis and mastering for Relo's sounds (studio.py). Pure numpy/scipy plus earshot's bank; 48 kHz stereo."""
import numpy as np
from earshot.forge import bank
from scipy.signal import butter, fftconvolve, sosfilt

SR = 48000
NOTES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
rng = np.random.default_rng(7)


def hz(note):
    return 440.0 * 2 ** ((NOTES[note[:-1]] + 12 * (int(note[-1]) + 1) - 69) / 12)


def transpose(note, semis):
    n = NOTES[note[:-1]] + 12 * int(note[-1]) + semis
    name = [k for k, v in NOTES.items() if v == n % 12][0]
    return f"{name}{n // 12}"


def st(x):
    x = np.asarray(x, np.float64)
    return np.stack([x, x], 1) if x.ndim == 1 else x


def filt(a, kind, f, order=2):
    return sosfilt(butter(order, f, kind, fs=SR, output="sos"), a, axis=0)


def shelf_down(a, f=2500, db=-6):
    """A gentle high shelf: the band above f is turned down by db (a first-order split, phase-safe enough for UI)."""
    hi = filt(a, "high", f, 1)
    return a + hi * (10 ** (db / 20) - 1)


def env(n, attack, decay, hold=0.0):
    t = np.arange(n) / SR
    up = np.clip(t / max(attack, 1e-4), 0, 1)
    up = 0.5 - 0.5 * np.cos(np.pi * up)  # raised cosine: no corner at the onset
    down = np.exp(-np.clip(t - attack - hold, 0, None) / decay)
    return up * down


def fade_out(a, ms=20):
    k = min(len(a), int(ms / 1000 * SR))
    a[-k:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, k)))[:, None]
    return a


def mix(*parts, tail=0.02):
    """parts: (audio, at_seconds, gain[, pan -1..1]). Equal-power pan."""
    end = max(int(at * SR) + len(a) for a, at, *_ in parts) + int(tail * SR)
    out = np.zeros((end, 2))
    for a, at, gain, *rest in parts:
        a = st(a)
        pan = rest[0] if rest else 0.0
        g = np.array([np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)]) * np.sqrt(2)
        i = int(at * SR)
        out[i : i + len(a)] += a * gain * g
    return out


# ---------- voices: every one harmonic, rounded, its top rolled off ----------
def v_sine(note, dur=0.4, attack=0.008, decay=0.12, harm=0.12, cents=4):
    """A soft sine with a touch of second harmonic, detuned a few cents left and right."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(note)
    e = env(n, attack, decay)
    side = [np.sin(2 * np.pi * f * 2 ** (c / 1200) * t) + harm * np.sin(4 * np.pi * f * 2 ** (c / 1200) * t) for c in (-cents, cents)]
    return fade_out(np.stack(side, 1) * e[:, None] * 0.5)


def v_felt(note, dur=0.3, attack=0.004, decay=0.07):
    """A felt mallet: a sine whose pitch settles from a hair above (a soft 'thup'), with a quiet fourth harmonic."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(note) * (1 + 0.04 * np.exp(-t / 0.012))
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = (np.sin(ph) + 0.06 * np.sin(4 * ph) * np.exp(-t / 0.03)) * env(n, attack, decay)
    return fade_out(st(filt(x, "low", 2500)) * 0.55)


def v_keys(note, dur=0.5, decay=0.25, index=0.8):
    """A round electric-piano tone: FM at ratio 1 (harmonic, never a bell), brightness falling fast."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(note)
    idx = index * np.exp(-t / 0.05)
    x = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * t)) * env(n, 0.004, decay)
    return fade_out(st(filt(x, "low", 2800)) * 0.55)


def v_glass_free_pad(notes, dur=0.6, attack=0.02, decay=0.3, cut=1400, voices=5, spread=0.1):
    """A warm muted pad stab: detuned saws through a fixed low-pass, gently driven."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    for note in notes:
        for v in range(voices):
            d = spread * (v / (voices - 1) - 0.5) * 2
            f = hz(note) * 2 ** (d / 12)
            x = 2 * ((t * f + rng.random()) % 1) - 1
            pan = (v / (voices - 1) - 0.5) * 0.8
            out += np.stack([x * np.cos((pan + 1) * np.pi / 4), x * np.sin((pan + 1) * np.pi / 4)], 1)
    out = filt(out / (voices * len(notes)), "low", cut, 2) * env(n, attack, decay)[:, None]
    return fade_out(np.tanh(out * 1.6) / np.tanh(1.6))


_bank = {}


def bank_at(sound_id, note):
    """An earshot bank sound at `note`, or octaves below it when the recipe's body cannot reach that high."""
    key = (sound_id, note)
    if key not in _bank:
        f = hz(note)
        while True:
            try:
                a, _ = bank.render(sound_id, pitch=f, checks=False)
                break
            except Exception as e:
                if "range" not in str(e) or f < 40:
                    raise
                f /= 2
        _bank[key] = np.asarray(a, np.float64)
    return _bank[key].copy()


def v_pop(note, kind="round", cut=1600):
    """earshot's pop-in (its body at or under the note) with a quiet sine at the note itself, so it speaks on laptops
    instead of turning to mud."""
    body = v_sine(note, 0.16, 0.004, 0.045, harm=0.05, cents=0)
    return fade_out(filt(mix((bank_at(f"pro_pop_in/{kind}", note), 0, 0.75), (body, 0, 0.45)), "low", cut, 2))


def v_tap(note, kind="soft", cut=1500):
    """earshot's soft tap under a quiet sine body at the same note: tactile, never clicky."""
    body = v_sine(note, 0.15, 0.003, 0.04, harm=0.05, cents=0)
    return fade_out(filt(mix((bank_at(f"pro_tap/{kind}", note), 0, 0.7), (body, 0, 0.5)), "low", cut, 2))


def v_sub(note, dur, attack=0.02, decay=0.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(note)
    x = (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)) * env(n, attack, decay)  # the 2nd harmonic speaks on laptops
    return fade_out(st(x) * 0.5)


# ---------- space ----------
_irs = {}


def room(a, size=0.5, wet=0.2, dark=3000, pre=0.012):
    """A small soft room: early reflections plus a short darkening tail. size is RT60 in seconds."""
    key = (size, dark, pre)
    if key not in _irs:
        n = int(size * 1.3 * SR)
        t = np.arange(n) / SR
        ir = rng.standard_normal((n, 2)) * np.exp(-6.9 * t / size)[:, None]
        ir = filt(ir, "low", dark, 2)
        ir = filt(ir, "high", 200, 1)
        for k, d in enumerate((0.007, 0.011, 0.017, 0.023)):  # early reflections, alternating sides
            i = int(d * SR)
            ir[i, k % 2] += 0.6 / (k + 1)
        ir = np.concatenate([np.zeros((int(pre * SR), 2)), ir])
        _irs[key] = ir / np.sqrt((ir ** 2).sum() / 2)
    ir = _irs[key]
    tail = np.stack([fftconvolve(a[:, c], ir[:, c]) for c in range(2)], 1)
    dry = np.zeros_like(tail)
    dry[: len(a)] = a
    return dry * (1 - wet) + tail * wet * 0.35


def master(a, top=4500, shelf=2500, shelf_db=-6, hp=90):
    """The house finish: rumble out, the presence band softened, the top rolled off, DC removed."""
    a = filt(a, "high", hp, 2) if hp else a
    a = shelf_down(a, shelf, shelf_db)
    a = filt(a, "low", top, 4)
    return a - a.mean(0)
