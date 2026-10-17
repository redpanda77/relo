// Concurrent async hooks of one session never lose an event: each journals its event, and the hook that
// holds the lock folds every journaled event, in order, into the one state file.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordObservedEvent } from "../src/harness/core/session-state.mjs";

const SESSION = "sessionAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// A fold that counts: every entry adds its own number, so a lost or doubled event shows in the total.
const fold = async (previous, entries) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return { state: { v: 1, session: SESSION, seen: [...(previous?.seen ?? []), ...entries.map((entry) => entry.n)] } };
};
const stateOf = async (directory) => JSON.parse(await readFile(join(directory, `${SESSION.slice(0, 32)}.json`), "utf8"));

test("forty concurrent hooks: every event is folded exactly once, in the order it was journaled per writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-journal-"));
  const outcomes = await Promise.all(Array.from({ length: 40 }, (_, n) => recordObservedEvent(directory, SESSION, { n }, fold)));
  // A hook that missed the lock left its event for a later fold; one more event drains anything still waiting.
  await recordObservedEvent(directory, SESSION, { n: 40 }, fold);
  const { seen } = await stateOf(directory);
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 41 }, (_, n) => n), "no event lost, none twice");
  assert.ok(outcomes.some((outcome) => outcome.state), "someone folded");
  assert.equal(existsSync(join(directory, `${SESSION.slice(0, 32)}.json.journal`)), false, "the journal is drained");
});

test("a fold that crashed leaves its entries in .draining; the next hook folds them first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-journal-"));
  const base = join(directory, `${SESSION.slice(0, 32)}.json`);
  await writeFile(`${base}.journal.draining`, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`);
  await recordObservedEvent(directory, SESSION, { n: 3 }, fold);
  assert.deepEqual((await stateOf(directory)).seen, [1, 2, 3]);
  assert.equal(existsSync(`${base}.journal.draining`), false);
});

test("an entry larger than 1 KiB is refused before anything is written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-journal-"));
  await assert.rejects(recordObservedEvent(directory, SESSION, { pad: "x".repeat(2_000) }, fold), /too large/u);
  assert.equal(existsSync(join(directory, `${SESSION.slice(0, 32)}.json.journal`)), false);
});
