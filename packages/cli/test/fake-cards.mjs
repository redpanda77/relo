// An in-memory Relo that behaves like the server for cards and the questions folded into them.
import { randomUUID } from "node:crypto";

const DELIVERY = { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 };

export function fakeCards({ answer = "approved", answerAfterPolls = 1 } = {}) {
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
        prompt: body.prompt, state: "pending", expiresAt: new Date(Date.now() + 900_000).toISOString(), polls: 0 };
      questions.set(interaction.id, interaction);
      return { parentActivityId: id, companionActivityId: null, interaction: { ...interaction, polls: undefined },
        eventId: interaction.eventId, delivery: DELIVERY, queued: 1, deliveryMode: "queued_for_direct_apns", replayed: false };
    },
    async waitForInteraction(id) {
      const interaction = questions.get(id);
      interaction.polls += 1;
      if (interaction.polls >= answerAfterPolls) interaction.state = answer;
      return { interaction: { id, type: interaction.type, prompt: interaction.prompt, state: interaction.state } };
    },
    async listDevices() { return { devices: [] }; },
  };
  return { client, cards, calls };
}

export function cardDependencies(client, { env = {}, identity = { providerName: "Claude Code", project: "relo" } } = {}) {
  return {
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }),
    clientFactory: () => client,
    identityDefaults: () => identity,
    readStdinJson: async () => ({}),
    env,
    sleep: async () => {},
    prepareNotificationCommand: async ({ body }) => body,
    captureActivityCommand: async ({ body }) => ({ target: null, ifSequence: body.ifSequence }),
  };
}
