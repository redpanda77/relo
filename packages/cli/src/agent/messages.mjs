// What a notice or question needs from an agent's shell (an agent session, or a harness with no session id):
// the session key the server scopes it by, the topic the session already names, and the card it is asked
// on. The shared messages code (messages/notify.mjs) asks this port and never checks the caller's type.
import { cardOwner } from "../caller.mjs";
import { harnessLabel } from "../harness/catalog.mjs";
import { activeCard } from "../messages/cards.mjs";
import { readSession } from "./session-file.mjs";
import { sessionName } from "./session-name.mjs";

/** An agent's shell tool gives up on a command after about two minutes: a wait defaults to 100 s. */
const WAIT_SECONDS = 100;
const inSession = (dependencies) => dependencies.caller?.type === "agent_session";

async function openWork(dependencies) {
  if (!inSession(dependencies)) return null;
  try { return (await readSession(dependencies.caller, dependencies))?.open ?? null; } catch { return null; }
}

export default Object.freeze({
  sessionKey: (dependencies) => (inSession(dependencies) ? dependencies.caller.sessionKey : undefined),
  waitSeconds: () => WAIT_SECONDS,
  cardOwner: (dependencies) => cardOwner(dependencies.caller),
  /** Inside a session a message needs no --topic: it names the session (its own name, else its work's goal). */
  async defaults(dependencies, base) {
    if (!inSession(dependencies) || base?.threadName) return base;
    const open = await openWork(dependencies);
    const harness = harnessLabel(dependencies.caller.harness);
    return { ...base, providerName: base?.providerName ?? harness, threadName: sessionName(dependencies) ?? open?.goal ?? `${harness} session` };
  },
  /** A notice names the session the same way. */
  async noticeDefaults(client, dependencies, { base }) {
    return this.defaults(dependencies, base);
  },
  /** The card a question is asked on: the session's open work's card; without a session, the card the key names. */
  async card(client, dependencies, { key }) {
    if (inSession(dependencies)) {
      const id = (await openWork(dependencies))?.card?.id;
      return id ? activeCard(client, id) : null;
    }
    return key === undefined ? null : activeCard(client, key);
  },
});
