// The instruction block relo setup writes is assembled from modules (src/install/blocks/): short, pointing at the
// skill for detail, copied nowhere, named in its own start marker, and the block in this repository's own CLAUDE.md is
// exactly the rendering for the modules that marker names.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEPTHS, MODULES, blockModules, depthOf, normalizeModules, planBlock, renderBlock, renderBlockText } from "../src/install/block.mjs";
import { UsageError } from "../src/shared/errors.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const block = (level) => renderBlock(DEPTHS[level]).join("\n");

test("every depth's block stays short: at most 20 lines and 3,000 bytes; every module line quotes a command or flag", () => {
  for (const level of Object.keys(DEPTHS)) {
    const lines = renderBlock(DEPTHS[level]);
    assert.ok(lines.length <= 20, `${level}: ${lines.length} lines`);
    const text = renderBlockText(DEPTHS[level]);
    assert.ok(Buffer.byteLength(text) <= 3_000, `${level}: ${Buffer.byteLength(text)} bytes: trim a line before adding one`);
    assert.doesNotMatch(text, /\d+\.\d+\.\d+|20\d\d-\d\d/u, "no versions or dates: tracked files must not churn");
  }
  for (const name of MODULES.filter((module) => module !== "efficiency")) {
    // Prose lines that introduce a list (reporting's first) carry no command; every bullet does.
    for (const line of renderBlockText([name]).split("\n").slice(1).filter((candidate) => candidate.startsWith("- "))) {
      assert.match(line, /`(relo |--)[^`]+`|relo-notifications skill/u, `${name}: ${line}`);
    }
  }
});

test("the block per depth: marker names the modules, heading, modules in order, end marker", () => {
  assert.equal(renderBlock(DEPTHS.guide)[0], "<!-- relo:start reporting planning continuity -->");
  assert.equal(renderBlock(DEPTHS.notify)[0], "<!-- relo:start notify -->");
  const optimize = renderBlock(DEPTHS.optimize);
  assert.equal(optimize[1], "## Relo (live status where the owner sees it: their iPhone or the Mac's notch)");
  assert.match(optimize[2], /^Relo is installed and signed in: use it now\./u, "every block says Relo is ready to use");
  assert.match(block("notify"), /only when a relo command fails/u);
  assert.equal(optimize.at(-1), "<!-- relo:end -->");
  const text = optimize.join("\n");
  const at = ["For work longer", "Size the plan", "A heavy session", "Give every subagent"].map((needle) => text.indexOf(needle));
  assert.deepEqual([...at].sort((a, b) => a - b), at, "reporting, planning, continuity, efficiency in order");
  assert.ok(!block("track").includes("A heavy session"), "continuity belongs to guide");
  assert.ok(!block("notify").includes("relo work start"), "notify teaches no cards");
});

test("the marker round trip: modules read back, depthOf names the depth, a bare marker is track", () => {
  for (const level of Object.keys(DEPTHS)) {
    assert.deepEqual(blockModules(block(level)), DEPTHS[level]);
    assert.equal(depthOf(blockModules(block(level))), level);
  }
  assert.equal(depthOf(["reporting", "continuity"]), "custom");
  assert.deepEqual(blockModules("<!-- relo:start -->\nold\n<!-- relo:end -->\n"), ["reporting", "planning"]);
  assert.deepEqual(blockModules("nothing here\n"), []);
});

test("--refresh re-renders each block at its own depth; a bare marker becomes track; a given depth rewrites it", () => {
  const guide = `# Mine\n\n${block("guide").split("\n")[0]}\nstale\n<!-- relo:end -->\n`;
  const refreshed = planBlock(guide);
  assert.equal(refreshed.action, "updated");
  assert.ok(refreshed.content.includes(block("guide")) && refreshed.content.startsWith("# Mine\n"));
  assert.equal(planBlock(refreshed.content).action, "unchanged");
  const bare = planBlock("<!-- relo:start -->\nold\n<!-- relo:end -->\n");
  assert.ok(bare.content.includes(block("track")));
  const deeper = planBlock(refreshed.content, { modules: DEPTHS.optimize });
  assert.ok(deeper.content.includes(block("optimize")));
  assert.equal(planBlock(refreshed.content, { modules: DEPTHS.optimize, keepModules: true }).action, "unchanged");
  assert.ok(planBlock("<!-- relo:start reporting -->\nx\n<!-- relo:keep -->\n<!-- relo:end -->\n", { modules: DEPTHS.guide }).action === "kept");
});

test("notify and reporting exclude each other and an unknown module is refused", () => {
  assert.throws(() => normalizeModules(["notify", "reporting"]), UsageError);
  assert.throws(() => normalizeModules(["nope"]), /Unknown module "nope"/u);
  assert.throws(() => renderBlock([]), UsageError);
  assert.deepEqual(normalizeModules(["planning", "reporting", "planning"]), ["reporting", "planning"]);
});

test("no line of the block is copied into the skill or the help", () => {
  const files = [join(REPO, "packages/cli/src/help.mjs"),
    ...readdirSync(join(REPO, "skills/relo-notifications"), { recursive: true }).filter((name) => name.endsWith(".md"))
      .map((name) => join(REPO, "skills/relo-notifications", name))];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const line of MODULES.map((name) => renderBlockText([name])).join("\n").split("\n").filter((candidate) => candidate.length > 40)) {
      assert.ok(!text.includes(line), `${file} copies: ${line.slice(0, 60)}…`);
    }
  }
});

// The private repository's CLAUDE.md is not part of the public export, so the check runs only where it exists.
test("this repository's CLAUDE.md carries no Relo block: the user-level block loads in every project, a copy would load twice", { skip: !existsSync(join(REPO, "CLAUDE.md")) && "no CLAUDE.md in this checkout" }, () => {
  assert.deepEqual(blockModules(readFileSync(join(REPO, "CLAUDE.md"), "utf8")), []);
});
