// What a notice or question needs from a script, an app or the owner's terminal: no session key, the
// identity the command names, and the card it is asked on. A script with RELO_SESSION keeps one card of
// its own and waits like an agent's shell (its runner may cut long commands short).
import { cardOwner } from "../caller.mjs";
import { cardKey, partialIdentity } from "../messages/card-context.mjs";
import { activeCard, activityName } from "../messages/cards.mjs";
import { definedFields } from "../shared/validate.mjs";
import { producerPathKey } from "./producer.mjs";

const WAIT_SECONDS = 100;

export default Object.freeze({
  sessionKey: () => undefined,
  waitSeconds: (dependencies) => (dependencies.caller?.session !== undefined ? WAIT_SECONDS : undefined),
  cardOwner: (dependencies) => cardOwner(dependencies.caller),
  defaults: async (dependencies, base) => base,
  /** A script that keeps its own card (RELO_SESSION) files a notice under that card's source, project and topic. */
  async noticeDefaults(client, dependencies, { options, stdin, base }) {
    const owner = cardOwner(dependencies.caller);
    if (!owner) return base;
    const known = partialIdentity(options, stdin, base);
    if (known.providerName && known.project && known.threadName) return base;
    const key = cardKey({ name: activityName(options, stdin), env: dependencies.env, owner, context: known });
    const card = key === undefined ? null : await activeCard(client, key);
    return { ...base, ...definedFields({ providerName: card?.context?.providerName, project: card?.context?.project, threadName: card?.context?.threadName,
      computer: card?.context?.computer, account: card?.context?.account }) };
  },
  /**
   * The card a question is asked on: the producer's open work's card (a script that declared its work with
   * relo work --producer KEY and asks under the same RELO_SESSION=KEY), else the card the key names.
   */
  async card(client, dependencies, { key }) {
    const producer = dependencies.caller?.producerKey;
    if (producer) {
      let listed;
      try { listed = await client.request("GET", `/api/producers/${producerPathKey(producer)}/works`, { query: { state: "open" } }); } catch { listed = undefined; }
      const id = listed?.works?.find((work) => work.card?.state === "active")?.card?.id;
      if (id) return activeCard(client, id);
    }
    return key === undefined ? null : activeCard(client, key);
  },
});
