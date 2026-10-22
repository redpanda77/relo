"""Animated SVG figures of Relo for Mac's closed notch, one per state, for docs/site/concepts/notch.md.

SMIL only (no script): the docs pages allow inline SVG and inline styles. Geometry and colors mirror
apps/notch/boringNotch/components/Relo/ReloOrbitWings.swift. Run after changing either:
    python3 scripts/docs/notch-figures.py
"""
import sys

RUN, NEEDS, TURN, DONE, FAILED, QUIET = "#8b7cff", "#ff6b57", "#fbbf24", "#34d399", "#f43f5e", "#6b7080"
W, NH, CX = 380, 32, 190
HOUSING, WING, OUTER, GAP = 186, 58, 6, 8
TOTAL = HOUSING + 2 * (WING + OUTER + GAP)
L, R = CX - TOTAL / 2, CX + TOTAL / 2
MX, MY, OR = L + OUTER + 10, NH / 2, 8
RX = R - OUTER - WING
HL, HR = CX - HOUSING / 2, CX + HOUSING / 2


def body_path(r=10, flare=6):
    return (f"M{L - flare} 0 Q{L} 0 {L} {flare} L{L} {NH - r} Q{L} {NH} {L + r} {NH} L{R - r} {NH} "
            f"Q{R} {NH} {R} {NH - r} L{R} {flare} Q{R} 0 {R + flare} 0 Z")


def beam_paths():
    e = 1.4
    left = f"M{CX} {NH - e} L{L + 10} {NH - e} Q{L + e} {NH - e} {L + e} {NH - 10} L{L + e} 6"
    right = f"M{CX} {NH - e} L{R - 10} {NH - e} Q{R - e} {NH - e} {R - e} {NH - 10} L{R - e} 6"
    return left, right


class Fig:
    def __init__(self, key):
        self.k = key
        self.defs, self.parts = [], []

    def id(self, name):
        return f"notch-{self.k}-{name}"

    def glow(self, color, strength=0.45, breathe=None, sides=("l", "r")):
        for side in sides:
            x0, x1 = (L, HL) if side == "l" else (HR, R)
            gid = self.id(f"glow-{side}")
            self.defs.append(
                f'<radialGradient id="{gid}" cx="{(x0 + x1) / 2}" cy="{NH + 6}" r="{(x1 - x0) * 0.85}" gradientUnits="userSpaceOnUse">'
                f'<stop offset="0" stop-color="{color}" stop-opacity="{0.55 * strength:.2f}"/>'
                f'<stop offset="0.6" stop-color="{color}" stop-opacity="{0.16 * strength:.2f}"/>'
                f'<stop offset="1" stop-color="{color}" stop-opacity="0"/></radialGradient>')
            anim = ""
            if breathe:
                anim = f'<animate attributeName="opacity" values="{breathe}" dur="2.4s" repeatCount="indefinite"/>'
            self.parts.append(f'<rect x="{x0}" y="0" width="{x1 - x0}" height="{NH}" fill="url(#{gid})" clip-path="url(#{self.id("body")})">{anim}</rect>')

    def rim(self, color, values, dur="2.4s"):
        self.defs.append(f'<filter id="{self.id("blur")}" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter>')
        left, right = beam_paths()
        for p in (left, right):
            self.parts.append(f'<path d="{p}" fill="none" stroke="{color}" stroke-width="2.4" filter="url(#{self.id("blur")})" '
                              f'clip-path="url(#{self.id("body")})" opacity="0"><animate attributeName="opacity" values="{values}" '
                              f'dur="{dur}" repeatCount="indefinite"/></path>')

    def beams(self, color, dur=3.2, until=0.55):
        """Two lights leave the bottom centre and climb both sides; then rest until the loop repeats."""
        for p in beam_paths():
            self.parts.append(
                f'<path d="{p}" fill="none" stroke="{color}" stroke-width="2.6" stroke-linecap="round" '
                f'stroke-dasharray="22 400" stroke-dashoffset="22" opacity="0">'
                f'<animate attributeName="stroke-dashoffset" values="22;-200;-200" keyTimes="0;{until};1" dur="{dur}s" '
                f'calcMode="spline" keySplines="0.65 0 0.35 1;0 0 1 1" repeatCount="indefinite"/>'
                f'<animate attributeName="opacity" values="0;1;0;0" keyTimes="0;{until * 0.3:.2f};{until};1" dur="{dur}s" repeatCount="indefinite"/>'
                f'</path>')

    def orbit_ring(self):
        self.parts.append(f'<circle cx="{MX}" cy="{MY}" r="{OR}" fill="none" stroke="#fff" stroke-opacity="0.09"/>')

    def core(self, color, r=3.3, pulse=True, halo=0.5, dur="2.8s"):
        if halo:
            self.parts.append(f'<circle cx="{MX}" cy="{MY}" r="{r + 4}" fill="{color}" opacity="0">'
                              f'<animate attributeName="opacity" values="0;{halo * 0.45:.2f};0" dur="{dur}" repeatCount="indefinite"/></circle>')
        anim = f'<animate attributeName="r" values="{r};{r * 1.18:.2f};{r}" dur="{dur}" repeatCount="indefinite"/>' if pulse else ""
        self.parts.append(f'<circle cx="{MX}" cy="{MY}" r="{r}" fill="{color}">{anim}</circle>')

    def satellites(self, colors, durs, alpha=1.0):
        n = len(colors)
        for i, (c, d) in enumerate(zip(colors, durs)):
            start = i * 360 / n
            trail = "".join(f'<circle cx="{MX + OR * cos_deg(-k * 7.5):.2f}" cy="{MY + OR * sin_deg(-k * 7.5):.2f}" r="1.5" '
                            f'fill="{c}" opacity="{(0.26 - k * 0.04) * alpha:.2f}"/>' for k in range(1, 6))
            self.parts.append(
                f'<g><animateTransform attributeName="transform" type="rotate" from="{start} {MX} {MY}" to="{start + 360} {MX} {MY}" '
                f'dur="{d}s" repeatCount="indefinite"/>{trail}<circle cx="{MX + OR}" cy="{MY}" r="2" fill="{c}" opacity="{alpha}"/></g>')

    def rings(self, color):
        for k in range(2):
            self.parts.append(
                f'<circle cx="{MX}" cy="{MY}" r="4" fill="none" stroke="{color}" stroke-width="1.2" opacity="0" '
                f'clip-path="url(#{self.id("wing")})">'
                f'<animate attributeName="r" values="4;18" dur="1.3s" begin="{k * 0.65}s" repeatCount="indefinite"/>'
                f'<animate attributeName="opacity" values="0.55;0" dur="1.3s" begin="{k * 0.65}s" repeatCount="indefinite"/></circle>')

    def bar(self, segments, color, width=42, alpha=1.0, live=True, flash=None):
        """segments: list of fills (1 done, 0<f<1 current, 0 open)."""
        n = len(segments)
        seg = (width - 3 * (n - 1)) / n
        y = MY - 1.5
        gid = self.id("fill")
        self.defs.append(f'<linearGradient id="{gid}"><stop offset="0" stop-color="{color}" stop-opacity="0.4"/>'
                         f'<stop offset="1" stop-color="{color}"/></linearGradient>')
        for i, f in enumerate(segments):
            x = RX + i * (seg + 3)
            self.parts.append(f'<rect x="{x:.2f}" y="{y}" width="{seg:.2f}" height="3" rx="1.5" fill="#fff" fill-opacity="{0.13 * alpha:.2f}"/>')
            if f <= 0:
                continue
            fw = max(3, seg * f)
            fill = f'url(#{gid})' if 0 < f < 1 and live else color
            self.parts.append(f'<rect x="{x:.2f}" y="{y}" width="{fw:.2f}" height="3" rx="1.5" fill="{fill}" opacity="{alpha}"/>')
            if flash == i:
                self.parts.append(f'<rect x="{x:.2f}" y="{y}" width="{fw:.2f}" height="3" rx="1.5" fill="#fff" opacity="0">'
                                  f'<animate attributeName="opacity" values="0;0.85;0;0" keyTimes="0;0.08;0.5;1" dur="3.2s" repeatCount="indefinite"/></rect>')
            if 0 < f < 1 and live:
                hx = x + fw
                self.parts.append(f'<circle cx="{hx:.2f}" cy="{MY}" r="3.2" fill="#fff" opacity="0.5">'
                                  f'<animate attributeName="opacity" values="0.25;0.75;0.25" dur="2.1s" repeatCount="indefinite"/></circle>')
                self.parts.append(f'<rect x="{x:.2f}" y="{y}" width="6" height="3" fill="#fff" opacity="0.6" clip-path="url(#{self.id("cur")})">'
                                  f'<animate attributeName="x" values="{x - 6:.2f};{hx:.2f}" dur="1.8s" repeatCount="indefinite"/></rect>')
                self.defs.append(f'<clipPath id="{self.id("cur")}"><rect x="{x:.2f}" y="{y}" width="{fw:.2f}" height="3" rx="1.5"/></clipPath>')

    def more(self, n, alpha=1.0):
        self.parts.append(f'<text x="{R - OUTER}" y="{MY + 3}" text-anchor="end" font-size="8.5" font-weight="600" '
                          f'font-family="-apple-system, system-ui, sans-serif" fill="#fff" fill-opacity="{0.5 * alpha:.2f}">+{n}</text>')

    def chip(self, text, color, w, extra=""):
        x = R - OUTER - w
        self.parts.append(f'<g>{extra}<rect x="{x}" y="{MY - 7.5}" width="{w}" height="15" rx="7.5" fill="{color}" fill-opacity="0.22"/>'
                          f'<text x="{x + w / 2}" y="{MY + 3.4}" text-anchor="middle" font-size="10" font-weight="700" '
                          f'font-family="ui-rounded, -apple-system, system-ui, sans-serif" fill="{color}">{text}</text></g>')

    def check(self, x, y, color, width=1.8, scale=1.0):
        s = scale
        self.parts.append(f'<path d="M{x - 3.5 * s} {y} L{x - 1 * s} {y + 2.6 * s} L{x + 3.5 * s} {y - 2.6 * s}" fill="none" '
                          f'stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>')

    def svg(self, label):
        self.defs.append(f'<clipPath id="{self.id("body")}"><path d="{body_path()}"/></clipPath>')
        self.defs.append(f'<clipPath id="{self.id("wing")}"><rect x="{L}" y="0" width="{HL - L}" height="{NH}"/></clipPath>')
        bar = (f'<rect width="{W}" height="{NH}" fill="#24596a"/><rect y="{NH}" width="{W}" height="12" fill="#121317"/>'
               f'<path d="{body_path()}" fill="#000"/>'
               f'<circle cx="{CX}" cy="{NH / 2}" r="3.2" fill="#0b0d14"/>')
        return (f'<svg viewBox="0 0 {W} {NH + 12}" role="img" aria-label="{label}" '
                f'style="display:block;width:100%;max-width:640px;height:auto;border-radius:10px;background:#121317">'
                f'<defs>{"".join(self.defs)}</defs>{bar}{"".join(self.parts)}</svg>')


def cos_deg(d):
    import math
    return math.cos(math.radians(d))


def sin_deg(d):
    import math
    return math.sin(math.radians(d))


def figure(svg, caption):
    return f'<figure class="docs-notch" style="margin:1.25rem 0">{svg}<figcaption style="margin-top:.5rem;font-size:.875em;opacity:.75">{caption}</figcaption></figure>'


def running():
    f = Fig("running")
    f.glow(RUN, 0.45)
    f.bar([1, 0.55, 0], RUN)
    f.more(2)
    f.orbit_ring(); f.core(RUN, halo=0.6); f.satellites([RUN] * 3, [4.2, 6, 9])
    return figure(f.svg("Running: three sessions orbit Relo's mark; the leading plan is two-thirds through its second step"),
                  "Running: three live sessions orbit the mark; the leading plan fills toward its glowing head; +2 more.")


def step():
    f = Fig("step")
    f.glow(RUN, 0.6, breathe="1;0.55;0.55;1")
    f.bar([1, 1, 0.08], RUN, flash=1)
    f.more(2)
    f.orbit_ring(); f.core(RUN, r=3.6, halo=1, dur="3.2s"); f.satellites([RUN] * 3, [4.2, 6, 9])
    f.beams(RUN)
    return figure(f.svg("A step finished: the step flashes, the mark pulses and violet beams rise"),
                  "A step finished: the step lights up, the mark pulses and violet beams rise from the centre.")


def needs():
    f = Fig("needs")
    f.glow(NEEDS, 0.55, breathe="1;0.7;1")
    f.rim(NEEDS, "0.3;0.7;0.3")
    f.chip("Answer", NEEDS, 50)
    f.orbit_ring(); f.rings(NEEDS); f.core(NEEDS, r=3.6, halo=1, dur="1.6s"); f.satellites([NEEDS, RUN, RUN], [4.2, 6, 9])
    f.beams(NEEDS, dur=2.8, until=0.68)
    return figure(f.svg("Needs you: the mark pulses coral with rings and coral beams repeat"),
                  "Needs you: the mark pulses coral and sends rings, the edge glows, and coral beams repeat until you answer.")


def turn():
    f = Fig("turn")
    f.glow(TURN, 0.45, breathe="1;0.8;1")
    f.chip("Your turn", TURN, 58)
    f.orbit_ring(); f.core(TURN, halo=0.4, dur="3.4s"); f.satellites([RUN, RUN], [6, 9])
    f.parts.append(f'<circle cx="{MX}" cy="{MY - OR}" r="5.5" fill="{TURN}" opacity="0.18"><animate attributeName="opacity" values="0.1;0.3;0.1" dur="3s" repeatCount="indefinite"/></circle>'
                   f'<circle cx="{MX}" cy="{MY - OR}" r="2.3" fill="{TURN}"/>')
    f.beams(TURN, dur=4.2, until=0.45)
    return figure(f.svg("Your turn: the session's satellite rests at the top in amber"),
                  "Your turn: the session's satellite glides to the top and rests there; amber beams rise once.")


def done():
    f = Fig("done")
    f.glow(DONE, 0.6, breathe="1;0.6;0.6;1")
    f.bar([1, 1, 1], DONE, width=42, live=False)
    f.check(R - OUTER - 5, MY, DONE)
    f.orbit_ring()
    f.parts.append(f'<circle cx="{MX}" cy="{MY}" r="5" fill="none" stroke="{DONE}" stroke-width="1.2" opacity="0" clip-path="url(#{f.id("wing")})">'
                   f'<animate attributeName="r" values="5;28;28" keyTimes="0;0.4;1" dur="3.4s" repeatCount="indefinite"/>'
                   f'<animate attributeName="opacity" values="0.7;0;0" keyTimes="0;0.4;1" dur="3.4s" repeatCount="indefinite"/></circle>')
    f.core(DONE, r=5.6, pulse=False, halo=0.8, dur="3.4s")
    f.check(MX + 0.1, MY - 0.1, "#000", width=1.4, scale=0.72)
    f.satellites([RUN, RUN], [6, 9])
    f.beams(DONE, dur=3.4, until=0.5)
    return figure(f.svg("Finished: the mark turns mint with a check; the plan is full"),
                  "Finished: the session spirals into the mark, which turns mint with a check; the plan sweeps full; mint beams rise.")


def failed():
    f = Fig("failed")
    f.glow(FAILED, 0.45)
    f.rim(FAILED, "0;0.9;0;0.7;0;0", dur="3.4s")
    shake = (f'<animateTransform attributeName="transform" type="translate" values="0 0;-3 0;3 0;-2 0;1 0;0 0;0 0" '
             f'keyTimes="0;0.05;0.1;0.15;0.2;0.25;1" dur="3.4s" repeatCount="indefinite"/>')
    f.chip("Failed", FAILED, 46, extra="")
    f.parts[-1] = f.parts[-1].replace("<g>", f"<g>{shake}", 1)
    f.orbit_ring(); f.core(FAILED, halo=0.5, dur="3.4s")
    f.parts.append(f'<circle cx="{MX}" cy="{MY}" r="5" fill="none" stroke="{FAILED}" stroke-opacity="0.8" stroke-width="1.2"/>')
    f.satellites([RUN, RUN], [6, 9])
    f.parts.append(f'<circle cx="{MX + 6}" cy="{MY + 5}" r="2.1" fill="{FAILED}">'
                   f'<animate attributeName="cy" values="{MY + 5};{MY + 5};{NH - 2.5};{NH - 2.5}" keyTimes="0;0.2;0.35;1" dur="3.4s" repeatCount="indefinite"/>'
                   f'<animate attributeName="opacity" values="1;1;1;0;0" keyTimes="0;0.2;0.35;0.55;1" dur="3.4s" repeatCount="indefinite"/></circle>')
    f.beams(FAILED, dur=3.4, until=0.45)
    return figure(f.svg("Failed: the session drops out of orbit, the chip shakes and the edge flashes red"),
                  "Failed: the session trembles and drops out of orbit, the edge flashes red twice and the chip shakes.")


def quiet():
    f = Fig("quiet")
    f.bar([1, 0.3, 0], QUIET, alpha=0.45, live=False)
    f.more(1, alpha=0.45)
    f.orbit_ring(); f.core(QUIET, pulse=False, halo=0); f.satellites([QUIET] * 2, [40, 55], alpha=0.45)
    return figure(f.svg("Quiet: nothing moved for a while; everything is dimmed and slow"),
                  "Quiet: nothing moved for a while, so the satellites slow to a crawl and everything dims.")


FIGS = {"running": running, "step": step, "needs": needs, "turn": turn, "done": done, "failed": failed, "quiet": quiet}

if __name__ == "__main__":
    # Rewrites every `<!-- notch-figure:KEY -->…<!-- /notch-figure -->` line of the page in place.
    import re
    page = sys.argv[1] if len(sys.argv) > 1 else "docs/site/concepts/notch.md"
    text = open(page).read()
    pattern = re.compile(r"<!-- notch-figure:(\w+) -->.*?<!-- /notch-figure -->")
    missing = set(FIGS) - set(pattern.findall(text))
    text = pattern.sub(lambda m: f"<!-- notch-figure:{m.group(1)} -->{FIGS[m.group(1)]()}<!-- /notch-figure -->", text)
    open(page, "w").write(text)
    if missing:
        print("notch-figures: no marker for " + ", ".join(sorted(missing)), file=sys.stderr)
