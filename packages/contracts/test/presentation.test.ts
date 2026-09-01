import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseLiveActivityPresentation,
  projectLiveActivityPresentationPrivacy,
  projectLiveActivityPresentationToActivityKitContentState,
  stableSerializeLiveActivityPresentation,
} from "../src/index.js";

const fixture = JSON.parse(await readFile(
  new URL("../fixtures/presentation.json", import.meta.url), "utf8",
)) as { canonical: unknown };

test("the current presentation contract parses and serializes deterministically", () => {
  const parsed = parseLiveActivityPresentation(fixture.canonical);
  assert.equal(parsed.components.length, 2);
  assert.equal(
    stableSerializeLiveActivityPresentation(parsed),
    stableSerializeLiveActivityPresentation(JSON.parse(JSON.stringify(parsed))),
  );
});

test("versioned presentation envelopes are rejected instead of normalized", () => {
  assert.throws(() => parseLiveActivityPresentation({
    ...(fixture.canonical as Record<string, unknown>),
    version: 3,
  }));
});

test("unknown compatibility fields are rejected", () => {
  assert.throws(() => parseLiveActivityPresentation({
    ...(fixture.canonical as Record<string, unknown>),
    fallback: { presentationVersion: 2, visualComponentId: null },
  }));
});

test("ActivityKit projection carries only the current component graph", () => {
  const projected = projectLiveActivityPresentationToActivityKitContentState(fixture.canonical);
  assert.equal(JSON.parse(projected.componentsJson).length, 2);
  assert.equal(projected.title, "Release planning");
});

test("private presentation projection removes content and actions", () => {
  const projected = projectLiveActivityPresentationPrivacy({
    ...(fixture.canonical as Record<string, unknown>),
    privacy: "private",
  });
  assert.equal(projected.content.title, "Private activity");
  assert.deepEqual(projected.components, []);
  assert.equal(projected.behavior.type, "informational");
});
