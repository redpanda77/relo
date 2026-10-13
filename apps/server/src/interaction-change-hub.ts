import type { Database } from "./db.js";
import { PostgresListener } from "./postgres-listener.js";
import type { Notification } from "pg";

export type ChangeWaitResult = "changed" | "timeout" | "aborted";

/** A bounded, cancellation-aware hint buffer. Subscribe before reading authoritative state. */
export class ChangeSubscription {
  private pending = false;
  private closed = false;
  private waiter: ((result: ChangeWaitResult) => void) | undefined;
  constructor(private readonly onClose: () => void = () => {}) {}
  notify(): void { this.pending = true;this.waiter?.("changed"); }
  wait(timeoutMs: number,signal?: AbortSignal): Promise<ChangeWaitResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid change timeout");
    if (this.waiter) throw new Error("Change subscription already has a waiter");
    if (this.closed || signal?.aborted) return Promise.resolve("aborted");
    if (this.pending) { this.pending = false;return Promise.resolve("changed"); }
    return new Promise(resolve => {
      const finish = (result: ChangeWaitResult) => {
        clearTimeout(timer);signal?.removeEventListener("abort",aborted);this.waiter = undefined;
        if (result === "changed") this.pending = false;
        resolve(result);
      };
      const aborted = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"),timeoutMs);
      signal?.addEventListener("abort",aborted,{ once: true });
      this.waiter = finish;
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;this.waiter?.("aborted");this.onClose();
  }
}

/** One PostgreSQL connection per API process, never one per connected requester. */
export class InteractionChangeHub {
  private listener: PostgresListener | undefined;
  private readonly watchers = new Map<string,Set<ChangeSubscription>>();
  private readonly perCredential = new Map<string,number>();
  private count = 0;
  private closed = false;

  static async listen(db: Database): Promise<InteractionChangeHub> {
    const hub = new InteractionChangeHub();
    hub.listener = await PostgresListener.listen(db,"relo_interaction_changes",message => hub.receive(message));
    return hub;
  }

  receive(message?: Notification): void {
      if (this.closed) return;
      if (!message) {
        for (const subscriptions of this.watchers.values()) for (const subscription of subscriptions) subscription.notify();
        return;
      }
      if (!message.payload || message.payload.length > 256) return;
      try {
        const payload: unknown = JSON.parse(message.payload);
        if (!payload || typeof payload !== "object") return;
        const { principalId,interactionId } = payload as Record<string,unknown>;
        if (typeof principalId !== "string" || typeof interactionId !== "string") return;
        for (const subscription of this.watchers.get(`${principalId}:${interactionId}`) ?? []) subscription.notify();
      } catch { /* NOTIFY is an untrusted hint; periodic reads recover malformed hints. */ }
  }

  subscribe(principalId: string,interactionId: string,credentialId: string): ChangeSubscription | null {
    if (this.closed || this.count >= 1_000 || (this.perCredential.get(credentialId) ?? 0) >= 16) return null;
    const key = `${principalId}:${interactionId}`;
    const subscriptions = this.watchers.get(key) ?? new Set<ChangeSubscription>();
    const subscription = new ChangeSubscription(() => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) this.watchers.delete(key);
      const remaining = (this.perCredential.get(credentialId) ?? 1)-1;
      if (remaining) this.perCredential.set(credentialId,remaining);else this.perCredential.delete(credentialId);
      this.count--;
    });
    subscriptions.add(subscription);this.watchers.set(key,subscriptions);
    this.perCredential.set(credentialId,(this.perCredential.get(credentialId) ?? 0)+1);this.count++;
    return subscription;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const subscriptions of this.watchers.values()) for (const subscription of subscriptions) subscription.close();
    await this.listener?.close();
  }
}
