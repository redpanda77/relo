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

test("the card is the default and notifications are the exception", () => {
  const skill = read("SKILL.md");
  assert.ok(skill.indexOf("relo activity start") < skill.indexOf("relo notify"),
    "the first recipe an agent sees is the card");
  assert.match(skill, /One card per agent/);
  const cards = read("references/cards.md");
  assert.match(cards, /completed outer phases \/ total outer phases/);
  assert.match(cards, /Steps and progress answer different questions/);
  assert.match(cards, /End exactly once/);
  assert.match(cards, /Tappable answers only/);
});

test("safety rules keep approval exact and fail closed", () => {
  const skill = read("SKILL.md");
  assert.match(skill, /only after an `approval` question returns state `approved`/);
  assert.match(skill, /A yes\/no answer is never permission\./);
  assert.match(skill, /all mean\s+no/);
  assert.match(read("references/security.md"), /Never treat a yes\/no answer as\s+permission/);
});

test("every relo command in the skill is a valid command", { skip: !existsSync(cliSource) }, async () => {
  const { execute } = await import(pathToFileURL(cliSource).href);
  const { UsageError } = await import(pathToFileURL(resolve(dirname(cliSource), "errors.mjs")).href);
  // A server where this session's card is already running, as it is after the first recipe.
  const card = { id: "act_11111111-1111-4111-8111-111111111111", state: "active", sequence: 1,
    presentation: { components: [{ type: "steps", items: ["Build", "Test", "Deploy"].map((label) => ({ label })) }] } };
  const stub = new Proxy({}, { get: (_target, name) => name === "getActivity"
    ? async () => ({ activity: card }) : async () => ({}) });
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
        env: { CLAUDE_CODE_SESSION_ID: "skill-recipe-session" },
      });
    } catch (error) {
      assert.ok(!(error instanceof UsageError), `${file}: ${line}\n  ${error.message}`);
    }
  }
});
