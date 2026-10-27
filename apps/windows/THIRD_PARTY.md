# Third-party notices

## codenotch (MIT)

`src-tauri/src/win.rs` adapts the approach (not verbatim text) of `windows/codenotch/src/topmost.rs`
from https://github.com/vinzdg/codenotch: re-asserting `HWND_TOPMOST` with `SetWindowPos` from an
`EVENT_SYSTEM_FOREGROUND` hook plus a 30 second backstop, and carrying the HWND as a raw pointer
across `windows` crate versions. The pointer-polling click-through design in `src-tauri/src/main.rs`
follows the same project's idea.

    MIT License

    Copyright (c) 2026 Vinz

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## boring.notch (GPL-3.0): not used

Relo for Windows is not a fork of boring.notch (`apps/notch`, GPL-3.0). It is written from scratch for Windows, and no
boring.notch source, asset or text is in it. The notch sizes, corner radii and spring constants are numbers that make the
two apps look alike (`src/geometry.ts`): facts about Relo's design, not copied code. Nectar (GPL-3.0) was studied only;
nothing was copied from it. This is why the app is under the repository's licence, PolyForm Noncommercial 1.0.0
(`LICENSE`, `NOTICE`). Anything that would bring GPL code in belongs in `apps/notch`, not here.

## ptts (MIT OR Apache-2.0)

The Relo voice (`src-tauri/src/voice`) runs the Phonon 31M speech model through `ptts` 0.4.0, Gradium's Rust
runtime for it (https://github.com/gradium-ai/xn-ptts), used as a library and unmodified. It is dual-licensed
under the MIT licence or the Apache License 2.0, at our option; the texts are `LICENSE-MIT` and
`LICENSE-APACHE` in the crate. Its dependencies carry their own permissive licences, listed for each release
by `cargo tree`.

## Phonon 31M (Apache-2.0)

The voice model `gradium/phonon-31m-en` (revision `541f5752bc3c79583068bb205bfda5eb39aaa08a`) is made by
Gradium and licensed under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Relo does
not ship its files: the app downloads them from Hugging Face on an unmetered connection, checks their SHA-256
and keeps them under `%LOCALAPPDATA%\Relo\Voices`. The model is used unmodified.

## rodio, cpal and ureq (MIT OR Apache-2.0; Apache-2.0)

`rodio` 0.21 (https://github.com/RustAudio/rodio, MIT OR Apache-2.0, Copyright 2015 Pierre Krieger and
contributors) plays the voice's audio, on top of `cpal` (https://github.com/RustAudio/cpal, Apache-2.0).
`ureq` (MIT OR Apache-2.0) fetches the model files. Their licence texts ship with the crates.

## Relo's sounds

The 19 cues in `public/sounds` are Relo's own set (scripts/sounds, docs/SOUND.md), the same files the Mac and
iPhone apps play; no third-party samples.
