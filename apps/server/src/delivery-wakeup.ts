import type { Database } from "./db.js";
import { PostgresListener } from "./postgres-listener.js";

export class DeliveryJobWakeup {
  private pending = false;
  private waiter: ((result: "notified" | "aborted") => void) | undefined;
  private closed = false;
  private listener: PostgresListener | undefined;

  private constructor() {}

  static async listen(db: Database): Promise<DeliveryJobWakeup> {
    const wakeup = new DeliveryJobWakeup();
    wakeup.listener = await PostgresListener.listen(db,"relo_delivery_jobs",() => {
      if (wakeup.closed) return;
      wakeup.pending = true;
      wakeup.waiter?.("notified");
    });
    return wakeup;
  }

  async wait(timeoutMs: number, signal?: AbortSignal): Promise<"notified" | "timeout" | "aborted"> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid delivery wait timeout");
    if (this.waiter) throw new Error("Delivery wakeup already has an owner");
    if (signal?.aborted || this.closed) return "aborted";
    if (this.pending) {
      this.pending = false;
      return "notified";
    }
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result: "notified" | "timeout" | "aborted") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort",aborted);
        this.waiter = undefined;
        if (result === "notified") this.pending = false;
        resolve(result);
      };
      const aborted = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"),timeoutMs);
      this.waiter = finish;
      signal?.addEventListener("abort",aborted,{ once: true });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.waiter?.("aborted");
    await this.listener?.close();
  }
}
