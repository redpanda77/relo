import "./hermetic-env.mjs";
// The terminal QR code of a sign-in link (shared/qr.mjs). Decoding was checked against Apple's CoreImage detector for
// versions 1 to 10; these tests pin the structure every reader relies on.
import assert from "node:assert/strict";
import test from "node:test";
import { qrModules, qrText } from "../src/shared/qr.mjs";

const LINK = "https://relo.example/cli/authorize?code=AQND-M6L2";

function finderAt(modules, x0, y0) {
  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      assert.equal(modules[y0 + y][x0 + x], ring !== 2, `finder at ${x0},${y0}: ${x},${y}`);
    }
  }
}

test("a sign-in link is a version 4 code (33 modules) with the three finder patterns and timing lines", () => {
  const modules = qrModules(LINK);
  assert.equal(modules.length, 33);
  finderAt(modules, 0, 0);
  finderAt(modules, 26, 0);
  finderAt(modules, 0, 26);
  for (let i = 8; i < 25; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0);
    assert.equal(modules[i][6], i % 2 === 0);
  }
  assert.equal(modules[33 - 8][8], true, "the dark module");
});

test("the version grows with the text; past 213 bytes there is no code", () => {
  assert.equal(qrModules("a").length, 21);
  assert.equal(qrModules("x".repeat(213)).length, 57);
  assert.equal(qrModules("x".repeat(214)), undefined);
  assert.equal(qrText("x".repeat(214)), undefined);
});

test("the terminal drawing packs two rows per line inside a quiet zone, the same every time", () => {
  const text = qrText(LINK);
  const lines = text.split("\n");
  assert.equal(lines.length, Math.ceil((33 + 4) / 2));
  assert.ok(lines.every((line) => line.length === 37 && /^[█▀▄ ]+$/u.test(line)));
  assert.equal(lines[0], "█".repeat(37), "the quiet zone is light");
  assert.equal(qrText(LINK), text);
});
