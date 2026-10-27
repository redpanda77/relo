import type { CurrentSubjectProjection } from "@relo/notification-contracts";

/** A plain notice (`relo notify "…"`) as an overview device shows it: a title and a first line. */
export interface OwnerNotice {
  id: string;
  title: string;
  summary: string | null;
  source: string;
  createdAt: string;
  /** Already read on another device of the account: it never announces here. */
  read: boolean;
}

/** The Recent list keeps this many (MacNotices.maxRecent). */
export const MAX_RECENT = 12;
/** A notice announces itself only while younger than this, by the server's clock (MacNotices.momentWindow). */
export const MOMENT_WINDOW_SECONDS = 120;
/** Seen ids kept (SeenNotices.cap). */
export const SEEN_CAP = 200;

const PLACEHOLDER_TITLES = new Set(["Encrypted card", "Encrypted question", "Encrypted notification", "Can't be read on this iPhone"]);
const PLACEHOLDER_LINES = new Set(["Private notification", "Updating…"]);

/**
 * The notices among the server's current items, newest first: ordinary notices only (not a question, progress or
 * incident), not already in Now, not text the server held back. `nowIds` holds Now's notification ids and card ids:
 * a work's outcome notification whose card is in Now is left out, since the card already says it finished.
 */
export function noticesFrom(items: readonly CurrentSubjectProjection[], nowIds: ReadonlySet<string> = new Set()): OwnerNotice[] {
  const found: OwnerNotice[] = [];
  for (const item of items) {
    if (item.kind !== "notice" || item.interaction !== null || item.activity !== null || item.notificationId === null) continue;
    if (nowIds.has(item.notificationId) || (item.outcomeOf !== undefined && nowIds.has(item.outcomeOf))) continue;
    const title = item.title.trim();
    if (!title || PLACEHOLDER_TITLES.has(title)) continue;
    found.push({ id: item.subjectId, title, summary: firstLine(item.summary, title), source: item.source, createdAt: item.createdAt, read: item.readAt !== null });
  }
  return found.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_RECENT);
}

function firstLine(summary: string, title: string): string | null {
  const line = (summary.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  if (!line || line === title || PLACEHOLDER_LINES.has(line) || line.startsWith("Open Relo on")) return null;
  return line;
}

/** The notices already told to the owner: ids in order, newest last, capped at 200. */
export class SeenNotices {
  private ids: string[];
  private set: Set<string>;

  constructor(ids: readonly string[] = []) {
    this.ids = ids.slice(-SEEN_CAP);
    this.set = new Set(this.ids);
  }

  has(id: string): boolean { return this.set.has(id); }

  mark(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.ids.push(id);
    while (this.ids.length > SEEN_CAP) this.set.delete(this.ids.shift()!);
  }

  toArray(): string[] { return [...this.ids]; }
}

/**
 * Which of `notices` to announce: not seen before, younger than the moment window by the server's clock `serverTime`,
 * and not read elsewhere. Every notice offered is marked seen, announced or not, so none announces twice.
 */
export function freshNotices(notices: readonly OwnerNotice[], seen: SeenNotices, serverTime: string): OwnerNotice[] {
  const fresh: OwnerNotice[] = [];
  const now = Date.parse(serverTime);
  for (const notice of notices) {
    if (seen.has(notice.id)) continue;
    seen.mark(notice.id);
    if ((now - Date.parse(notice.createdAt)) / 1000 <= MOMENT_WINDOW_SECONDS && !notice.read) fresh.push(notice);
  }
  return fresh.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** This device shows notices only once the account's device list is known and shows no phone that gets the push. */
export function showsNotices(phoneReceivesPushes: boolean | null): boolean {
  return phoneReceivesPushes === false;
}
