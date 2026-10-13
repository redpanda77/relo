import type { Notification,PoolClient } from "pg";
import type { Database } from "./db.js";

/** One owned LISTEN connection; recovery always requests an authoritative catch-up. */
export class PostgresListener {
  private client: PoolClient | undefined;
  private connecting: Promise<void> | undefined;
  private detach: (() => void) | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private connectedBefore = false;
  private closed = false;

  private constructor(private readonly db: Database,private readonly channels: readonly string[],
    private readonly notify: (notification?: Notification) => void) {
    if (!channels.length || channels.some(channel=>!/^[a-z_][a-z0-9_]*$/.test(channel))) throw new Error("Invalid PostgreSQL notification channel");
  }

  static async listen(db: Database,channel: string | readonly string[],notify: (notification?: Notification) => void): Promise<PostgresListener> {
    const listener = new PostgresListener(db,typeof channel==="string"?[channel]:[...new Set(channel)],notify);
    try { await listener.open();return listener; }
    catch (error) { await listener.close();throw error; }
  }

  private open(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = await this.db.connect();
      if (this.closed) { client.release();return; }
      this.client = client;
      let released = false;
      const detach = () => {
        if (released) return;
        released = true;
        client.off("notification",notified);client.off("error",failed);client.off("end",failed);
        if (this.client === client) { this.client = undefined;this.detach = undefined; }
        client.release(true);
      };
      const failed = () => {
        detach();
        if (!this.closed) { this.notify();this.schedule(); }
      };
      const notified = (message: Notification) => {
        if (!this.closed && this.channels.includes(message.channel)) this.notify(message);
      };
      this.detach = detach;
      client.on("notification",notified);client.on("error",failed);client.on("end",failed);
      try {
        for (const channel of this.channels) await client.query(`LISTEN ${channel}`);
        if (this.closed || released) return;
        this.failures = 0;
        if (this.connectedBefore) this.notify();
        this.connectedBefore = true;
      } catch (error) { detach();throw error; }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private schedule(): void {
    if (this.closed || this.retry) return;
    const delay = Math.min(5_000,250*2**Math.min(this.failures++,5));
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.open().catch(() => this.schedule());
    },delay);
    this.retry.unref?.();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.detach?.(); // Destroying the connection removes LISTEN even after failure.
    await this.connecting?.catch(() => {});
  }
}
