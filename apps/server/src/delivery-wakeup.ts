import type { Notification,PoolClient } from "pg";
import type { Database } from "./db.js";

const deliveryChannel = "relo_delivery_jobs";

export class DeliveryJobWakeup {
  private pending = false;
  private waiter: ((result: "notified" | "aborted") => void) | undefined;
  private closed = false;
  private degraded = false;

  private readonly notified = (message: Notification) => {
    if (message.channel !== deliveryChannel || this.closed) return;
    this.pending = true;
    this.waiter?.("notified");
  };

  private readonly failed = () => {
    if (this.closed) return;
    this.degraded = true;
    this.waiter?.("notified");
  };

  private constructor(private readonly client: PoolClient) {
    client.on("notification",this.notified);
    client.on("error",this.failed);
  }

  static async listen(db: Database): Promise<DeliveryJobWakeup> {
    const client = await db.connect();
    try {
      await client.query(`LISTEN ${deliveryChannel}`);
      return new DeliveryJobWakeup(client);
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async wait(timeoutMs: number, signal?: AbortSignal): Promise<"notified" | "timeout" | "aborted"> {
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
      if (!this.degraded) this.waiter = finish;
      signal?.addEventListener("abort",aborted,{ once: true });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.waiter?.("aborted");
    this.client.off("notification",this.notified);
    this.client.off("error",this.failed);
    try {
      await this.client.query(`UNLISTEN ${deliveryChannel}`);
    } finally {
      this.client.release();
    }
  }
}
