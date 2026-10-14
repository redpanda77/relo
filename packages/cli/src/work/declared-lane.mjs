// The declared lane of the outbox (EDGE.3, ADR 0008 principle 13). Every declared write of `relo work`
// carries an idempotency key. Before a write the lane is flushed (short budget) so order is kept; when the
// lane still holds items, or the write fails on the network, the write is queued behind them and the
// command succeeds locally. A queued write replays with its first key, so a write that did reach the
// server before the network failed answers with the first result instead of applying twice.
//
// An entry body is { v: 1, harness, seal, readable, sealedForm?, opaque?, withContext?, card?, copy? } (sealed when it is sent,
// for the phones trusted then) or { v: 1, harness, final } (already sealed; replayed byte for byte).
import { EXIT, NetworkError } from "../errors.mjs";
import { enqueue, flush, outboxDirectory, pending, serverOrigin } from "../outbox/index.mjs";
import { sealingUnavailable } from "../seal-notice.mjs";
import { workSealer } from "./seal-work.mjs";
import { worksClient } from "./works-client.mjs";

export const QUEUED_NOTE = "Queued: sends with the next relo command";
export const DRAIN_BUDGET_MS = 3_000;

const withoutBase = (body) => {
  if (!body || body.baseVersion === undefined) return body;
  const { baseVersion: _, ...rest } = body;
  return rest;
};

export function declaredDirectory(dependencies) {
  if (dependencies?.outboxDirectory) return dependencies.outboxDirectory;
  const env = dependencies?.env ?? process.env;
  // An injected env without a state folder falls back to the process's (tests keep theirs isolated there).
  const state = env.XDG_STATE_HOME?.trim() ? env : { ...env, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  return outboxDirectory({ env: state, ...(dependencies?.home ? { home: dependencies.home } : {}) });
}

/** A failure that says nothing about the write itself: the server was not reached. */
export function offline(error) {
  if (!error) return false;
  if (error instanceof NetworkError || error.code === "NETWORK_ERROR" || error.exitCode === EXIT.NETWORK) return true;
  return error.code === "E2EE_UNAVAILABLE" && offline(error.cause);
}

/**
 * The request body of a write. `seal`: "auto" seals when this computer has a phone to seal for (a start),
 * "always" for a sealed work (fails closed without a phone), "never" for a readable work.
 */
export async function materialize(form, sealer) {
  if (form.final) return form.final;
  if (form.seal === "never" || !form.sealedForm) return form.readable;
  const sealing = await sealer();
  if (!sealing) {
    if (form.seal === "always") throw sealingUnavailable("this work is end-to-end encrypted and no trusted phone has a current key");
    return form.readable;
  }
  // Project, topic and computer go as handles; their names ride the sealed card to the phone.
  const identity = form.opaque ? await sealing.opaque(form.opaque) : undefined;
  return {
    ...form.sealedForm,
    ...(identity && form.withContext ? { context: identity.context } : {}),
    ...(form.card ? { sealed: sealing.seal(form.card, identity?.names) } : {}),
    ...(form.copy ? { producerSealed: sealing.self(form.copy) } : {}),
  };
}

/** The server a command's writes are for: its config's API origin (the client's when no config is given). */
export function declaredServer({ config, client }) {
  return serverOrigin(config?.apiUrl) ?? serverOrigin(client?.apiUrl);
}

/** The outbox `send` for declared entries; observed entries are the hooks' and stop here without a request. */
export function declaredSender({ client, sealer, timeoutMs = DRAIN_BUDGET_MS }) {
  return async (entry) => {
    if (entry.credential !== "cli") throw new Error("not a declared entry");
    const envelope = entry.body;
    if (envelope?.v !== 1) return { status: 400 };
    const api = worksClient(client, { sessionKey: entry.sessionKey, harness: envelope.harness ?? "unknown" });
    let body;
    try {
      body = await materialize(envelope, sealer);
    } catch (error) {
      // No phone key now (or the network went away while sealing): keep the entry for a later flush.
      throw offline(error) ? new NetworkError(error.message) : Object.assign(new Error(error?.message ?? "sealing failed"), { keep: true });
    }
    await api.send({ method: entry.method, path: entry.route }, body, entry.idempotencyKey, { timeoutMs });
    return { status: 200 };
  };
}

/**
 * One command's view of the lane. `drain()` flushes first; `write(form)` sends now or queues, and
 * returns the server's answer or null when the write was queued.
 */
export function declaredLane({ client, config, dependencies, identity, sealer, budgetMs = DRAIN_BUDGET_MS }) {
  const directory = declaredDirectory(dependencies);
  // Every queued write names the server it is for; a flush for another server never sends it.
  const server = declaredServer({ config, client });
  const api = worksClient(client, identity);
  let queued = false;
  // A write sealed and sent before the network failed replays byte for byte (same key, same body). One
  // never sent is sealed when it goes, and drops baseVersion: the writes queued before it change the version.
  const put = (form, final) => enqueue({
    directory, lane: "declared",
    entry: {
      server, route: form.route.path, method: form.route.method, idempotencyKey: form.key, credential: "cli", sessionKey: identity.sessionKey,
      body: final ? { v: 1, harness: identity.harness, final } : {
        v: 1, harness: identity.harness, seal: form.seal, readable: withoutBase(form.readable),
        ...(form.sealedForm ? { sealedForm: withoutBase(form.sealedForm) } : {}),
        ...(form.opaque ? { opaque: form.opaque, withContext: Boolean(form.withContext) } : {}),
        ...(form.card ? { card: form.card } : {}), ...(form.copy ? { copy: form.copy } : {}),
      },
    },
  });
  return {
    get queued() { return queued; },
    async drain() {
      let sent = 0;
      try {
        sent = (await flush({ directory, send: declaredSender({ client, sealer, timeoutMs: budgetMs }), server, budgetMs })).sent;
      } catch { /* the lane stays as it was */ }
      const left = await pending({ directory }).catch(() => ({ declared: 0 }));
      queued = left.declared > 0;
      return { sent, pending: left.declared };
    },
    /** form: { route, key, seal, readable, sealedForm?, opaque?, withContext?, card?, copy? }. */
    async write(form) {
      if (queued) { await put(form); return null; }
      let body;
      try { body = await materialize(form, sealer); } catch (error) {
        if (!offline(error)) throw error;
        queued = true;
        await put(form);
        return null;
      }
      try { return await api.send(form.route, body, form.key); } catch (error) {
        if (!offline(error)) throw error;
        queued = true;
        await put(form, body);
        return null;
      }
    },
  };
}

/**
 * Sends what is queued before a question or notice goes out (`relo ask`, `relo notify`), so the owner never
 * sees them ahead of the work changes they follow. Never fails the caller.
 */
export async function drainDeclared({ client, config, dependencies, budgetMs = DRAIN_BUDGET_MS }) {
  if (typeof client?.request !== "function") return { sent: 0 };
  let sealerPromise;
  const sealer = () => (sealerPromise ??= workSealer({ client, config, dependencies, notes: [] }));
  try {
    return await flush({ directory: declaredDirectory(dependencies), send: declaredSender({ client, sealer, timeoutMs: budgetMs }),
      server: declaredServer({ config, client }), budgetMs });
  } catch {
    return { sent: 0 };
  }
}

/** What `relo state` shows: declared writes not sent yet, and recent ones the server refused. */
export async function laneSummary(dependencies, now = Date.now()) {
  const summary = await pending({ directory: declaredDirectory(dependencies) }).catch(() => undefined);
  if (!summary) return { declared: 0, oldestAt: null, refused: [] };
  const refused = (summary.dead ?? []).filter((item) => item.lane === "declared" && now - Date.parse(item.at) < 3600_000);
  return { declared: summary.declared, oldestAt: summary.declared ? summary.oldestAt : null, refused };
}
