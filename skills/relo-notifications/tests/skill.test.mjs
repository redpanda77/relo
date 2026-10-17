import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateSkill } from "../scripts/validate-skill.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliSource = resolve(packageRoot, "..", "..", "packages", "cli", "src", "cli.mjs");
const read = (file) => readFileSync(join(packageRoot, file), "utf8");
// In the repo this file runs the CLI's own code: make the process as hermetic as the CLI suite (empty temp
// HOME, temp state folder, no background flusher), so a recipe never touches the developer's real state.
const hermeticEnv = resolve(packageRoot, "..", "..", "packages", "cli", "test", "hermetic-env.mjs");
if (existsSync(hermeticEnv)) await import(pathToFileURL(hermeticEnv).href);

function copy(t) {
  const temporary = mkdtempSync(join(tmpdir(), "relo-skill-test-"));
  const root = join(temporary, "relo-notifications");
  cpSync(packageRoot, root, { recursive: true });
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  return root;
}

test("the skill passes its structural validator", () => {
  assert.deepEqual(validateSkill(packageRoot).errors, []);
});

test("the validator catches the regressions it exists for", (t) => {
  const root = copy(t);
  const skill = join(root, "SKILL.md");
  writeFileSync(skill, readFileSync(skill, "utf8").replace("A yes/no answer is never permission.", "")
    + "\nrelo notify ask \"Ship?\" --text\n");
  const errors = validateSkill(root).errors.join("\n");
  assert.match(errors, /approval-only permission/);
  assert.match(errors, /removed .*notify ask/);
  assert.match(errors, /removed .*--text/);
});

test("the work is the default and notifications are the exception", () => {
  const skill = read("SKILL.md");
  assert.ok(skill.indexOf("relo work start") < skill.indexOf("relo notify"),
    "the first recipe an agent sees is the work");
  assert.match(skill, /One open work per session/);
  // ADR 0012: deliver ends a request and keeps the work, finish ends the goal; rounds, nesting, unfiltered output
  assert.match(skill, /relo work deliver --outcome/);
  assert.match(skill, /relo work start --round/);
  assert.match(skill, /`deliver`\s+closes the request you just did/);
  assert.match(skill, /--under s3/);
  // The plan belongs to the goal: deliver is refused with open steps; mid-plan owner checks are ask or --waiting
  assert.match(skill, /refused while top-level steps are open \(an owner check mid-plan is `ask` or `--waiting`\)/);
  assert.match(skill, /an answer or "go on"\s+continues the plan/);
  assert.match(skill, /--drop-rest/);
  assert.match(skill, /never `>\/dev\/null`, `tail`, `head` or `grep`/);
  const cards = read("references/cards.md");
  for (const echo of ["(open, started)", "(open, continuing)", "(open, updated)", "(paused, paused)", "(open, resumed)", "(finished, done)"]) {
    assert.ok(cards.includes(echo), `cards.md shows the ${echo} echo`);
  }
  assert.match(cards, /Parallel work \(subagents, several jobs\) is one step with a count/);
  assert.match(cards, /Finish exactly once/);
  assert.match(cards, /Without `--plan` the round carries the unfinished steps/);
  assert.match(read("references/cli.md"), /`--after sN`/);
  assert.match(cards, /Tappable answers only/);
});

test("safety rules keep approval exact and fail closed", () => {
  const skill = read("SKILL.md");
  assert.match(skill, /only after an `approval` question returns state `approved`/);
  assert.match(skill, /A yes\/no answer is never permission\./);
  assert.match(skill, /all mean\s+no/);
  assert.match(read("references/security.md"), /Never treat a yes\/no answer as\s+permission/);
});

test("every relo command in the skill is a valid command", { skip: !existsSync(cliSource) }, async (t) => {
  const { execute } = await import(pathToFileURL(cliSource).href);
  const { UsageError } = await import(pathToFileURL(resolve(dirname(cliSource), "shared", "errors.mjs")).href);
  // A server where this session's card is already running, as it is after the first recipe.
  const card = { id: "act_11111111-1111-4111-8111-111111111111", state: "active", sequence: 1,
    presentation: { components: [{ type: "steps", items: ["Build", "Test", "Deploy"].map((label) => ({ label })) }] } };
  const stub = new Proxy({}, { get: (_target, name) => name === "getActivity"
    ? async () => ({ activity: card }) : async () => ({}) });
  const sandbox = mkdtempSync(join(tmpdir(), "relo-skill-recipes-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const commands = ["SKILL.md", "references/cli.md", "references/cards.md"].flatMap((file) =>
    [...read(file).matchAll(/```bash\n([\s\S]*?)```/gu)].flatMap((block) => block[1]
      .replace(/\\\n\s*/gu, " ").split("\n")
      .map((line) => line.replace(/^\s*(?:if |then |fi\b.*)/u, "").replace(/;\s*then.*$/u, "").replace(/\s+#.*$/u, "").trim())
      .filter((line) => line.startsWith("relo ")))
      .map((line) => ({ file, line })));
  assert.ok(commands.length >= 10, "the skill shows real commands");
  for (const { file, line } of commands) {
    const argv = [...line.matchAll(/"([^"]*)"|(\S+)/gu)].map((match) => match[1] ?? match[2]).slice(1);
    try {
      await execute(argv, {
        loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }),
        clientFactory: () => stub, identityDefaults: () => ({ providerName: "Claude Code", project: "relo" }),
        prepareNotificationCommand: async ({ body }) => body,
        captureActivityCommand: async ({ body }) => ({ target: null, ifSequence: body.ifSequence }),
        readStdinJson: async () => ({}), sleep: async () => {}, readTextFile: async () => "callback-token-0123456789",
        env: { CLAUDE_CODE_SESSION_ID: "skill-recipe-session", XDG_STATE_HOME: join(sandbox, "state") },
        // A recipe line can never touch the real machine: config, pending sign-in, home and cwd are throwaway.
        home: sandbox, cwd: sandbox, configPath: () => join(sandbox, "config.json"),
        loadStoredConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), revision: "r" }),
        writeConfig: async () => {}, configRevision: async () => null,
        pendingLogin: { read: async () => null, write: async () => {}, clear: async () => {} },
      });
    } catch (error) {
      assert.ok(!(error instanceof UsageError), `${file}: ${line}\n  ${error.message}`);
    }
  }
});

test("SKILL.md stays small and carries the steps-vs-progress rule and the first-run flow", () => {
  const skill = read("SKILL.md");
  assert.ok(Buffer.byteLength(skill) <= 5_700, `SKILL.md is ${Buffer.byteLength(skill)} bytes`);
  assert.match(skill, /Parallel work is one step with a count/);
  assert.match(skill, /--progress 3\/20/);
  assert.match(skill, /relo work start --goal/);
  assert.match(skill, /## First run/);
  assert.match(skill, /relo auth login --wait/);
  assert.match(skill, /relo test/);
  assert.match(skill, /RELO_SESSION/);
  assert.match(skill, /Skill and block: `relo setup`/);
  assert.ok(Buffer.byteLength(skill) <= 5_750);
  assert.match(read("references/install.md"), /relo setup --agent codex/);
  assert.match(read("references/install.md"), /npx --yes skills@1\.5\.22 add redpanda77\/relo@relo-notifications/);
  assert.doesNotMatch(skill, /warns\s+when that note/);
  const install = read("references/install.md");
  assert.match(install, /the owner's command/i);
  assert.match(install, /relo uninstall --apply/);
  assert.match(install, /relo setup --refresh/);
  // The block's copies are the CLI's install/blocks/*.md; install.md only points at it.
  assert.doesNotMatch(install, /<!-- relo:start -->\n##/u);
  const blocksDir = resolve(packageRoot, "..", "..", "packages", "cli", "src", "install", "blocks");
  const block = ["heading", "reporting", "planning"].map((name) => readFileSync(resolve(blocksDir, `${name}.md`), "utf8")).join("\n");
  assert.ok(block.trimEnd().split("\n").length <= 20);
  assert.match(read("references/cards.md"), /generate 10 images, polish 20 chapters/);
  assert.match(block, /relo work start --goal/);
  assert.doesNotMatch(block, /relo activity|--steps\b|--topic\b/);
});

test("the skill version, its CLI dependency and the CLI agree", () => {
  const skill = JSON.parse(read("package.json"));
  const cli = JSON.parse(readFileSync(resolve(packageRoot, "..", "..", "packages", "cli", "package.json"), "utf8"));
  assert.equal(skill.version, cli.version);
  assert.equal(skill.reviewedToolingVersions["@relo/cli"], cli.version);
});
