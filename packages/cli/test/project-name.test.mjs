// The project a card is filed under: --project, else RELO_PROJECT, else the nearest of a folder named with
// `relo project NAME` and the git repository, else the signed-in integration, else the folder's own name.
// Never a made-up or product name: a card from a plain folder is that folder's.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { noRunningCards } from "./fake-cards.mjs";
import { detectIdentityDefaults, fallbackProject, projectLabel } from "../src/shared/identity.mjs";
import { folderName, namedPlace } from "../src/shared/repo.mjs";
import { run } from "../src/cli.mjs";
import { EXIT } from "../src/shared/errors.mjs";

const HOME = "/home/sam";
const REPO = "/home/sam/code/acme-app";
const PLAIN = "/home/sam/code";
// Only the repository has a .git folder; nothing else on this fake disk does.
const exists = (path) => path === `${REPO}/.git`;

async function cli(argv, dependencies) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, dependencies);
  return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

/** A notify send through the whole CLI, returning the context it sent. */
async function sentContext(argv, { cwd, identity = {}, config = {} }) {
  const bodies = [];
  const client = { sendNotification: async (body) => { bodies.push(body); return { delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 } }; } };
  const result = await cli(["notify", "send", "Ready", "--source", "Claude Code", "--topic", "Storage cleanup", ...argv], {
    env: {}, cwd, home: HOME, identityDefaults: () => identity, computerName: () => "Build Mac",
    prepareNotificationCommand: async ({ body }) => body,
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), ...config }),
    clientFactory: () => noRunningCards(client),
  });
  assert.equal(result.exitCode, EXIT.OK, JSON.stringify(result.line));
  return bodies[0].context;
}

test("in a git repository the project is the repository's name, from any folder inside it", () => {
  assert.equal(projectLabel({}, REPO, exists), "acme-app");
  assert.equal(projectLabel({}, `${REPO}/src/deep`, exists), "acme-app");
  assert.equal(detectIdentityDefaults({}, `${REPO}/src`, exists).project, "acme-app");
});

test("in a plain folder the project is the folder's own name, never a product name", async () => {
  assert.equal(projectLabel({}, PLAIN, exists), undefined);
  assert.equal(fallbackProject(undefined, { cwd: PLAIN, home: HOME }), "code");
  assert.equal(folderName(HOME, HOME), "Home");
  // Through the CLI: nothing detected, so the folder names it.
  assert.equal((await sentContext([], { cwd: "/home/sam/Documents/GitHub" })).project, "GitHub");
  // A signed-in integration (a named profile) still names an app's work before the folder does.
  assert.equal((await sentContext([], { cwd: PLAIN, config: { profile: "deploy-bot" } })).project, "deploy-bot");
});

test("--project and RELO_PROJECT override every detected name", async () => {
  assert.equal((await sentContext(["--project", "Storage"], { cwd: PLAIN })).project, "Storage");
  assert.equal((await sentContext(["--project", "Storage"], { cwd: REPO, identity: { project: "acme-app" } })).project, "Storage");
  assert.equal(projectLabel({ RELO_PROJECT: "Ops" }, REPO, exists, { [REPO]: "Acme" }), "Ops");
});

test("a name saved for a folder is used from it and its subfolders; the nearest place wins", () => {
  const names = { [PLAIN]: "Workspace" };
  assert.equal(projectLabel({}, PLAIN, exists, names), "Workspace");
  assert.equal(projectLabel({}, `${PLAIN}/scratch`, exists, names), "Workspace");
  // A repository inside a named folder keeps its own name; a name saved for the repository replaces it.
  assert.equal(projectLabel({}, `${REPO}/src`, exists, names), "acme-app");
  assert.equal(projectLabel({}, `${REPO}/src`, exists, { ...names, [REPO]: "Acme" }), "Acme");
  assert.deepEqual(namedPlace(`${REPO}/src`, { exists, names: { [REPO]: "Acme" } }), { name: "Acme", via: "config", root: REPO });
});

test("relo project NAME saves the name in Relo's config for this folder, and --clear removes it", async () => {
  const state = { config: { apiUrl: "https://relo.example", token: "x".repeat(44), revision: "r1" }, writes: [] };
  const deps = (cwd) => ({
    env: {}, cwd, home: HOME, computerName: () => "Build Mac",
    configPath: () => "/cfg/c.json",
    loadStoredConfig: async () => state.config,
    loadProjects: () => state.config.projects ?? {},
    writeConfig: async (_path, config) => { state.writes.push(config); state.config = { ...state.config, ...config }; },
  });
  assert.deepEqual((await cli(["project"], deps(PLAIN))).line, { ok: true, project: "code", via: "folder" });
  const saved = await cli(["project", "Workspace"], deps(PLAIN));
  assert.deepEqual(saved.line, { ok: true, project: "Workspace", via: "config", saved: true });
  assert.deepEqual(state.config.projects, { [PLAIN]: "Workspace" });
  // From a subfolder, the saved folder is renamed rather than a second entry added.
  await cli(["project", "Scratch space"], deps(`${PLAIN}/scratch`));
  assert.deepEqual(state.config.projects, { [PLAIN]: "Scratch space" });
  const cleared = await cli(["project", "--clear"], deps(PLAIN));
  assert.equal(cleared.line.cleared, true);
  assert.deepEqual(state.config.projects, {});
  assert.equal((await cli(["project", "a", "b"], deps(PLAIN))).exitCode, EXIT.USAGE);
});
