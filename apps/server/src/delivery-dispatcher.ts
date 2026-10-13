export type DeliveryLane = "urgent" | "normal";
export interface DeliveryDispatcherOptions<Job> {
  concurrency: number;
  reservedUrgent: number;
  claim(limit: number, lane: DeliveryLane): Promise<Job[]>;
  dispatch(job: Job): Promise<void>;
  /** One cancellable notification/deadline wait. Must settle when aborted. */
  wait(signal: AbortSignal): Promise<void>;
}

/** Continuously replenishes slots. It never owns a backlog of already-claimed jobs.
 * Urgent-only slots stay available during routine saturation. Shared slots admit
 * at most three urgent jobs before offering normal FIFO work a turn. */
export class DeliveryDispatcher<Job> {
  private readonly active = new Map<Promise<void>, "reserved" | "shared">();
  private sharedUrgentStreak = 0;
  private version = 0;
  private wake: (() => void) | undefined;
  private failure: unknown;
  private failed = false;
  private hasRun = false;

  constructor(private readonly options: DeliveryDispatcherOptions<Job>) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error("concurrency must be positive");
    if (!Number.isSafeInteger(options.reservedUrgent) || options.reservedUrgent < 0 || options.reservedUrgent >= options.concurrency) throw new Error("reservedUrgent must leave at least one shared slot");
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.hasRun) throw new Error("dispatcher already started");
    this.hasRun = true;
    try {
      while (!signal.aborted && !this.failed) {
        const observed = this.version;
        await this.fill(signal);
        if (signal.aborted || this.failed) break;
        if (observed !== this.version) continue;
        await this.wait(signal);
      }
    } finally {
      await Promise.allSettled(this.active.keys());
    }
    if (this.failed) throw this.failure;
  }

  private count(kind: "reserved" | "shared"): number {
    return [...this.active.values()].filter(value => value === kind).length;
  }

  private async fill(signal: AbortSignal): Promise<void> {
    const reservedFree = this.options.reservedUrgent - this.count("reserved");
    if (reservedFree > 0) {
      for (const job of await this.options.claim(reservedFree, "urgent")) this.start(job, "reserved");
    }
    while (!signal.aborted && !this.failed) {
      const free = this.options.concurrency - this.options.reservedUrgent - this.count("shared");
      if (free <= 0) return;
      let lane: DeliveryLane = this.sharedUrgentStreak >= 3 ? "normal" : "urgent";
      const allowance = lane === "normal" ? 1 : Math.min(free, 3 - this.sharedUrgentStreak);
      let jobs = await this.options.claim(allowance, lane);
      if (jobs.length === 0 && !signal.aborted) {
        lane = lane === "urgent" ? "normal" : "urgent";
        jobs = await this.options.claim(lane === "normal" ? free : Math.min(free, 3), lane);
      }
      if (jobs.length === 0) return;
      this.sharedUrgentStreak = lane === "urgent" ? Math.min(3, this.sharedUrgentStreak + jobs.length) : 0;
      for (const job of jobs) this.start(job, "shared");
    }
  }

  private start(job: Job, kind: "reserved" | "shared"): void {
    const task = Promise.resolve().then(() => this.options.dispatch(job)).catch(error => {
      if (!this.failed) this.failure = error;
      this.failed = true;
    }).finally(() => {
      this.active.delete(task);
      this.version += 1;
      this.wake?.();
    });
    this.active.set(task, kind);
  }

  private async wait(signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const completed = new Promise<void>(resolve => { this.wake = resolve; });
    try {
      await Promise.race([completed, this.options.wait(controller.signal)]);
    } finally {
      this.wake = undefined;
      controller.abort(); // Release the old LISTEN waiter before another slot-wakeup wait.
      signal.removeEventListener("abort", abort);
    }
  }
}
