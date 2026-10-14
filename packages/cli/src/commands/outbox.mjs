// `relo outbox flush` (hidden; started in the background by hooks and relo commands) and
// `relo outbox status`. The flusher is the only place queued entries meet the network: it picks the
// credential each entry names (the harness credential for observed snapshots, minted lazily; the CLI
// credential for declared writes), lets the route's preparer finish the body (sealing that needs the
// network), and sends with the entry's idempotency key.
import { UsageError } from "../errors.mjs";
import { OBSERVED_ROUTE, prepareObserved } from "../harness/core/observed.mjs";
import { ensureHarnessCredential, readHarnessCredential, removeHarnessCredential } from "../harness/core/credential.mjs";
import { flush, pending, serverOrigin } from "../outbox/index.mjs";
import { observedServer } from "../harness/core/process.mjs";
import { declaredSender } from "../work/declared-lane.mjs";
import { workSealer } from "../work/seal-work.mjs";
import { assertAllowedOptions, assertNoExtra, result } from "../support.mjs";

const USAGE = "Usage: relo outbox status | relo outbox flush";
export const FLUSH_BUDGET_MS = 20_000;
const SEND_TIMEOUT_MS = 10_000;

/** Route → async (entry, context) => { body, after? }. Routes without one are sent as queued. */
const PREPARERS = new Map([[OBSERVED_ROUTE, prepareObserved]]);

// A failure that says nothing about the entry itself (no login, server unreachable while minting):
// thrown without a status so the outbox keeps the entry for later.
const transient = (error) => Object.assign(new Error(error?.message ?? "unavailable"), { cause: error });

/** The send function the outbox flusher uses: one request per entry, with the entry's own credential. */
export function outboxSender(dependencies) {
  let cli;
  let declared;
  let sealing;
  const cliContext = async () => {
    cli ??= (async () => {
      const config = await dependencies.loadConfig(dependencies.configPath());
      return { config, client: dependencies.clientFactory(config) };
    })();
    return cli;
  };
  return async (entry) => {
    let client;
    if (entry.credential === "harness") {
      let credential;
      try {
        credential = await ensureHarnessCredential(dependencies);
      } catch (error) {
        throw transient(error);
      }
      // A credential minted for another server is forgotten (the next flush mints one for this server).
      if (serverOrigin(credential.apiUrl) !== entry.server) {
        await removeHarnessCredential(dependencies).catch(() => {});
        throw transient(new Error("the harness credential is for another server"));
      }
      client = dependencies.clientFactory({ apiUrl: credential.apiUrl, token: credential.token });
    } else {
      let context;
      try {
        context = await cliContext();
      } catch (error) {
        throw transient(error);
      }
      // Declared writes (relo work): the declared lane's own sender seals them for the phones trusted now
      // and sends them on the session's key (work/declared-lane.mjs).
      declared ??= declaredSender({ client: context.client, timeoutMs: SEND_TIMEOUT_MS,
        sealer: () => (sealing ??= workSealer({ client: context.client, config: context.config, dependencies, notes: [] })) });
      return declared(entry);
    }
    let body = entry.body;
    let after = async () => {};
    const prepare = PREPARERS.get(entry.route);
    if (prepare) {
      const context = await cliContext().catch(() => ({}));
      ({ body, after } = await prepare(entry, { ...context, dependencies }));
    }
    try {
      await client.request(entry.method, entry.route, { body, idempotencyKey: entry.idempotencyKey, timeoutMs: SEND_TIMEOUT_MS });
    } catch (error) {
      // A revoked or expired harness credential: forget it so the next flush mints a fresh one, and keep
      // the entry.
      if (entry.credential === "harness" && error?.status === 401) {
        await removeHarnessCredential(dependencies).catch(() => {});
        throw transient(error);
      }
      throw error;
    }
    await after().catch(() => {});
    return { status: 200 };
  };
}

/** Flushes until the outbox is empty, nothing more goes out, or the budget is spent. */
export async function flushOutbox(dependencies, { budgetMs = FLUSH_BUDGET_MS } = {}) {
  const directory = dependencies.outboxDirectory;
  const send = outboxSender(dependencies);
  const started = dependencies.now();
  const total = { sent: 0, dead: 0, pending: 0 };
  // Only entries queued for the server this computer is logged in to go out (the loaded config, else the
  // harness credential). Without either nothing is sent and nothing is dropped.
  const config = await Promise.resolve().then(() => dependencies.loadConfig(dependencies.configPath())).catch(() => undefined);
  const server = await observedServer(config, dependencies);
  if (!server) return { ...total, pending: (await pending({ directory })).total };
  for (;;) {
    const remaining = budgetMs - (dependencies.now() - started);
    if (remaining <= 0) break;
    const round = await flush({ directory, send, server, budgetMs: remaining });
    total.sent += round.sent;
    total.dead += round.dead;
    total.pending = round.pending;
    if (round.locked) return { ...total, locked: true };
    // Entries queued while this round ran go out in the next one; stop when a round made no progress.
    if (round.pending === 0 || round.sent + round.dead === 0) break;
  }
  return total;
}

export async function runOutboxCommand(command) {
  const { options, group, action, rest, dependencies } = command;
  if (group !== "outbox") return undefined;
  assertNoExtra(rest, 0, USAGE);
  assertAllowedOptions(options, []);
  if (action === "flush") return result("outbox", await flushOutbox(dependencies));
  if (action === "status") {
    const queued = await pending({ directory: dependencies.outboxDirectory });
    const credential = await readHarnessCredential(dependencies);
    return result("outbox", {
      pending: { observed: queued.observed, declared: queued.declared, total: queued.total },
      ...(queued.oldestAt ? { oldestAt: queued.oldestAt } : {}),
      dead: queued.dead.slice(-5),
      harnessCredential: credential ? "present" : "missing",
    });
  }
  throw new UsageError(action === undefined ? "relo outbox needs an action." : `Unknown outbox action "${action}".`, { hint: USAGE });
}
