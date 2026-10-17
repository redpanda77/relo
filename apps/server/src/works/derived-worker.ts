import type { ApnsMode } from "../activities.js";
import { retireByPolicy,type RetirementPass } from "../activity-commands/retirement.js";
import type { Database } from "../db.js";
import type { NotificationContentCipher } from "../notification-content.js";

/**
 * The worker's pass over works and their cards over time (spec 2.17, 6.4; plan 1.5d): staleDate
 * refreshes, display retirement by derived state (no evidence for T_retire, paused, "your turn"
 * over, display-only "left unfinished" after T_history) and wakes for time-only derived changes.
 * Display only: it never writes a declared field of a work or a card. It remembers the previous
 * pass so a change that happened by time alone in between wakes the account's phones once.
 */
export function createDerivedWorker(db: Database,apnsMode: ApnsMode,contentCipher?: NotificationContentCipher | null) {
  let since: Date | null = null;
  return {
    async pass(limit = 200): Promise<RetirementPass> {
      const now = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
      const result = await retireByPolicy(db,apnsMode,limit,{ now,since,contentCipher: contentCipher ?? null });
      since = now;
      return result;
    },
  };
}
