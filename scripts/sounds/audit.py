"""Measures every candidate sound against Relo's sound language, so only lowkey, clean variants reach the owner.

    marketing/films/.venv/bin/python scripts/sounds/audit.py <dir-with-wavs-and-library.json> [--codes A,B,...]

Writes <dir>/audit.json: per sound its measurements, each rule's verdict, and pass/fail; prints a table. The rules and
their thresholds live in RULES below (one place), calibrated on the owner's approved and rejected sounds.
"""
import json
import os
import sys

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy.signal import resample_poly

D = sys.argv[1]
ONLY = None
if "--codes" in sys.argv:
    ONLY = set(sys.argv[sys.argv.index("--codes") + 1].split(","))


def band(spec, freqs, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    return float(spec[m].sum())


def measure(path):
    a, sr = sf.read(path, always_2d=True)
    mono = a.mean(1)
    n = len(mono)
    dur = n / sr
    # Loudness: integrated LUFS (gated); very short sounds fall back to their RMS on the same K-weighting scale.
    meter = pyln.Meter(sr, block_size=min(0.4, dur * 0.95))
    try:
        lufs = float(meter.integrated_loudness(a))
    except Exception:
        lufs = float("nan")
    true_peak = 20 * np.log10(np.abs(resample_poly(a, 4, 1, axis=0)).max() + 1e-12)
    rms = np.sqrt(np.mean(mono ** 2)) + 1e-12
    # Crest over the sounding part (above -40 dB of peak), so a long quiet tail does not inflate it.
    env = np.abs(mono)
    live = env > env.max() * 0.01
    rms_live = np.sqrt(np.mean(mono[live] ** 2)) + 1e-12
    crest = 20 * np.log10(env.max() / rms_live)
    # Attack: 10% to 90% of the smoothed envelope's peak (2 ms window).
    k = max(1, int(0.002 * sr))
    sm = np.convolve(env, np.ones(k) / k, mode="same")
    pk = sm.argmax()
    above10 = np.nonzero(sm[: pk + 1] >= 0.1 * sm[pk])[0]
    above90 = np.nonzero(sm[: pk + 1] >= 0.9 * sm[pk])[0]
    attack_ms = (above90[0] - above10[0]) / sr * 1000 if len(above10) and len(above90) else 0.0
    # Spectrum: weighted by energy, so the loud part speaks.
    spec = np.abs(np.fft.rfft(mono)) ** 2
    freqs = np.fft.rfftfreq(n, 1 / sr)
    total = spec.sum() + 1e-20
    centroid = float((spec * freqs).sum() / total)
    presence = band(spec, freqs, 2000, 5000) / total  # the harsh band on laptop speakers
    air = band(spec, freqs, 6000, sr / 2) / total
    rumble = band(spec, freqs, 0, 70) / total  # lost on laptop speakers, wasted headroom
    # The first 20 ms: a hard click lives here.
    head = mono[: int(0.02 * sr)]
    hs = np.abs(np.fft.rfft(head, 4096)) ** 2
    hf = np.fft.rfftfreq(4096, 1 / sr)
    head_hf = float(hs[hf > 4000].sum() / (hs.sum() + 1e-20))
    # Mono sum: how much energy survives L+R on a laptop (0 dB mono, -3 dB fully decorrelated, far below: combing).
    if a.shape[1] == 2:
        el, er, es = (a[:, 0] ** 2).sum(), (a[:, 1] ** 2).sum(), (((a[:, 0] + a[:, 1]) / 2) ** 2).sum()
        mono_db = float(10 * np.log10(es / ((el + er) / 2 + 1e-20) + 1e-20))
    else:
        mono_db = 0.0
    # Lead: the first audible sample (-60 dB of peak) must come at once, or the interface feels laggy.
    lead_ms = float(np.nonzero(env > env.max() * 1e-3)[0][0] / sr * 1000)
    low = band(spec, freqs, 0, 100) / total
    # Ends: the last 5 ms must be near silence (no truncation click).
    end = float(20 * np.log10(np.abs(mono[-int(0.005 * sr):]).max() / (env.max() + 1e-12) + 1e-12))
    return dict(dur=round(dur, 3), lufs=round(lufs, 1), true_peak=round(true_peak, 1), crest=round(crest, 1),
                attack_ms=round(attack_ms, 1), centroid=int(centroid), presence=round(presence, 3), air=round(air, 4),
                rumble=round(rumble, 3), head_hf=round(head_hf, 3), mono_db=round(mono_db, 1),
                lead_ms=round(lead_ms, 1), low=round(low, 3), end_db=round(end, 1))


# Categories (docs/SOUND.md): what each moment is allowed.
CATEGORY = {
    "tab": "micro", "section": "micro", "on": "micro", "off": "micro",
    "open": "transition", "close": "transition", "expand": "transition", "collapse": "transition",
    "winopen": "transition", "winclose": "transition",
    "start": "status", "update": "status", "sent": "status",
    "done": "notification", "failed": "notification", "turn": "notification", "linked": "notification",
    "ask": "interruptive", "launch": "hero", "quit": "hero",
}

# Every threshold in one place: (metric, op, value, why). From the research brief, calibrated on the owner's approved
# and rejected sounds (approved lowkey ones pass, every rejected one fails).
COMMON = [
    ("true_peak", "<=", -2.5, "headroom: UI cues sit well under full scale"),
    ("centroid", "<=", 1200, "low and warm: nothing high-pitched"),
    ("presence", "<=", 0.04, "the harsh 2-5 kHz band stays 12 dB+ down"),
    ("air", "<=", 0.006, "no fizz or tick above 6 kHz"),
    ("head_hf", "<=", 0.04, "no click in the first 20 ms"),
    ("end_db", "<=", -40, "ends in silence, never cut off"),
    ("mono_db", ">=", -4.5, "survives a laptop's mono sum"),
    ("lead_ms", "<=", 5, "starts at once: lead-in silence feels laggy"),
]
# Small sounds carry no energy laptops cannot play.
SMALL = [("low", "<=", 0.15, "nothing material under 100 Hz")]
PER = {
    "micro": SMALL + [("dur", "<=", 0.155, "over before the hand moves on"), ("crest", "<=", 13, "soft, not a tick"),
                      ("attack_ms", ">=", 1.5, "a rounded onset")],
    "transition": SMALL + [("dur", "<=", 0.31, "never outlasts its motion"), ("crest", "<=", 13, "soft"),
                           ("attack_ms", ">=", 1.5, "a rounded onset")],
    "status": SMALL + [("dur", "<=", 0.46, "ambient news stays short"), ("crest", "<=", 13, "never sharp")],
    "notification": [("dur", "<=", 0.96, "said once, then gone"), ("crest", "<=", 14, "calm, not alarming")],
    "interruptive": [("dur", "<=", 1.11, "a call, not a song"), ("crest", "<=", 14, "clear, not harsh")],
    "hero": [("dur", "<=", 4.6, "brief"), ("crest", "<=", 16, "full, not explosive")],
}
# earshot sfx check findings that fail a sound (tonal "ring" and discrete-note "whip" are false positives here).
EARSHOT_FAIL = ("click", "clipped", "tail cut", "DC", "truncat")


def judge(m, moment, category=None):
    rules = COMMON + PER[category or CATEGORY.get(moment, "status")]
    out = []
    for metric, op, value, why in rules:
        v = m[metric]
        ok = (v <= value) if op == "<=" else (v >= value)
        if isinstance(v, float) and np.isnan(v):
            ok = True
        out.append(dict(rule=f"{metric} {op} {value}", ok=bool(ok), value=v, why=why))
    return out


def earshot_findings(paths):
    """Runs earshot sfx check over the files (in chunks) and returns {basename: [warnings]}."""
    import subprocess
    exe = os.path.join(os.path.dirname(sys.executable), "earshot")
    found = {}
    for k in range(0, len(paths), 60):
        out = subprocess.run([exe, "--threads", "2", "sfx", "check", *paths[k:k + 60]], capture_output=True, text=True).stdout
        for line in out.splitlines():
            if ".wav:" in line:
                name, rest = line.split(".wav:", 1)
                found[name.strip()] = [] if rest.strip().startswith("clean") else [rest.strip()]
    return found


def main():
    lib = json.load(open(os.path.join(D, "library.json")))
    items = [c for c in lib if (not ONLY or c["code"] in ONLY) and os.path.exists(os.path.join(D, c["code"] + ".wav"))]
    shot = earshot_findings([os.path.join(D, c["code"] + ".wav") for c in items])
    rows = []
    for c in items:
        m = measure(os.path.join(D, c["code"] + ".wav"))
        category = c.get("category") or CATEGORY.get(c["moment"], "status")
        verdicts = judge(m, c["moment"], category)
        fails = [v["rule"] + " (" + str(v["value"]) + ")" for v in verdicts if not v["ok"]]
        es = shot.get(c["code"], [])
        if es and any(w in es[0] for w in EARSHOT_FAIL):
            fails.append("earshot: " + es[0])
        rows.append(dict(code=c["code"], moment=c["moment"], category=category, pair=c.get("pair"), **m,
                         earshot=es[0] if es else "clean", fails=fails))
    # Pairs mirror each other: within 15% duration, 1 LU loudness, 25% centroid.
    by_pair = {}
    for r in rows:
        if r["pair"]:
            by_pair.setdefault(r["pair"], []).append(r)
    for code, sides in by_pair.items():
        if len(sides) != 2:
            continue
        a, b = sides
        problems = []
        if abs(a["dur"] - b["dur"]) > 0.15 * max(a["dur"], b["dur"]):
            problems.append(f"pair durations differ ({a['dur']} vs {b['dur']})")
        if abs(a["lufs"] - b["lufs"]) > 1.0:
            problems.append(f"pair loudness differs ({a['lufs']} vs {b['lufs']})")
        if abs(a["centroid"] - b["centroid"]) > 0.25 * max(a["centroid"], b["centroid"]):
            problems.append(f"pair brightness differs ({a['centroid']} vs {b['centroid']} Hz)")
        for r in sides:
            r["fails"] += problems
    for r in rows:
        r["ok"] = not r["fails"]
        # Softness: lower is calmer (crest, brightness, harsh band); ranks the passing variants within a slot.
        r["softness"] = round(r["crest"] + r["centroid"] / 150 + r["presence"] * 200 + r["air"] * 500, 2)
    json.dump(rows, open(os.path.join(D, "audit.json"), "w"), indent=1)
    for r in rows:
        print(f"{r['code']:18} {'PASS' if r['ok'] else 'fail'}  c={r['centroid']:5} pres={r['presence']:.3f} crest={r['crest']:5} "
              f"att={r['attack_ms']:5}ms dur={r['dur']:.2f} {'; '.join(r['fails'])}")
    print(f"{sum(r['ok'] for r in rows)} / {len(rows)} pass")


main()
