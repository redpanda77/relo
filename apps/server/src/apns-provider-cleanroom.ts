import {
  createHash,
  createPrivateKey,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

export type ApnsEnvironment = "sandbox" | "production";
export type ApnsKeyScope = "team-scoped" | "topic-specific";
export type ApnsKeyEnvironment = ApnsEnvironment | "both";
export type ApnsPriority = 5 | 10;
export type ActivityOperation = "start" | "update" | "end";

export interface ApnsProviderConfig {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  keyScope: ApnsKeyScope;
  keyEnvironment: ApnsKeyEnvironment;
  dualEnvironmentConfirmed?: boolean;
  appleAssociatedTopics?: readonly string[];
  allowedTopics: readonly string[];
  bundleId: string;
  environment: ApnsEnvironment;
  configurationGeneration: string;
  localConcurrencyCap?: number;
  jwtRefreshSeconds?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  responseBodyLimitBytes?: number;
  max429Attempts?: number;
  retry429HorizonMs?: number;
  retry429BaseDelayMs?: number;
  max5xxAttempts?: number;
  retry5xxHorizonMs?: number;
  /** Required to opt into a bounded horizon longer than the 60-minute default. */
  allowExtended5xxHorizon?: boolean;
}

export interface Clock {
  nowMs(): number;
}

export interface Scheduler {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RandomSource {
  next(): number;
}

export interface ResolvedRecipient {
  token: string;
  generation: string;
}

export interface DispatchRecipient extends ResolvedRecipient {
  /** Invalidates the leased generation in the same atomic store transaction. */
  invalidate(details: { environment: ApnsEnvironment; invalidatedAtMs?: number }): Promise<void>;
  /** Releases the dispatch lease, committing only when the attempt inspection succeeded. */
  release(commit: boolean): Promise<void>;
}

export interface RecipientResolver {
  /** Must atomically return only the latest active registration. */
  resolve(): Promise<ResolvedRecipient | null>;
  /**
   * Optionally leases the latest registration through stream open and response inspection.
   * Durable resolvers use this to serialize token rotation with one actual dispatch attempt.
   */
  acquire?(): Promise<DispatchRecipient | null>;
  /** Must invalidate only expectedGeneration, never a newer replacement. */
  invalidate(
    expectedGeneration: string,
    details: { environment: ApnsEnvironment; invalidatedAtMs?: number },
  ): Promise<void>;
}

export interface TransportBinding {
  authority: string;
  servername: string;
  environment: ApnsEnvironment;
  poolKey: string;
  connectTimeoutMs: number;
  tls: {
    minimumVersion: "TLSv1.2";
    rejectUnauthorized: true;
    requireHostnameVerification: true;
    alpnProtocols: readonly ["h2"];
  };
}

export interface NegotiatedSecurity {
  tlsVersion: string;
  alpnProtocol: string;
  authorized: boolean;
  hostnameVerified: boolean;
  servername: string;
}

export interface PreparedApnsRequest {
  method: "POST";
  authority: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  hpack: {
    /** High-cardinality or secret values that a Node transport must mark never-index. */
    neverIndex: readonly [":path", "authorization"];
    /** Stable documented headers whose names/values may use normal HTTP/2 indexing. */
    normalIndex: readonly ["content-type", "apns-topic", "apns-push-type", "apns-priority"];
    /** Changing APNs correlation/expiry values whose names may be indexed but values must not be. */
    nameOnlyIndex: readonly ["apns-id", "apns-expiration", "apns-collapse-id"];
  };
  body: Uint8Array;
  responseBodyLimitBytes: number;
}

export type TransportFailureCode =
  | "timeout"
  | "reset"
  | "goaway"
  | "connect"
  | "tls"
  | "protocol";

export type TransportResult =
  | {
      kind: "response";
      status: number;
      headers?: Readonly<Record<string, string | undefined>>;
      body: Uint8Array;
      bodyTruncated?: boolean;
    }
  | { kind: "failure"; code: TransportFailureCode };

export interface GoawayEvent {
  /** Highest stream ID APNs may have processed, from the HTTP/2 GOAWAY frame. */
  lastStreamId: number;
  diagnostic?: Uint8Array;
  diagnosticTruncated?: boolean;
}

export interface ApnsConnection {
  readonly security: NegotiatedSecurity;
  readonly peerMaxConcurrentStreams?: number;
  /** Opens one HTTP/2 request stream and returns its connection-local stream ID synchronously. */
  openStream(request: PreparedApnsRequest, signal: AbortSignal): ApnsStream;
  onPeerSettings(listener: (maximumConcurrentStreams: number) => void): () => void;
  onGoaway(listener: (event: GoawayEvent) => void): () => void;
  close(): void | Promise<void>;
}

export interface ApnsStream {
  /** Positive client-initiated HTTP/2 stream ID, used for GOAWAY last-stream handling. */
  readonly streamId: number;
  readonly result: Promise<TransportResult>;
  cancel(): void;
}

export interface ApnsTransport {
  open(binding: TransportBinding, signal: AbortSignal): Promise<ApnsConnection>;
}

export interface CommonSendOptions {
  recipient: RecipientResolver;
  priority?: ApnsPriority;
  expiration?: number;
  apnsId?: string;
  /** Absolute application deadline in Unix milliseconds. */
  validUntilMs?: number;
  /** Explicit caller policy for indeterminate transport outcomes. Default: zero. */
  indeterminateRetries?: number;
  /** Confirms the exact serialized payload hash against a durable logical-send ledger. */
  confirmPayloadSha256?: (sha256: string) => Promise<boolean>;
  /** Durable provider-policy state from earlier safe claims of this logical send. */
  providerAttemptState?: {
    attemptsUsed: number;
    firstAttemptAtMs?: number;
    attemptCap?: number;
    retryHorizonAtMs?: number;
    nextAttemptNotBeforeMs?: number;
  };
  /** Persists and merges retry policy under the caller's current claim before another stream. */
  persistProviderRetryState?: (
    proposed: Required<ProviderRetryState> & { attemptsUsed: number; firstAttemptAtMs: number },
  ) => Promise<Required<ProviderRetryState>>;
  signal?: AbortSignal;
}

export interface ProviderRetryState {
  attemptCap?: number;
  retryHorizonAtMs?: number;
  nextAttemptNotBeforeMs?: number;
}

export interface AlertSend extends CommonSendOptions {
  alert: string | Record<string, unknown>;
  sound?: string | Record<string, unknown>;
  badge?: number;
  category?: string;
  threadId?: string;
  collapseId?: string;
  mutableContent?: boolean;
  customData?: Record<string, unknown>;
}

export interface ActivitySend extends CommonSendOptions {
  operation: ActivityOperation;
  contentState: Record<string, unknown>;
  attributesType?: string;
  attributes?: Record<string, unknown>;
  alert?: string | Record<string, unknown>;
  staleDate?: number;
  relevanceScore?: number;
  dismissalDate?: number;
  /** Provider-assigned timestamp retained from the logical event's durable creation record. */
  providerTimestamp?: number;
}

export type OutcomeCategory =
  | "accepted"
  | "validation"
  | "stale-recipient"
  | "invalid-recipient"
  | "topic-configuration"
  | "expired-provider-token"
  | "connection-key-binding"
  | "key-environment-configuration"
  | "forbidden"
  | "provider-authentication"
  | "impossible-authentication-mode"
  | "ambiguous-authorization"
  | "recipient-throttled"
  | "provider-token-cadence"
  | "ambiguous-rate-limit"
  | "permanent-apns-rejection"
  | "bounded-protocol-failure"
  | "indeterminate-transport"
  | "retryable-not-scheduled"
  | "retry-exhausted"
  | "pool-quarantined";

export interface ApnsOutcome {
  accepted: boolean;
  category: OutcomeCategory;
  attempt: number;
  apnsId: string;
  payloadBytes: number;
  /** Actual first provider-attempt epoch for the logical send, including prior safe claims. */
  firstAttemptAtMs?: number;
  status?: number;
  reason?: string;
  responseApnsId?: string;
  invalidatedAtMs?: number;
  transportCode?: TransportFailureCode;
}

type ValidatedConfig = Required<
  Pick<
    ApnsProviderConfig,
    | "localConcurrencyCap"
    | "jwtRefreshSeconds"
    | "connectTimeoutMs"
    | "requestTimeoutMs"
    | "responseBodyLimitBytes"
    | "max429Attempts"
    | "retry429HorizonMs"
    | "retry429BaseDelayMs"
    | "max5xxAttempts"
    | "retry5xxHorizonMs"
  >
> &
  ApnsProviderConfig & {
    authority: string;
    ordinaryTopic: string;
    activityTopic: string;
    key: KeyObject;
    poolKey: string;
  };

const DEFAULT_CLOCK: Clock = { nowMs: () => Date.now() };
const DEFAULT_SCHEDULER: Scheduler = {
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortError());
        },
        { once: true },
      );
    }),
};
const DEFAULT_RANDOM: RandomSource = { next: () => Math.random() };

class SafeProviderError extends Error {
  constructor(
    readonly category: OutcomeCategory,
    message: string,
  ) {
    super(message);
    this.name = "SafeProviderError";
  }
}

class RetryOnFreshConnection extends Error {}

interface JwtCacheEntry {
  token: string;
  issuedAt: number;
}

class JwtProvider {
  private cached: JwtCacheEntry | undefined;

  constructor(
    private readonly config: ValidatedConfig,
    private readonly clock: Clock,
  ) {}

  get(): JwtCacheEntry {
    const now = integerNowSeconds(this.clock);
    if (this.cached) {
      const age = now - this.cached.issuedAt;
      if (age < 0) {
        this.cached = undefined;
        throw new SafeProviderError("provider-authentication", "Clock moved behind cached authentication state");
      }
      if (age < this.config.jwtRefreshSeconds && age < 3_600) return this.cached;
    }

    const header = base64UrlJson({ alg: "ES256", kid: this.config.keyId });
    const claims = base64UrlJson({ iss: this.config.teamId, iat: now });
    const signingInput = `${header}.${claims}`;
    const signature = cryptoSign("sha256", Buffer.from(signingInput), {
      key: this.config.key,
      dsaEncoding: "ieee-p1363",
    });
    this.cached = { token: `${signingInput}.${signature.toString("base64url")}`, issuedAt: now };
    return this.cached;
  }

  invalidateIfCurrent(token: string): void {
    if (this.cached?.token === token) this.cached = undefined;
  }

  canCorrectExpired(token: string): boolean {
    if (this.cached?.token !== token) return true;
    const age = integerNowSeconds(this.clock) - this.cached.issuedAt;
    return age >= 1_200;
  }

  invalidateForExpiredGoaway(): boolean {
    if (!this.cached) return true;
    const age = integerNowSeconds(this.clock) - this.cached.issuedAt;
    if (age < 1_200) return false;
    this.cached = undefined;
    return true;
  }

  clear(): void {
    this.cached = undefined;
  }
}

interface QueueWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
}

interface ActiveStream {
  cancel(): void;
  markIndeterminate(): void;
}

interface PoolInspection {
  accepted: boolean;
  quarantine?: OutcomeCategory;
  retire?: boolean;
}

interface SlotContext {
  recipient: ResolvedRecipient | DispatchRecipient;
  jwt: JwtCacheEntry;
}

interface SlotPreparation {
  request: PreparedApnsRequest;
  context: SlotContext;
}

interface SettledDispatch {
  result: TransportResult;
  context: SlotContext;
}

class ManagedConnection {
  private active = 0;
  private authenticated = false;
  private draining = false;
  private peerLimit: number | undefined;
  private readonly waiters: QueueWaiter[] = [];
  private readonly streams = new Map<number, ActiveStream>();
  private readonly unsubscribeSettings: () => void;
  private readonly unsubscribeGoaway: () => void;
  private closed = false;

  constructor(
    readonly connection: ApnsConnection,
    private readonly localCap: number,
    private readonly onDrain: (record: ManagedConnection, event?: GoawayEvent) => void,
  ) {
    this.peerLimit = normalizePeerLimit(connection.peerMaxConcurrentStreams);
    this.unsubscribeSettings = connection.onPeerSettings((limit) => {
      this.peerLimit = normalizePeerLimit(limit);
      this.pump();
    });
    this.unsubscribeGoaway = connection.onGoaway((event) => this.startDraining(event));
  }

  async dispatch(
    outerSignal: AbortSignal,
    requestTimeoutMs: number,
    scheduler: Scheduler,
    beforeRelease: (settled: SettledDispatch) => Promise<PoolInspection>,
    isQuarantined: () => boolean,
    prepareAtSlot: () => Promise<SlotPreparation>,
  ): Promise<SettledDispatch> {
    await this.acquire(outerSignal);
    try {
      if (this.draining) throw new RetryOnFreshConnection();
      if (isQuarantined()) {
        throw new SafeProviderError("pool-quarantined", "APNs pool requires operator recovery");
      }
      if (outerSignal.aborted) throw abortError();
      const preparation = await prepareAtSlot();
      try {
        if (outerSignal.aborted) throw abortError();
        if (this.draining) throw new RetryOnFreshConnection();
        if (isQuarantined()) {
          throw new SafeProviderError("pool-quarantined", "APNs pool requires operator recovery");
        }
      } catch (error) {
        if (isDispatchRecipient(preparation.context.recipient)) {
          await preparation.context.recipient.release(false);
        }
        throw error;
      }
      const controller = linkedAbortController(outerSignal);
      let stream: ApnsStream;
      try {
        stream = this.connection.openStream(preparation.request, controller.signal);
      } catch {
        const settled: SettledDispatch = {
          result: { kind: "failure", code: "protocol" },
          context: preparation.context,
        };
        await this.inspectAndRelease(settled, beforeRelease);
        return settled;
      }
      if (!Number.isSafeInteger(stream.streamId) || stream.streamId <= 0 || stream.streamId % 2 === 0 || this.streams.has(stream.streamId)) {
        stream.cancel();
        const settled: SettledDispatch = {
          result: { kind: "failure", code: "protocol" },
          context: preparation.context,
        };
        await this.inspectAndRelease(settled, beforeRelease);
        return settled;
      }
      let markIndeterminate = (): void => undefined;
      const goaway = new Promise<TransportResult>((resolve) => {
        markIndeterminate = () => resolve({ kind: "failure", code: "goaway" });
      });
      this.streams.set(stream.streamId, {
        cancel: () => {
          controller.abort();
          stream.cancel();
        },
        markIndeterminate,
      });
      let result: TransportResult;
      try {
        result = await raceTimeout(
          Promise.race([stream.result, goaway]),
          requestTimeoutMs,
          scheduler,
          controller,
        );
      } catch (error) {
        stream.cancel();
        result = { kind: "failure", code: isAbortLike(error) ? "timeout" : "protocol" };
      } finally {
        this.streams.delete(stream.streamId);
      }
      const settled = { result, context: preparation.context };
      const inspection = await this.inspectAndRelease(settled, beforeRelease);
      if (inspection.accepted) this.authenticated = true;
      if (inspection.retire) this.startDraining();
      return settled;
    } finally {
      this.active -= 1;
      this.pump();
      if (this.draining && this.active === 0) void this.close();
    }
  }

  startDraining(event?: GoawayEvent): void {
    if (this.draining) return;
    this.draining = true;
    this.onDrain(this, event);
    if (event) {
      const lastStreamId = Number.isSafeInteger(event.lastStreamId) && event.lastStreamId >= 0
        ? event.lastStreamId
        : 0;
      for (const [streamId, stream] of this.streams) {
        if (streamId > lastStreamId) {
          stream.markIndeterminate();
          stream.cancel();
        }
      }
    }
    for (const waiter of this.waiters.splice(0)) waiter.reject(new RetryOnFreshConnection());
    if (this.active === 0) void this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSettings();
    this.unsubscribeGoaway();
    await this.connection.close();
  }

  private capacity(): number {
    const peer = this.peerLimit ?? 1;
    return Math.min(this.localCap, peer, this.authenticated ? Number.MAX_SAFE_INTEGER : 1);
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.draining) return Promise.reject(new RetryOnFreshConnection());
    if (this.active < this.capacity()) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: QueueWaiter = { resolve, reject, signal };
      this.waiters.push(waiter);
      signal.addEventListener(
        "abort",
        () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  private pump(): void {
    while (!this.draining && this.waiters.length > 0 && this.active < this.capacity()) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.signal?.aborted) continue;
      this.active += 1;
      waiter.resolve();
    }
  }

  private async inspectAndRelease(
    settled: SettledDispatch,
    beforeRelease: (settled: SettledDispatch) => Promise<PoolInspection>,
  ): Promise<PoolInspection> {
    let commit = false;
    try {
      const inspection = await beforeRelease(settled);
      commit = true;
      return inspection;
    } finally {
      if (isDispatchRecipient(settled.context.recipient)) {
        try {
          await settled.context.recipient.release(commit);
        } catch {
          throw new SafeProviderError("pool-quarantined", "Recipient dispatch lease could not be released safely");
        }
      }
    }
  }
}

class ConnectionPool {
  private current: ManagedConnection | undefined;
  private opening: Promise<ManagedConnection> | undefined;
  private quarantineReason: OutcomeCategory | undefined;

  constructor(
    private readonly transport: ApnsTransport,
    private readonly config: ValidatedConfig,
    private readonly scheduler: Scheduler,
    private readonly onGoawayReason: (reason: string | undefined) => OutcomeCategory | undefined,
  ) {}

  get quarantined(): OutcomeCategory | undefined {
    return this.quarantineReason;
  }

  quarantine(reason: OutcomeCategory): void {
    this.quarantineReason = reason;
  }

  resetQuarantine(): void {
    this.quarantineReason = undefined;
  }

  async dispatch(
    outerSignal?: AbortSignal,
    inspect: (settled: SettledDispatch) => Promise<PoolInspection> = async () => ({ accepted: false }),
    prepareAtSlot: () => Promise<SlotPreparation> = async () => {
      throw new SafeProviderError("validation", "A slot preparation callback is required");
    },
  ): Promise<{ result: TransportResult; record: ManagedConnection; context: SlotContext | undefined }> {
    if (this.quarantineReason) {
      throw new SafeProviderError("pool-quarantined", "APNs pool requires operator recovery");
    }
    for (;;) {
      if (this.quarantineReason) {
        throw new SafeProviderError("pool-quarantined", "APNs pool requires operator recovery");
      }
      const record = await this.getOrOpen(outerSignal);
      if (this.quarantineReason) {
        record.startDraining();
        throw new SafeProviderError("pool-quarantined", "APNs pool requires operator recovery");
      }
      const controller = linkedAbortController(outerSignal);
      try {
        const settled = await record.dispatch(
          controller.signal,
          this.config.requestTimeoutMs,
          this.scheduler,
          async (completed) => {
            const inspection = await inspect(completed);
            if (inspection.quarantine) this.quarantine(inspection.quarantine);
            return inspection;
          },
          () => this.quarantineReason !== undefined,
          prepareAtSlot,
        );
        return { result: settled.result, record, context: settled.context };
      } catch (error) {
        if (error instanceof RetryOnFreshConnection) continue;
        if (error instanceof SafeProviderError) throw error;
        if (isAbortLike(error)) return { result: { kind: "failure", code: "timeout" }, record, context: undefined };
        return { result: { kind: "failure", code: "protocol" }, record, context: undefined };
      }
    }
  }

  async warm(signal?: AbortSignal): Promise<void> {
    await this.getOrOpen(signal);
  }

  retire(record: ManagedConnection): void {
    record.startDraining();
  }

  async close(): Promise<void> {
    const record = this.current;
    this.current = undefined;
    if (record) record.startDraining();
    if (this.opening) {
      try {
        (await this.opening).startDraining();
      } catch {
        // A failed opening has no reusable resources at this layer.
      }
    }
  }

  private async getOrOpen(signal?: AbortSignal): Promise<ManagedConnection> {
    if (this.current) return this.current;
    if (!this.opening) this.opening = this.open(signal);
    try {
      const record = await this.opening;
      if (!this.current) this.current = record;
      return this.current;
    } finally {
      this.opening = undefined;
    }
  }

  private async open(outerSignal?: AbortSignal): Promise<ManagedConnection> {
    const controller = linkedAbortController(outerSignal);
    const binding: TransportBinding = {
      authority: this.config.authority,
      servername: this.config.authority.slice(0, -4),
      environment: this.config.environment,
      poolKey: this.config.poolKey,
      connectTimeoutMs: this.config.connectTimeoutMs,
      tls: {
        minimumVersion: "TLSv1.2",
        rejectUnauthorized: true,
        requireHostnameVerification: true,
        alpnProtocols: ["h2"],
      },
    };
    let connection: ApnsConnection;
    try {
      connection = await raceTimeout(
        this.transport.open(binding, controller.signal),
        this.config.connectTimeoutMs,
        this.scheduler,
        controller,
      );
    } catch {
      throw new SafeProviderError("indeterminate-transport", "APNs connection establishment failed");
    }
    try {
      validateNegotiatedSecurity(connection.security, binding.servername);
    } catch (error) {
      await connection.close();
      throw error;
    }
    return new ManagedConnection(connection, this.config.localConcurrencyCap, (record, event) => {
      const reason = sanitizeGoaway(event, this.config.responseBodyLimitBytes);
      const quarantine = this.onGoawayReason(reason);
      if (quarantine) this.quarantine(quarantine);
      if (this.current === record) this.current = undefined;
    });
  }
}

interface LogicalSend {
  recipient: RecipientResolver;
  topic: string;
  pushType: "alert" | "liveactivity";
  priority: ApnsPriority;
  expiration: number;
  validUntilMs?: number;
  apnsId: string;
  collapseId?: string;
  body: Uint8Array;
  indeterminateRetries: number;
  priorProviderAttempts: number;
  providerFirstAttemptAtMs?: number;
  providerRetryState: ProviderRetryState;
  persistProviderRetryState?: CommonSendOptions["persistProviderRetryState"];
  confirmPayloadSha256?: (sha256: string) => Promise<boolean>;
  signal?: AbortSignal;
}

type Decision =
  | { action: "return"; outcome: ApnsOutcome; quarantine?: OutcomeCategory; invalidate?: boolean }
  | { action: "retry-expired-jwt" }
  | { action: "retry-fresh-connection" }
  | { action: "retry-429" }
  | { action: "retry-5xx" };

export class ApnsProviderCleanroom {
  readonly authority: string;
  readonly poolKey: string;
  private readonly config: ValidatedConfig;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly random: RandomSource;
  private readonly uuid: () => string;
  private readonly jwt: JwtProvider;
  private readonly pool: ConnectionPool;
  private readonly blockedGenerations = new WeakMap<RecipientResolver, Set<string>>();

  constructor(
    config: ApnsProviderConfig,
    transport: ApnsTransport,
    dependencies: {
      clock?: Clock;
      scheduler?: Scheduler;
      random?: RandomSource;
      uuid?: () => string;
    } = {},
  ) {
    this.config = validateConfig(config);
    this.authority = this.config.authority;
    this.poolKey = this.config.poolKey;
    this.clock = dependencies.clock ?? DEFAULT_CLOCK;
    this.scheduler = dependencies.scheduler ?? DEFAULT_SCHEDULER;
    this.random = dependencies.random ?? DEFAULT_RANDOM;
    this.uuid = dependencies.uuid ?? randomUUID;
    this.jwt = new JwtProvider(this.config, this.clock);
    this.pool = new ConnectionPool(
      transport,
      this.config,
      this.scheduler,
      (reason) => this.classifyGoawayReason(reason),
    );
  }

  async sendAlert(input: AlertSend): Promise<ApnsOutcome> {
    try {
      const aps: Record<string, unknown> = { alert: validateAlert(input.alert) };
      if (input.sound !== undefined) aps.sound = input.sound;
      if (input.badge !== undefined) {
        if (!Number.isInteger(input.badge)) throw validationError("badge must be an integer");
        aps.badge = input.badge;
      }
      if (input.category !== undefined) aps.category = requireNonempty(input.category, "category");
      if (input.threadId !== undefined) aps["thread-id"] = requireNonempty(input.threadId, "threadId");
      const collapseId = input.collapseId === undefined ? undefined : requireOriginCollapseId(input.collapseId);
      if (input.mutableContent === true) aps["mutable-content"] = 1;
      if (input.customData && Object.hasOwn(input.customData, "aps")) {
        throw validationError("customData must not contain aps");
      }
      const customData = input.customData === undefined
        ? {}
        : requirePlainObject(input.customData, "customData");
      assertJsonValue(customData, 0, new WeakSet<object>());
      const payload: Record<string, unknown> = { ...customData, aps };
      return await this.sendLogical({
        ...commonLogical(input, this.uuid, 10),
        ...(collapseId === undefined ? {} : { collapseId }),
        topic: this.config.ordinaryTopic,
        pushType: "alert",
        body: serializePayload(payload),
      });
    } catch (error) {
      return this.localFailure(error, input.apnsId);
    }
  }

  async sendActivity(input: ActivitySend): Promise<ApnsOutcome> {
    try {
      requirePlainObject(input.contentState, "contentState");
      const timestamp = input.providerTimestamp === undefined
        ? integerNowSeconds(this.clock)
        : requireProviderTimestamp(input.providerTimestamp, this.clock);
      const aps: Record<string, unknown> = {
        timestamp,
        event: input.operation,
        "content-state": input.contentState,
      };
      if (input.relevanceScore !== undefined) {
        if (!Number.isFinite(input.relevanceScore)) throw validationError("relevanceScore must be finite");
        aps["relevance-score"] = input.relevanceScore;
      }
      if (input.operation === "start") {
        aps["input-push-token"] = 1;
        aps["attributes-type"] = requireNonempty(input.attributesType, "attributesType");
        aps.attributes = requirePlainObject(input.attributes, "attributes");
        aps.alert = validateAlert(input.alert);
      } else if (input.operation === "update") {
        if (input.staleDate !== undefined) aps["stale-date"] = requireEpoch(input.staleDate, "staleDate");
        if (input.alert !== undefined) aps.alert = validateAlert(input.alert);
      } else if (input.operation === "end") {
        if (input.dismissalDate !== undefined) {
          aps["dismissal-date"] = requireEpoch(input.dismissalDate, "dismissalDate");
        }
      } else {
        throw validationError("Unknown ActivityKit operation");
      }
      return await this.sendLogical({
        ...commonLogical(input, this.uuid, input.operation === "update" ? 5 : 10),
        topic: this.config.activityTopic,
        pushType: "liveactivity",
        body: serializePayload({ aps }),
      });
    } catch (error) {
      return this.localFailure(error, input.apnsId);
    }
  }

  /** Call after explicit operator correction of a quarantined pool. */
  resetQuarantine(): void {
    this.pool.resetQuarantine();
  }

  /** Call on key revocation/replacement or binding changes before using a new provider. */
  async retireCredentials(): Promise<void> {
    this.jwt.clear();
    await this.pool.close();
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  /** Establishes the reusable TLS/HTTP2 session without creating an APNs request stream. */
  async warm(signal?: AbortSignal): Promise<void> {
    await this.pool.warm(signal);
  }

  private async sendLogical(logical: LogicalSend): Promise<ApnsOutcome> {
    if (logical.body.byteLength === 0 || logical.body.byteLength > 4_096) {
      throw validationError("Payload must contain 1 to 4096 UTF-8 bytes");
    }
    if (logical.confirmPayloadSha256) {
      let confirmed = false;
      try {
        confirmed = await logical.confirmPayloadSha256(
          createHash("sha256").update(logical.body).digest("hex"),
        );
      } catch {
        throw new SafeProviderError("pool-quarantined", "Durable payload confirmation failed");
      }
      if (!confirmed) throw validationError("Prepared payload does not match the durable logical send");
    }
    let attempt = 0;
    let expiredRetryUsed = false;
    let freshConnectionRetryUsed = false;
    let indeterminateRetries = 0;
    let firstAttemptAt = logical.providerFirstAttemptAtMs;
    const initialNow = this.clock.nowMs();
    if (firstAttemptAt !== undefined && firstAttemptAt > initialNow) {
      throw validationError("provider first-attempt epoch cannot be in the future");
    }
    let attemptCap = logical.providerRetryState.attemptCap;
    let retryHorizonAtMs = logical.providerRetryState.retryHorizonAtMs;
    let nextAttemptNotBeforeMs = logical.providerRetryState.nextAttemptNotBeforeMs;

    for (;;) {
      let now = this.clock.nowMs();
      if (deadlineReached(logical, now)) {
        return outcome(logical, "retry-exhausted", attempt);
      }
      if (retryHorizonAtMs !== undefined && now >= retryHorizonAtMs) {
        return outcome(logical, "retry-exhausted", attempt);
      }
      const totalAttemptsUsed = logical.priorProviderAttempts + attempt;
      if (attemptCap !== undefined && totalAttemptsUsed >= attemptCap) {
        return outcome(logical,"retry-exhausted",attempt);
      }
      if (nextAttemptNotBeforeMs !== undefined && now < nextAttemptNotBeforeMs) {
        if (deadlineReached(logical,nextAttemptNotBeforeMs)
          || (retryHorizonAtMs !== undefined && nextAttemptNotBeforeMs >= retryHorizonAtMs)) {
          return outcome(logical,"retry-exhausted",attempt);
        }
        try {
          await this.scheduler.sleep(nextAttemptNotBeforeMs-now,logical.signal);
        } catch {
          return outcome(logical,"retry-exhausted",attempt);
        }
        now = this.clock.nowMs();
        if (now < nextAttemptNotBeforeMs) return outcome(logical,"retry-exhausted",attempt);
        continue;
      }
      try {
        const preflightRecipient = await logical.recipient.resolve();
        if (!preflightRecipient) return outcome(logical, "stale-recipient", attempt);
        validateRecipient(preflightRecipient);
        if (this.isGenerationBlocked(logical.recipient, preflightRecipient.generation)) {
          return outcome(logical, "stale-recipient", attempt);
        }
      } catch (error) {
        return this.localFailure(error, logical.apnsId, logical.body.byteLength, attempt);
      }
      attempt += 1;
      firstAttemptAt ??= this.clock.nowMs();
      logical.providerFirstAttemptAtMs = firstAttemptAt;
      let dispatched: {
        result: TransportResult;
        record: ManagedConnection;
        context: SlotContext | undefined;
      };
      let inspectedDecision: Decision | undefined;
      try {
        dispatched = await this.pool.dispatch(
          logical.signal,
          async ({ result, context }) => {
            if (result.kind !== "response") return { accepted: false };
            inspectedDecision = classifyResponse(result, logical, attempt, this.config.responseBodyLimitBytes);
            if (inspectedDecision.action === "retry-expired-jwt") {
              if (!this.jwt.canCorrectExpired(context.jwt.token)) {
                return { accepted: false, quarantine: "provider-authentication" };
              }
              this.jwt.invalidateIfCurrent(context.jwt.token);
              return { accepted: false };
            }
            if (inspectedDecision.action === "retry-fresh-connection") {
              return { accepted: false, retire: true };
            }
            if (inspectedDecision.action !== "return") return { accepted: false };
            let quarantine = inspectedDecision.quarantine;
            if (inspectedDecision.invalidate) {
              this.blockGeneration(logical.recipient, context.recipient.generation);
              const details = inspectedDecision.outcome.invalidatedAtMs === undefined
                ? { environment: this.config.environment }
                : {
                    environment: this.config.environment,
                    invalidatedAtMs: inspectedDecision.outcome.invalidatedAtMs,
                  };
              try {
                if (isDispatchRecipient(context.recipient)) await context.recipient.invalidate(details);
                else await logical.recipient.invalidate(context.recipient.generation, details);
              } catch {
                quarantine = "pool-quarantined";
              }
            }
            return {
              accepted: inspectedDecision.outcome.accepted,
              ...(quarantine === undefined ? {} : { quarantine }),
            };
          },
          async () => {
            this.checkOpeningDeadline(logical, retryHorizonAtMs);
            const recipient = logical.recipient.acquire
              ? await logical.recipient.acquire()
              : await logical.recipient.resolve();
            if (!recipient) throw new SafeProviderError("stale-recipient", "No active recipient registration");
            try {
              this.checkOpeningDeadline(logical, retryHorizonAtMs);
              validateRecipient(recipient);
              if (this.isGenerationBlocked(logical.recipient, recipient.generation)) {
                throw new SafeProviderError("stale-recipient", "Recipient generation is inactive");
              }
              const jwt = this.jwt.get();
              this.checkOpeningDeadline(logical, retryHorizonAtMs);
              return {
                request: prepareRequest(this.config, logical, recipient.token, jwt.token),
                context: { recipient, jwt },
              };
            } catch (error) {
              if (isDispatchRecipient(recipient)) await recipient.release(false);
              throw error;
            }
          },
        );
      } catch (error) {
        return this.localFailure(error,logical.apnsId,logical.body.byteLength,attempt,firstAttemptAt);
      }

      if (dispatched.result.kind === "failure") {
        if (indeterminateRetries < logical.indeterminateRetries) {
          indeterminateRetries += 1;
          continue;
        }
        return {
          ...outcome(logical, "indeterminate-transport", attempt),
          transportCode: dispatched.result.code,
        };
      }

      if (!dispatched.context) {
        return outcome(logical, "bounded-protocol-failure", attempt, dispatched.result.status);
      }

      const decision = inspectedDecision
        ?? classifyResponse(dispatched.result, logical, attempt, this.config.responseBodyLimitBytes);
      if (decision.action === "return") {
        return decision.outcome;
      }
      if (decision.action === "retry-expired-jwt") {
        if (expiredRetryUsed || !this.jwt.canCorrectExpired(dispatched.context.jwt.token)) {
          return outcome(logical, "expired-provider-token", attempt, dispatched.result.status, "ExpiredProviderToken");
        }
        expiredRetryUsed = true;
        this.jwt.invalidateIfCurrent(dispatched.context.jwt.token);
        continue;
      }
      if (decision.action === "retry-fresh-connection") {
        if (freshConnectionRetryUsed) {
          return outcome(logical, "connection-key-binding", attempt, dispatched.result.status, "UnrelatedKeyIdInToken");
        }
        freshConnectionRetryUsed = true;
        this.pool.retire(dispatched.record);
        continue;
      }

      const activeRetryClass = decision.action === "retry-429" ? "429" : "5xx";
      const elapsed = this.clock.nowMs() - firstAttemptAt;
      const totalAttempts = logical.priorProviderAttempts + attempt;
      const retryPlan = decision.action === "retry-429"
        ? retry429Plan(totalAttempts, elapsed, this.config, this.random)
        : retry5xxPlan(totalAttempts, elapsed, this.config);
      const classHorizon = firstAttemptAt + retryHorizonMs(activeRetryClass,this.config);
      retryHorizonAtMs = retryHorizonAtMs === undefined
        ? classHorizon
        : Math.min(retryHorizonAtMs, classHorizon);
      attemptCap = attemptCap === undefined
        ? retryAttemptCap(activeRetryClass,this.config)
        : Math.min(attemptCap,retryAttemptCap(activeRetryClass,this.config));
      let retryAt = retryPlan === undefined
        ? retryHorizonAtMs
        : this.clock.nowMs()+retryPlan.delayMs;
      if (logical.persistProviderRetryState) {
        try {
          const proposed = {
            attemptCap,retryHorizonAtMs,nextAttemptNotBeforeMs: retryAt,
            attemptsUsed: totalAttempts,firstAttemptAtMs: firstAttemptAt,
          };
          const persisted = await logical.persistProviderRetryState(proposed);
          validatePersistedRetryState(persisted,proposed);
          attemptCap = persisted.attemptCap;
          retryHorizonAtMs = persisted.retryHorizonAtMs;
          retryAt = persisted.nextAttemptNotBeforeMs;
        } catch {
          return outcome(
            logical,"pool-quarantined",attempt,dispatched.result.status,
            safeReason(dispatched.result,this.config.responseBodyLimitBytes),
          );
        }
      }
      nextAttemptNotBeforeMs = retryAt;
      if (!retryPlan) {
        return outcome(
          logical,
          "retry-exhausted",
          attempt,
          dispatched.result.status,
          safeReason(dispatched.result, this.config.responseBodyLimitBytes),
        );
      }
      if (retryAt >= retryHorizonAtMs || deadlineReached(logical,retryAt)) {
        return outcome(
          logical,retryAt >= retryHorizonAtMs ? "retry-exhausted" : "retryable-not-scheduled",
          attempt,dispatched.result.status,
          safeReason(dispatched.result,this.config.responseBodyLimitBytes),
        );
      }
      try {
        await this.scheduler.sleep(Math.max(0,retryAt-this.clock.nowMs()), logical.signal);
      } catch {
        return outcome(
          logical,
          "retry-exhausted",
          attempt,
          dispatched.result.status,
          safeReason(dispatched.result, this.config.responseBodyLimitBytes),
        );
      }
    }
  }

  private localFailure(
    error: unknown,
    requestedApnsId?: string,
    payloadBytes = 0,
    attempt = 0,
    firstAttemptAtMs?: number,
  ): ApnsOutcome {
    const category = error instanceof SafeProviderError ? error.category : "validation";
    const apnsId = safeApnsId(requestedApnsId) ?? "00000000-0000-0000-0000-000000000000";
    return {
      accepted: false,category,attempt,apnsId,payloadBytes,
      ...(firstAttemptAtMs === undefined ? {} : { firstAttemptAtMs }),
    };
  }

  private blockGeneration(resolver: RecipientResolver, generation: string): void {
    const blocked = this.blockedGenerations.get(resolver) ?? new Set<string>();
    blocked.add(generation);
    this.blockedGenerations.set(resolver, blocked);
  }

  private isGenerationBlocked(resolver: RecipientResolver, generation: string): boolean {
    return this.blockedGenerations.get(resolver)?.has(generation) === true;
  }

  private checkOpeningDeadline(logical: LogicalSend, retryHorizonAtMs: number | undefined): void {
    const now = this.clock.nowMs();
    if (deadlineReached(logical, now) || (retryHorizonAtMs !== undefined && now >= retryHorizonAtMs)) {
      throw new SafeProviderError("retry-exhausted", "The logical send deadline was reached before dispatch");
    }
  }

  private classifyGoawayReason(reason: string | undefined): OutcomeCategory | undefined {
    if (!reason) return undefined;
    if (reason === "ExpiredProviderToken") {
      return this.jwt.invalidateForExpiredGoaway() ? undefined : "provider-authentication";
    }
    if (reason === "UnrelatedKeyIdInToken" || reason === "Shutdown") return undefined;
    if (reason === "TooManyProviderTokenUpdates") return "provider-token-cadence";
    if (reason === "BadEnvironmentKeyIdInToken") return "key-environment-configuration";
    if (reason === "Forbidden") return "forbidden";
    if (reason === "InvalidProviderToken" || reason === "MissingProviderToken") {
      return "provider-authentication";
    }
    if (reason === "BadCertificate" || reason === "BadCertificateEnvironment") {
      return "impossible-authentication-mode";
    }
    return undefined;
  }
}

function validateConfig(input: ApnsProviderConfig): ValidatedConfig {
  const teamId = requireIdentifier(input.teamId, "teamId");
  const keyId = requireIdentifier(input.keyId, "keyId");
  const bundleId = requireTopic(input.bundleId, "bundleId");
  const generation = requireNonempty(input.configurationGeneration, "configurationGeneration");
  if (input.environment !== "sandbox" && input.environment !== "production") {
    throw validationError("environment must be sandbox or production");
  }
  if (input.keyScope !== "team-scoped" && input.keyScope !== "topic-specific") {
    throw validationError("Unknown key scope");
  }
  if (!(["sandbox", "production", "both"] as const).includes(input.keyEnvironment)) {
    throw validationError("Unknown key environment authorization");
  }
  if (input.keyEnvironment === "both") {
    if (input.keyScope !== "team-scoped" || input.dualEnvironmentConfirmed !== true) {
      throw validationError("both requires a confirmed grandfathered team-scoped key");
    }
  } else if (input.keyEnvironment !== input.environment) {
    throw validationError("Key is not authorized for selected environment");
  }
  if (input.keyScope === "topic-specific" && input.keyEnvironment === "both") {
    throw validationError("Topic-specific keys cannot authorize both environments");
  }

  const ordinaryTopic = bundleId;
  const activityTopic = `${bundleId}.push-type.liveactivity`;
  const allowedTopics = canonicalTopics(input.allowedTopics, "allowedTopics", false);
  if (!allowedTopics.includes(ordinaryTopic) || !allowedTopics.includes(activityTopic)) {
    throw validationError("Deployment allowlist must include ordinary and Live Activity topics");
  }
  let appleAssociatedTopics: string[] = [];
  if (input.keyScope === "topic-specific") {
    appleAssociatedTopics = canonicalTopics(input.appleAssociatedTopics, "appleAssociatedTopics", false);
    if (allowedTopics.some((topic) => !appleAssociatedTopics.includes(topic))) {
      throw validationError("Deployment allowlist exceeds Apple topic associations");
    }
  } else if (input.appleAssociatedTopics) {
    appleAssociatedTopics = canonicalTopics(input.appleAssociatedTopics, "appleAssociatedTopics", true);
  }

  const key = parseSigningKey(input.privateKeyPem);
  const localConcurrencyCap = positiveInteger(input.localConcurrencyCap ?? 32, "localConcurrencyCap");
  if (localConcurrencyCap > 1_024) throw validationError("localConcurrencyCap exceeds the safety bound");
  const jwtRefreshSeconds = positiveInteger(input.jwtRefreshSeconds ?? 3_000, "jwtRefreshSeconds");
  if (jwtRefreshSeconds < 1_200 || jwtRefreshSeconds >= 3_600) {
    throw validationError("jwtRefreshSeconds must be from 1200 through 3599");
  }
  const connectTimeoutMs = positiveInteger(input.connectTimeoutMs ?? 10_000, "connectTimeoutMs");
  if (connectTimeoutMs > 10_000) throw validationError("connectTimeoutMs cannot exceed 10000");
  const requestTimeoutMs = positiveInteger(input.requestTimeoutMs ?? 15_000, "requestTimeoutMs");
  if (requestTimeoutMs > 15_000) throw validationError("requestTimeoutMs cannot exceed 15000");
  const responseBodyLimitBytes = positiveInteger(input.responseBodyLimitBytes ?? 16_384, "responseBodyLimitBytes");
  if (responseBodyLimitBytes > 16_384) throw validationError("responseBodyLimitBytes cannot exceed 16384");
  const max429Attempts = positiveInteger(input.max429Attempts ?? 4, "max429Attempts");
  if (max429Attempts > 4) throw validationError("max429Attempts cannot exceed 4");
  const retry429HorizonMs = positiveInteger(input.retry429HorizonMs ?? 300_000, "retry429HorizonMs");
  if (retry429HorizonMs > 300_000) throw validationError("retry429HorizonMs cannot exceed 300000");
  const retry429BaseDelayMs = positiveInteger(input.retry429BaseDelayMs ?? 1_000, "retry429BaseDelayMs");
  if (retry429BaseDelayMs > retry429HorizonMs) throw validationError("429 base delay exceeds its horizon");
  const max5xxAttempts = positiveInteger(input.max5xxAttempts ?? 3, "max5xxAttempts");
  if (max5xxAttempts > 3) throw validationError("max5xxAttempts cannot exceed 3");
  const retry5xxHorizonMs = positiveInteger(input.retry5xxHorizonMs ?? 3_600_000, "retry5xxHorizonMs");
  if (retry5xxHorizonMs < 3_600_000) throw validationError("5xx horizon cannot be shorter than 60 minutes");
  if (retry5xxHorizonMs > 86_400_000) throw validationError("5xx horizon cannot exceed 24 hours");
  if (retry5xxHorizonMs > 3_600_000 && input.allowExtended5xxHorizon !== true) {
    throw validationError("A 5xx horizon over 60 minutes requires explicit opt-in");
  }

  const authority = input.environment === "sandbox"
    ? "api.sandbox.push.apple.com:443"
    : "api.push.apple.com:443";
  const poolKey = createHash("sha256")
    .update(JSON.stringify({
      environment: input.environment,
      teamId,
      keyId,
      keyScope: input.keyScope,
      keyEnvironment: input.keyEnvironment,
      generation,
      appleAssociatedTopics,
      allowedTopics,
      topics: [ordinaryTopic, activityTopic],
    }))
    .digest("hex");

  return {
    ...input,
    teamId,
    keyId,
    bundleId,
    configurationGeneration: generation,
    allowedTopics,
    appleAssociatedTopics,
    authority,
    ordinaryTopic,
    activityTopic,
    key,
    poolKey,
    localConcurrencyCap,
    jwtRefreshSeconds,
    connectTimeoutMs,
    requestTimeoutMs,
    responseBodyLimitBytes,
    max429Attempts,
    retry429HorizonMs,
    retry429BaseDelayMs,
    max5xxAttempts,
    retry5xxHorizonMs,
  };
}

function parseSigningKey(pem: string): KeyObject {
  if (typeof pem !== "string" || pem.trim() === "") throw validationError("privateKeyPem is required");
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw validationError("APNs signing key must be P-256 EC");
    }
    return key;
  } catch (error) {
    if (error instanceof SafeProviderError) throw error;
    throw validationError("APNs signing key is malformed");
  }
}

function commonLogical(
  input: CommonSendOptions,
  uuid: () => string,
  defaultPriority: ApnsPriority,
): Pick<LogicalSend,
  "recipient" | "priority" | "expiration" | "validUntilMs" | "apnsId" |
  "indeterminateRetries" | "priorProviderAttempts" | "providerFirstAttemptAtMs" |
  "providerRetryState" | "persistProviderRetryState" | "confirmPayloadSha256" | "signal"
> {
  if (!input.recipient || typeof input.recipient.resolve !== "function" || typeof input.recipient.invalidate !== "function") {
    throw validationError("recipient resolver is required");
  }
  const priority = input.priority ?? defaultPriority;
  if (priority !== 5 && priority !== 10) throw validationError("priority must be 5 or 10");
  const expiration = input.expiration === undefined ? 0 : requireEpoch(input.expiration, "expiration");
  const validUntilMs = input.validUntilMs;
  if (validUntilMs !== undefined && (!Number.isSafeInteger(validUntilMs) || validUntilMs < 0)) {
    throw validationError("validUntilMs must be a nonnegative Unix millisecond timestamp");
  }
  if (expiration !== 0 && validUntilMs !== undefined && expiration * 1_000 > validUntilMs) {
    throw validationError("expiration must not extend beyond validUntilMs");
  }
  const apnsId = input.apnsId === undefined ? canonicalUuid(uuid()) : canonicalUuid(input.apnsId);
  const indeterminateRetries = input.indeterminateRetries ?? 0;
  if (!Number.isSafeInteger(indeterminateRetries) || indeterminateRetries < 0 || indeterminateRetries > 3) {
    throw validationError("indeterminateRetries must be an integer from 0 through 3");
  }
  const attemptState = input.providerAttemptState;
  const priorProviderAttempts = attemptState?.attemptsUsed ?? 0;
  if (!Number.isSafeInteger(priorProviderAttempts) || priorProviderAttempts < 0) {
    throw validationError("provider attempts used must be a nonnegative safe integer");
  }
  const providerFirstAttemptAtMs = attemptState?.firstAttemptAtMs;
  const providerRetryState: ProviderRetryState = {
    ...(attemptState?.attemptCap === undefined ? {} : { attemptCap: attemptState.attemptCap }),
    ...(attemptState?.retryHorizonAtMs === undefined ? {} : { retryHorizonAtMs: attemptState.retryHorizonAtMs }),
    ...(attemptState?.nextAttemptNotBeforeMs === undefined
      ? {} : { nextAttemptNotBeforeMs: attemptState.nextAttemptNotBeforeMs }),
  };
  if (priorProviderAttempts === 0
    && (providerFirstAttemptAtMs !== undefined || Object.keys(providerRetryState).length > 0)) {
    throw validationError("provider attempt history requires at least one prior attempt");
  }
  if (priorProviderAttempts > 0
    && (providerFirstAttemptAtMs === undefined || !Number.isSafeInteger(providerFirstAttemptAtMs)
      || providerFirstAttemptAtMs < 0)) {
    throw validationError("prior provider attempts require a nonnegative first-attempt epoch");
  }
  validateProviderRetryState(providerRetryState,providerFirstAttemptAtMs);
  const base = {
    recipient: input.recipient,priority,expiration,apnsId,indeterminateRetries,priorProviderAttempts,
  };
  return {
    ...base,
    ...(validUntilMs === undefined ? {} : { validUntilMs }),
    ...(providerFirstAttemptAtMs === undefined ? {} : { providerFirstAttemptAtMs }),
    providerRetryState,
    ...(input.persistProviderRetryState === undefined
      ? {} : { persistProviderRetryState: input.persistProviderRetryState }),
    ...(input.confirmPayloadSha256 === undefined ? {} : { confirmPayloadSha256: input.confirmPayloadSha256 }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function prepareRequest(
  config: ValidatedConfig,
  logical: LogicalSend,
  recipientToken: string,
  jwt: string,
): PreparedApnsRequest {
  const pathToken = encodeURIComponent(validateToken(recipientToken));
  return {
    method: "POST",
    authority: config.authority,
    path: `/3/device/${pathToken}`,
    headers: Object.freeze({
      authorization: `bearer ${jwt}`,
      "content-type": "application/json",
      "apns-topic": logical.topic,
      "apns-push-type": logical.pushType,
      "apns-priority": String(logical.priority),
      "apns-expiration": String(logical.expiration),
      "apns-id": logical.apnsId,
      ...(logical.collapseId === undefined ? {} : { "apns-collapse-id": logical.collapseId }),
    }),
    hpack: Object.freeze({
      neverIndex: [":path", "authorization"],
      normalIndex: ["content-type", "apns-topic", "apns-push-type", "apns-priority"],
      nameOnlyIndex: ["apns-id", "apns-expiration", "apns-collapse-id"],
    }),
    body: logical.body,
    responseBodyLimitBytes: config.responseBodyLimitBytes,
  };
}

function classifyResponse(
  response: Extract<TransportResult, { kind: "response" }>,
  logical: LogicalSend,
  attempt: number,
  bodyLimit: number,
): Decision {
  const status = response.status;
  const oversized = response.bodyTruncated === true || response.body.byteLength > bodyLimit;
  const metadata = oversized ? undefined : parseResponseMetadata(response.body);
  const reason = metadata?.reason;
  const base = outcome(logical, "permanent-apns-rejection", attempt, status, boundedReason(reason));
  const responseApnsId = findHeader(response.headers, "apns-id");
  if (responseApnsId && safeApnsId(responseApnsId)) base.responseApnsId = responseApnsId.toLowerCase();

  const bodyUnavailableStatus = status === 403 || status === 410 || status === 429 || (status >= 500 && status <= 599);
  if (oversized && !bodyUnavailableStatus) {
    return { action: "return", outcome: withoutReason(base, "bounded-protocol-failure") };
  }

  if (status === 200) return { action: "return", outcome: { ...base, accepted: true, category: "accepted" } };
  if (status === 410) {
    const invalidatedAtMs = validInvalidationTimestamp(metadata?.timestamp);
    return {
      action: "return",
      invalidate: true,
      outcome: {
        ...base,
        category: "invalid-recipient",
        ...(invalidatedAtMs === undefined ? {} : { invalidatedAtMs }),
      },
    };
  }
  if (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) {
    return { action: "return", invalidate: true, outcome: { ...base, category: "invalid-recipient" } };
  }
  if (status === 400 && (reason === "BadTopic" || reason === "MissingTopic" || reason === "TopicDisallowed")) {
    return { action: "return", outcome: { ...base, category: "topic-configuration" } };
  }
  if (status === 403) {
    if (oversized || !reason) {
      return {
        action: "return",
        quarantine: "ambiguous-authorization",
        outcome: withoutReason(base, "ambiguous-authorization"),
      };
    }
    if (reason === "ExpiredProviderToken") return { action: "retry-expired-jwt" };
    if (reason === "UnrelatedKeyIdInToken") return { action: "retry-fresh-connection" };
    const categories: Readonly<Record<string, OutcomeCategory>> = {
      BadEnvironmentKeyIdInToken: "key-environment-configuration",
      Forbidden: "forbidden",
      InvalidProviderToken: "provider-authentication",
      MissingProviderToken: "provider-authentication",
      BadCertificate: "impossible-authentication-mode",
      BadCertificateEnvironment: "impossible-authentication-mode",
    };
    const category = categories[reason];
    if (category) return { action: "return", quarantine: category, outcome: { ...base, category } };
    return {
      action: "return",
      quarantine: "ambiguous-authorization",
      outcome: withoutReason(base, "ambiguous-authorization"),
    };
  }
  if (status === 429) {
    if (!oversized && reason === "TooManyRequests") return { action: "retry-429" };
    if (!oversized && reason === "TooManyProviderTokenUpdates") {
      return {
        action: "return",
        quarantine: "provider-token-cadence",
        outcome: { ...base, category: "provider-token-cadence" },
      };
    }
    return {
      action: "return",
      quarantine: "ambiguous-rate-limit",
      outcome: withoutReason(base, "ambiguous-rate-limit"),
    };
  }
  if (status >= 500 && status <= 599) return { action: "retry-5xx" };
  return { action: "return", outcome: base };
}

function withoutReason(base: ApnsOutcome, category: OutcomeCategory): ApnsOutcome {
  const { reason: _discarded, ...safe } = base;
  return { ...safe, category };
}

function outcome(
  logical: LogicalSend,
  category: OutcomeCategory,
  attempt: number,
  status?: number,
  reason?: string,
): ApnsOutcome {
  return {
    accepted: category === "accepted",
    category,
    attempt,
    apnsId: logical.apnsId,
    payloadBytes: logical.body.byteLength,
    ...(logical.providerFirstAttemptAtMs === undefined
      ? {}
      : { firstAttemptAtMs: logical.providerFirstAttemptAtMs }),
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function retryAttemptCap(
  retryClass: "429" | "5xx" | undefined,
  config: ValidatedConfig,
): number {
  return retryClass === "429" ? config.max429Attempts
    : retryClass === "5xx" ? config.max5xxAttempts
      : Math.min(config.max429Attempts,config.max5xxAttempts);
}

function retryHorizonMs(retryClass: "429" | "5xx", config: ValidatedConfig): number {
  return retryClass === "429" ? config.retry429HorizonMs : config.retry5xxHorizonMs;
}

function validateProviderRetryState(
  state: ProviderRetryState,
  firstAttemptAtMs: number | undefined,
): void {
  const values = [state.attemptCap,state.retryHorizonAtMs,state.nextAttemptNotBeforeMs];
  const present = values.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== values.length) {
    throw validationError("provider retry state must include cap, horizon, and next-attempt time together");
  }
  if (present === 0) return;
  if (!Number.isSafeInteger(state.attemptCap) || state.attemptCap! < 1) {
    throw validationError("provider retry attempt cap must be a positive safe integer");
  }
  if (!Number.isSafeInteger(state.retryHorizonAtMs) || state.retryHorizonAtMs! < 0
    || !Number.isSafeInteger(state.nextAttemptNotBeforeMs) || state.nextAttemptNotBeforeMs! < 0) {
    throw validationError("provider retry timestamps must be nonnegative safe integers");
  }
  if (firstAttemptAtMs === undefined || state.retryHorizonAtMs! <= firstAttemptAtMs
    || state.nextAttemptNotBeforeMs! < firstAttemptAtMs) {
    throw validationError("provider retry timestamps are inconsistent with the first attempt");
  }
}

function validatePersistedRetryState(
  persisted: Required<ProviderRetryState>,
  proposed: Required<ProviderRetryState>,
): void {
  validateProviderRetryState(persisted,0);
  if (persisted.attemptCap > proposed.attemptCap
    || persisted.retryHorizonAtMs > proposed.retryHorizonAtMs
    || persisted.nextAttemptNotBeforeMs < proposed.nextAttemptNotBeforeMs) {
    throw validationError("durable provider retry state weakened the proposed policy");
  }
}

function retry429Plan(
  attempt: number,
  elapsed: number,
  config: ValidatedConfig,
  random: RandomSource,
): { delayMs: number } | undefined {
  if (attempt >= config.max429Attempts) return undefined;
  const sample = random.next();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new SafeProviderError("validation", "Random source returned an invalid sample");
  }
  const base = config.retry429BaseDelayMs * 2 ** (attempt - 1);
  const delayMs = Math.floor(base * (0.75 + sample * 0.5));
  if (elapsed + delayMs > config.retry429HorizonMs) return undefined;
  return { delayMs };
}

function retry5xxPlan(
  attempt: number,
  elapsed: number,
  config: ValidatedConfig,
): { delayMs: number } | undefined {
  if (attempt >= config.max5xxAttempts) return undefined;
  const delayMs = attempt === 1 ? 900_000 : 1_800_000 * 2 ** (attempt - 2);
  if (elapsed + delayMs > config.retry5xxHorizonMs) return undefined;
  return { delayMs };
}

function deadlineReached(logical: LogicalSend, atMs: number): boolean {
  if (logical.validUntilMs !== undefined && atMs >= logical.validUntilMs) return true;
  return logical.expiration !== 0 && atMs >= logical.expiration * 1_000;
}

function serializePayload(payload: Record<string, unknown>): Uint8Array {
  assertJsonValue(payload, 0, new WeakSet<object>());
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw validationError("Payload is not JSON serializable");
  }
  if (!json) throw validationError("Payload must serialize to a JSON object");
  return Buffer.from(json, "utf8");
}

function validateNegotiatedSecurity(security: NegotiatedSecurity, servername: string): void {
  const allowedTls = security.tlsVersion === "TLSv1.2" || security.tlsVersion === "TLSv1.3";
  if (
    !allowedTls ||
    security.alpnProtocol !== "h2" ||
    security.authorized !== true ||
    security.hostnameVerified !== true ||
    security.servername !== servername
  ) {
    throw new SafeProviderError("indeterminate-transport", "APNs transport security negotiation failed");
  }
}

function parseResponseMetadata(body: Uint8Array): { reason?: string; timestamp?: unknown } | undefined {
  if (body.byteLength === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
    if (!isPlainObject(parsed)) return undefined;
    const result: { reason?: string; timestamp?: unknown } = {};
    if (typeof parsed.reason === "string" && parsed.reason.length <= 128 && /^[\x20-\x7e]+$/.test(parsed.reason)) {
      result.reason = parsed.reason;
    }
    if (Object.hasOwn(parsed, "timestamp")) result.timestamp = parsed.timestamp;
    return result;
  } catch {
    return undefined;
  }
}

function safeReason(
  response: Extract<TransportResult, { kind: "response" }>,
  bodyLimit: number,
): string | undefined {
  if (response.bodyTruncated || response.body.byteLength > bodyLimit) return undefined;
  return boundedReason(parseResponseMetadata(response.body)?.reason);
}

function findHeader(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  wanted: string,
): string | undefined {
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === wanted && value !== undefined) return value;
  }
  return undefined;
}

function boundedReason(reason: string | undefined): string | undefined {
  return reason && reason.length <= 128 && /^[\x20-\x7e]+$/.test(reason) ? reason : undefined;
}

function validInvalidationTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeGoaway(event: GoawayEvent | undefined, limit: number): string | undefined {
  if (!event || event.diagnosticTruncated || !event.diagnostic || event.diagnostic.byteLength > limit) return undefined;
  return boundedReason(parseResponseMetadata(event.diagnostic)?.reason);
}

function validateRecipient(recipient: ResolvedRecipient): void {
  validateToken(recipient.token);
  requireNonempty(recipient.generation, "recipient generation");
}

function validateToken(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw validationError("Recipient token is malformed");
  }
  return value;
}

function validateAlert(value: unknown): string | Record<string, unknown> {
  if (typeof value === "string" && value.length > 0) return value;
  if (isPlainObject(value)) return value;
  throw validationError("alert must be a nonempty string or object");
}

function requirePlainObject(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw validationError(`${name} must be an object`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, depth: number, ancestors: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw validationError("Payload numbers must be finite");
    return;
  }
  if (typeof value !== "object") throw validationError("Payload contains a non-JSON value");
  if (depth >= 64) throw validationError("Payload nesting exceeds the safety bound");
  if (ancestors.has(value)) throw validationError("Payload must not contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
          throw validationError("Payload arrays must not contain custom properties");
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw validationError("Payload arrays must not be sparse");
        assertJsonValue(value[index], depth + 1, ancestors);
      }
      return;
    }
    if (!isPlainObject(value)) throw validationError("Payload objects must be plain JSON objects");
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw validationError("Payload object keys must be strings");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw validationError("Payload objects must contain enumerable data properties only");
      }
      assertJsonValue(descriptor.value, depth + 1, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function requireEpoch(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw validationError(`${name} must be a nonnegative integer epoch`);
  return value;
}

function requireProviderTimestamp(value: number, clock: Clock): number {
  const timestamp = requireEpoch(value, "providerTimestamp");
  if (timestamp > integerNowSeconds(clock)) {
    throw validationError("providerTimestamp must not be in the future");
  }
  return timestamp;
}

function requireIdentifier(value: string, name: string): string {
  const result = requireNonempty(value, name);
  if (!/^[A-Za-z0-9]{10}$/.test(result)) throw validationError(`${name} must be exactly 10 alphanumeric characters`);
  return result;
}

function requireTopic(value: string, name: string): string {
  const result = requireNonempty(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(result)) throw validationError(`${name} is malformed`);
  return result;
}

function requireNonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw validationError(`${name} is required and must not contain control characters`);
  }
  return value;
}

function requireOriginCollapseId(value: unknown): string {
  const collapseId = requireNonempty(value,"collapseId");
  if (!/^org_[A-Za-z0-9_-]{43}$/.test(collapseId)) {
    throw validationError("collapseId must be a canonical Relo origin hash");
  }
  return collapseId;
}

function canonicalTopics(values: readonly string[] | undefined, name: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) throw validationError(`${name} must be nonempty`);
  const result = [...new Set(values.map((value) => requireTopic(value, name)))].sort();
  if (!allowEmpty && result.length === 0) throw validationError(`${name} must be nonempty`);
  return result;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw validationError(`${name} must be a positive integer`);
  return value;
}

function canonicalUuid(value: string): string {
  const result = safeApnsId(value);
  if (!result) throw validationError("apnsId must be a canonical UUID");
  return result;
}

function safeApnsId(value: string | undefined): string | undefined {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return undefined;
  }
  return value.toLowerCase();
}

function integerNowSeconds(clock: Clock): number {
  const now = clock.nowMs();
  if (!Number.isFinite(now) || now < 0) throw new SafeProviderError("provider-authentication", "Clock is invalid");
  return Math.floor(now / 1_000);
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function normalizePeerLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isDispatchRecipient(value: ResolvedRecipient): value is DispatchRecipient {
  const candidate = value as Partial<DispatchRecipient>;
  return typeof candidate.invalidate === "function" && typeof candidate.release === "function";
}

function validationError(message: string): SafeProviderError {
  return new SafeProviderError("validation", message);
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function linkedAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

async function raceTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  scheduler: Scheduler,
  controller: AbortController,
): Promise<T> {
  const timeout = scheduler.sleep(timeoutMs, controller.signal).then(() => {
    controller.abort();
    throw abortError();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    controller.abort();
  }
}
