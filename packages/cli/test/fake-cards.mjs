// An in-memory Relo that behaves like the server for cards and the questions folded into them.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, harnessFor } from "../src/harness/catalog.mjs";

const DELIVERY = { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 };

export function fakeCards({ answer = "approved", answerAfterPolls = 1, response = undefined } = {}) {
  const cards = new Map();
  const questions = new Map();
  const calls = [];
  const byTarget = (target) => cards.get(target)
    ?? [...cards.values()].filter((card) => card.key === target).at(-1);
  const client = {
    async startActivity(body, key) {
      calls.push({ op: "start", body, key });
      const running = body.key ? [...cards.values()].find((card) => card.key === body.key && card.state === "active") : null;
      if (running) {
        Object.assign(running, { title: body.title, status: body.status });
        return { activity: { ...running }, delivery: DELIVERY, reused: true };
      }
      const card = { id: `act_${randomUUID()}`, key: body.key ?? null, state: "active", sequence: 0,
        title: body.title, status: body.status, context: body.context };
      cards.set(card.id, card);
      return { activity: { ...card }, delivery: DELIVERY };
    },
    async getActivity(target) {
      calls.push({ op: "get", target });
      const card = byTarget(target);
      if (!card) throw Object.assign(new Error("not_found"), { status: 404, code: "NOT_FOUND" });
      return { activity: { ...card } };
    },
    async updateActivity(target, body, key) {
      calls.push({ op: "update", target, body, key });
      const card = byTarget(target);
      Object.assign(card, body, { sequence: card.sequence + 1 });
      return { activity: { ...card }, delivery: DELIVERY };
    },
    async endActivity(target, body, key) {
      calls.push({ op: "end", target, body, key });
      const card = byTarget(target);
      Object.assign(card, { state: "ended", status: body.status });
      return { activity: { ...card }, delivery: DELIVERY };
    },
    async createActivityWait(id, body, key) {
      calls.push({ op: "ask", id, body, key });
      const interaction = { id: `int_${randomUUID()}`, eventId: `ntf_${randomUUID()}`, type: body.type,
        prompt: body.prompt, ...(body.options ? { options: body.options } : {}), state: "pending", expiresAt: new Date(Date.now() + 900_000).toISOString(), polls: 0 };
      questions.set(interaction.id, interaction);
      return { parentActivityId: id, companionActivityId: null, interaction: { ...interaction, polls: undefined },
        eventId: interaction.eventId, delivery: DELIVERY, queued: 1, deliveryMode: "queued_for_direct_apns", replayed: false };
    },
    // A question with no card running: a standalone message with answer buttons (it never makes a card).
    async createInteraction(body, key) {
      calls.push({ op: "question", body, key });
      const interaction = { id: `int_${randomUUID()}`, type: body.type, prompt: body.prompt, state: "pending", polls: 0 };
      questions.set(interaction.id, interaction);
      return { interaction: { id: interaction.id, type: body.type, prompt: body.prompt, state: "pending" }, delivery: DELIVERY };
    },
    async waitForInteraction(id) {
      const interaction = questions.get(id);
      interaction.polls += 1;
      if (interaction.polls >= answerAfterPolls) interaction.state = answer;
      const answered = interaction.state !== "pending" && response !== undefined ? { response } : {};
      return { interaction: { id, type: interaction.type, prompt: interaction.prompt, state: interaction.state, ...answered } };
    },
    async listDevices() { return { devices: [] }; },
  };
  return { client, cards, calls };
}

export function cardDependencies(client, { env = {}, identity = { providerName: "Claude Code", project: "relo" } } = {}) {
  return {
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }),
    clientFactory: () => noRunningCards(client),
    identityDefaults: () => identity,
    readStdinJson: async () => ({}),
    env,
    // POSIX by default: the hook commands setup writes are `relo hook ...` there; a test of Windows passes platform "win32".
    platform: "linux",
    sleep: async () => {},
    prepareNotificationCommand: async ({ body }) => body,
    captureActivityCommand: async ({ body }) => ({ target: null, ifSequence: body.ifSequence }),
  };
}

/** A throwaway home folder, optionally with the Relo block and a skill copy at a version. Tests never touch the real one. */
/** Every harness that can be installed: for tests that name their agents and are not about detection. */
export const EVERY_HARNESS = () => HARNESSES.filter((harness) => harness.installation).map((harness) => harness.id);

/** Makes harnesses "installed" under a fake home the way a real one is: a program of theirs on the owner's path (~/.local/bin), an app folder for an app. */
export function installHarnesses(home, ids) {
  mkdirSync(join(home, ".npm-global", "bin"), { recursive: true });
  for (const id of ids) {
    const { binaries = [], apps = [] } = harnessFor(id).installation;
    if (binaries.length) writeFileSync(join(home, ".npm-global", "bin", binaries[0]), "#!/bin/sh\n", { mode: 0o755 });
    else mkdirSync(join(home, "Applications", apps[0]), { recursive: true });
  }
}

export async function fakeHome({ block = false, skillVersion, agents = [".claude", ".codex"], installed = [] } = {}) {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "relo-home-"));
  if (installed.length) installHarnesses(home, installed);
  for (const agent of agents) await mkdir(join(home, agent), { recursive: true });
  // block: true writes the block relo setup writes now; "stale" an older one.
  if (block) {
    const { DEPTHS, renderBlock } = await import("../src/install/block.mjs");
    await writeFile(join(home, ".claude", "CLAUDE.md"), block === "stale" ? "<!-- relo:start -->\nold\n<!-- relo:end -->\n" : `${renderBlock(DEPTHS.track).join("\n")}\n`);
  }
  if (skillVersion !== undefined) {
    const skill = join(home, ".agents", "skills", "relo-notifications");
    const { VERSION } = await import("../src/version.mjs");
    if (skillVersion === VERSION) {
      // The current skill is the one this CLI carries, file for file.
      const { cp } = await import("node:fs/promises");
      const { bundledSkillDirectory } = await import("../src/install/skill.mjs");
      await cp(bundledSkillDirectory(), skill, { recursive: true, filter: (path) => !/\/(tests|node_modules)(\/|$)/u.test(path) });
      return home;
    }
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "package.json"), JSON.stringify({ name: "relo-notifications", version: skillVersion }));
    await writeFile(join(skill, "SKILL.md"), "---\nname: relo-notifications\n---\n");
  }
  return home;
}

/** A test client that answers "no such card" for any card it was not given: nothing is running yet. */
export function noRunningCards(client) {
  if (!client || typeof client !== "object") return client;
  const missing = async () => { throw Object.assign(new Error("not_found"), { status: 404, code: "NOT_FOUND" }); };
  return new Proxy(client, { get: (target, name) => (name === "getActivity" && !(name in target) ? missing : target[name]) });
}
