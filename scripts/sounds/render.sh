#!/usr/bin/env bash
# Relo's sound set (ADR 0013): every cue composed from earshot's bank by scripts/sounds/library.py (the Notch Sound
# Bench's codes; earshot pinned with the launch film's environment, marketing/films/setup.sh), checked, and written for
# each surface:
#   apps/notch/boringNotch/Resources/Sounds/<cue>.caf   Relo for Mac (a build phase copies the folder into the app)
#   apps/ios/Sources/ReloApp/Assets.xcassets/<cue>.dataset/<cue>.caf   the iPhone app's six cues, as asset-catalog data
#                                                        sets (pushes name them in "sound"; the app copies them to Library/Sounds)
#   apps/dashboard/src/assets/sounds/<cue>.m4a           the Dashboard (its six cues; the rest are the Mac's)
# The voice is never rendered here: Relo for Mac speaks each line live with its own TTS.
# Usage: scripts/sounds/render.sh   (needs marketing/films's .venv: bash marketing/films/setup.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="$ROOT/marketing/films/.venv"
[[ -x "$VENV/bin/earshot" ]] || { echo "no earshot: bash marketing/films/setup.sh" >&2; exit 1; }
WORK="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$WORK"' EXIT
STEP="$ROOT/scripts/step.mjs"

# The owner approves every sound on the Notch Sound Bench first (library.py builds it); only approved codes go here.
# cue  source: a library code (loudness set by its tier there; a pair side is <pair>.<side>) or an earshot bank id  length(s or -)  LUFS (bank ids)
CUES="
needs-you   ASK-05                         -    -
your-turn   TRN-16                         -    -
done        DON-H                          -    -
failed      ERR-13                         -    -
sent        ACK-S                          -    -
linked      LNK-O                          -    -
start       STR-06                         -    -
update      UPD-P                          -    -
open        NCH-B.open                     -    -
close       NCH-B.close                    -    -
expand      CRD-B.expand                   -    -
collapse    CRD-B.collapse                 -    -
tab         TAB-11                         -    -
section     SEC-11                         -    -
on          TGL-02.on                      -    -
off         TGL-02.off                     -    -
launch      LCH-01                         -    -
quit        QUT-01                         -    -
turn        fit/whoosh.short/bamboo_swish  -    -28
"

node "$STEP" --name "compose library" --timeout 3m --quiet 2m -- "$VENV/bin/python" "$ROOT/scripts/sounds/library.py" "$WORK/lib" >/dev/null
node "$STEP" --name "compose studio" --timeout 3m --quiet 2m -- "$VENV/bin/python" "$ROOT/scripts/sounds/studio.py" "$WORK/studio" >/dev/null

while read -r cue id dur lufs; do
  [[ -n "$cue" ]] || continue
  # SLOT-NN codes come from studio.py (docs/SOUND.md), SLOT-X codes from the older library.py.
  if [[ "$id" =~ ^[A-Z]{3}-[0-9]{2}(\.[a-z]+)?$ ]]; then cp "$WORK/studio/$id.wav" "$WORK/$cue.wav"; echo "$cue: $id"; continue; fi
  if [[ "$id" =~ ^[A-Z]{3}-[A-Z](\.[a-z]+)?$ ]]; then cp "$WORK/lib/$id.wav" "$WORK/$cue.wav"; echo "$cue: $id"; continue; fi
  args=(sfx render "$id" --sr 48000 -o "$WORK/$cue.raw.wav")
  [[ "$dur" == - ]] || args+=(--dur "$dur")
  node "$STEP" --name "render $cue" --timeout 2m --quiet 2m -- "$VENV/bin/earshot" --threads 2 "${args[@]}" >/dev/null
  # Loudness-matched, with a 20 ms fade-out so a trimmed tail never clicks; peaks kept under -1 dBFS.
  "$VENV/bin/python" - "$WORK/$cue.raw.wav" "$WORK/$cue.wav" "$lufs" <<'PY'
import sys, numpy as np, soundfile as sf, pyloudnorm as pyln
src, dst, target = sys.argv[1], sys.argv[2], float(sys.argv[3])
data, rate = sf.read(src, always_2d=True)
loud = pyln.Meter(rate, block_size=min(0.4, len(data) / rate * 0.99)).integrated_loudness(data)
data = pyln.normalize.loudness(data, loud, target)
fade = int(rate * 0.02); data[-fade:] *= np.linspace(1, 0, fade)[:, None]
peak = np.abs(data).max(); data = data * min(1, 10 ** (-1 / 20) / peak) if peak > 0 else data
sf.write(dst, data.astype(np.float32), rate, subtype="PCM_24")
print(f"{dst.split('/')[-1]}: {loud:.1f} -> {target} LUFS")
PY
done <<< "$CUES"

FINAL=(); for f in "$WORK"/*.wav; do [[ "$f" == *.raw.wav ]] || FINAL+=("$f"); done
node "$STEP" --name "sfx check" --timeout 3m --quiet 2m -- "$VENV/bin/earshot" --threads 2 sfx check "${FINAL[@]}" || true

MAC="$ROOT/apps/notch/boringNotch/Resources/Sounds"; IOS="$ROOT/apps/ios/Sources/ReloApp/Assets.xcassets"; WEB="$ROOT/apps/dashboard/src/assets/sounds"
mkdir -p "$MAC" "$WEB"
for f in "$WORK"/*.wav; do
  name="$(basename "$f" .wav)"; [[ "$name" == *.raw ]] && continue
  afconvert -f caff -d LEI16@48000 "$f" "$MAC/$name.caf"
  case "$name" in needs-you|your-turn|done|failed|sent|linked)
    # The iPhone's cue is an asset-catalog data set: the file plus its Contents.json.
    mkdir -p "$IOS/$name.dataset"; cp "$MAC/$name.caf" "$IOS/$name.dataset/$name.caf"
    printf '{\n  "data" : [\n    {\n      "filename" : "%s.caf",\n      "idiom" : "universal",\n      "universal-type-identifier" : "com.apple.coreaudio-format"\n    }\n  ],\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n' "$name" > "$IOS/$name.dataset/Contents.json" ;;
  esac
  case "$name" in needs-you|your-turn|done|failed|sent|linked) afconvert -f m4af -d aac -b 96000 "$f" "$WEB/$name.m4a" ;; esac
done
echo "sounds: $(ls "$MAC" | wc -l | tr -d ' ') cues for the Mac; the iPhone and the Dashboard take their six"
