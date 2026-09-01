import { createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";

type ApnsConfig = {
  mode: "production" | "sandbox";
  teamId: string;
  keyId: string;
  privateKey: string;
  topic: string;
};

export type ApnsMessage = {
  token: string;
  environment: "production" | "sandbox";
  title: string;
  body: string;
  sourceName?: string | null;
  conversationId?: string | null;
  avatarUrl?: string | null;
  imageUrl?: string | null;
  deepLink?: string | null;
  notificationId: string;
  interactionKind?: "approval" | "yes_no" | "text" | null;
  badge?: number;
  data?: Record<string, unknown>;
  expiresAt?: Date | null;
};

export type LiveActivityApnsMessage = {
  token: string;
  environment: "production" | "sandbox";
  operation: "start" | "update" | "end";
  command: Record<string, unknown>;
  expiresAt?: Date | null;
};

const apnsCategories = {
  approval: "RELO_APPROVAL",
  yes_no: "RELO_YES_NO",
  text: "RELO_TEXT",
} as const;

export function apnsCategory(kind: ApnsMessage["interactionKind"]): string | undefined {
  return kind ? apnsCategories[kind] : undefined;
}

export class ApnsPayloadTooLargeError extends Error {
  readonly code = "apns_payload_too_large";
  constructor(readonly size: number) {
    super(`Ordinary APNs payload is ${size} bytes; maximum is 4096 bytes`);
    this.name = "ApnsPayloadTooLargeError";
  }
}

function apnsCustomData(
  value: Record<string,unknown> | undefined,
  includeContext: boolean,
): Record<string,unknown> {
  if (!value) return {};
  const result: Record<string,unknown> = {};
  if (value.privacy === "standard" || value.privacy === "private") result.privacy = value.privacy;
  if (value.interactionType === "approval" || value.interactionType === "yes_no" || value.interactionType === "text") {
    result.interactionType = value.interactionType;
  }
  if (typeof value.interactionId === "string" && /^int_[A-Za-z0-9-]{8,}$/.test(value.interactionId)) {
    result.interactionId = value.interactionId;
  }
  if (includeContext && value.context && typeof value.context === "object" && !Array.isArray(value.context)) {
    const source = value.context as Record<string,unknown>;
    const context = Object.fromEntries(["providerName","computer","project","threadName","taskTitle"]
      .filter((key) => typeof source[key] === "string")
      .map((key) => [key,source[key]]));
    if (Object.keys(context).length) result.context = context;
  }
  if (value.liveActivity && typeof value.liveActivity === "object" && !Array.isArray(value.liveActivity)) {
    const source = value.liveActivity as Record<string,unknown>;
    const allowed = [
      "operation","activityId","generation","targetDeviceId","style","sourceName","headline","detail",
      "status","progress","symbol","privacy","privacyMode","accentColor","expiresAt","staleAt",
      "alertOwner","sequence","dismissAfterSeconds",
    ];
    result.liveActivity = Object.fromEntries(allowed
      .filter((key) => source[key] === null || ["string","number"].includes(typeof source[key]))
      .map((key) => [key,source[key]]));
  }
  return result;
}

export function apnsPayload(message: ApnsMessage): Record<string,unknown> {
  const category = apnsCategory(message.interactionKind);
  const isPrivate = message.data?.privacy === "private";
  const sourceName = typeof message.sourceName === "string" && message.sourceName.trim()
    ? message.sourceName.trim().slice(0,80) : "Relo";
  const payload = {
    aps: {
      alert: isPrivate
        ? { title: "Relo", body: "New private notification" }
        : { title: message.title, body: message.body },
      sound: "default",
      ...(Number.isSafeInteger(message.badge) && message.badge! >= 0 ? { badge: message.badge } : {}),
      "mutable-content": 1,
      ...(category ? { category } : {}),
    },
    relo: {
      ...apnsCustomData(message.data,!isPrivate),
      notificationId: message.notificationId,
      sourceName: isPrivate ? "Relo" : sourceName,
      ...(isPrivate || !message.conversationId ? {} : { conversationId: message.conversationId }),
      avatarUrl: isPrivate ? null : (message.avatarUrl ?? null),
      imageUrl: isPrivate ? null : message.imageUrl,
      deepLink: isPrivate ? null : message.deepLink,
    },
  };
  const size = Buffer.byteLength(JSON.stringify(payload));
  if (size > 4_096) throw new ApnsPayloadTooLargeError(size);
  return payload;
}

export function liveActivityApnsPayload(message: LiveActivityApnsMessage): Record<string,unknown> {
  const command = message.command;
  const activityGeneration = command.generation;
  if (!Number.isSafeInteger(activityGeneration) || Number(activityGeneration) <= 0) {
    throw new Error("Live Activity generation must be a positive integer");
  }
  const privacy = command.privacy === "private" || command.privacyMode === "private" ? "private" : "standard";
  const isPrivate = privacy === "private";
  const now = Math.floor(Date.now() / 1_000);
  const sequence = typeof command.sequence === "number" ? Math.max(0,Math.trunc(command.sequence)) : 0;
  const style = typeof command.style === "string" ? command.style : "standard";
  const symbol = typeof command.symbol === "string" && ["terminal","code","build","success","warning"].includes(command.symbol)
    ? command.symbol
    : "terminal";
  const accentColor = typeof command.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(command.accentColor)
    ? command.accentColor
    : "#5ED8B7";
  const staleTimestamp = typeof command.staleAt === "string"
    ? Math.floor(new Date(command.staleAt).getTime()/1_000)
    : Number.NaN;
  const contentState = {
    generation: Number(activityGeneration),
    headline: isPrivate ? "Private activity" : String(command.headline ?? "Relo activity"),
    detail: isPrivate ? null : (typeof command.detail === "string" ? command.detail : null),
    progress: isPrivate ? null : (typeof command.progress === "number" ? command.progress : null),
    status: isPrivate ? "Open Relo to view" : String(command.status ?? "In progress"),
    updatedAt: now,
    sequence,
    style: isPrivate ? "standard" : style,
    symbol: isPrivate ? "terminal" : symbol,
    accentColor: isPrivate ? "#5ED8B7" : accentColor,
    privacy,
    expiresAt: typeof command.expiresAt === "string" ? command.expiresAt : null,
    staleAt: typeof command.staleAt === "string" ? command.staleAt : null,
    primaryLabel: isPrivate ? null : (typeof command.primaryLabel === "string" ? command.primaryLabel : null),
    secondaryLabel: isPrivate ? null : (typeof command.secondaryLabel === "string" ? command.secondaryLabel : null),
    interaction: isPrivate ? null : (command.interaction ?? null),
  };
  const aps: Record<string,unknown> = {
    timestamp: now,
    event: message.operation,
    "content-state": contentState,
    "stale-date": Number.isFinite(staleTimestamp) ? Math.max(now,staleTimestamp) : now + 600,
  };
  if (message.operation === "start") {
    aps["attributes-type"] = "ReloActivityAttributes";
    aps.attributes = {
      eventID: String(command.activityId ?? ""),
      generation: Number(activityGeneration),
      sourceName: isPrivate ? "Relo" : String(command.sourceName ?? "Relo"),
      style: isPrivate ? "standard" : style,
    };
    aps.alert = {
      title: isPrivate ? "Agent task started" : String(command.headline ?? "Relo activity"),
      body: isPrivate ? "Open Relo to view progress." : String(command.status ?? "In progress"),
    };
    aps["input-push-token"] = 1;
  }
  if (message.operation === "end") {
    const dismiss = typeof command.dismissAfterSeconds === "number"
      ? Math.max(0,Math.min(14_400,Math.trunc(command.dismissAfterSeconds)))
      : 0;
    aps["dismissal-date"] = now + dismiss;
  }
  const payload = { aps };
  if (Buffer.byteLength(JSON.stringify(payload)) > 4_096) {
    throw new Error("Live Activity APNs payload exceeds 4096 bytes");
  }
  return payload;
}

export type ApnsResult =
  | { kind: "accepted"; providerMessageId?: string }
  | { kind: "retry"; code: string; message: string }
  | { kind: "invalid_token"; code: string; message: string }
  | { kind: "rejected"; code: string; message: string };

export function apnsErrorResult(error: unknown): ApnsResult {
  return error instanceof ApnsPayloadTooLargeError
    ? { kind: "rejected", code: error.code, message: error.message }
    : { kind: "retry", code: "transport_error", message: error instanceof Error ? error.message : "unknown" };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function providerToken(config: ApnsConfig): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${base64url(signature)}`;
}

export class ApnsClient {
  constructor(private readonly config: ApnsConfig) {}

  async send(message: ApnsMessage): Promise<ApnsResult> {
    return this.perform(
      message.token,
      message.environment,
      {
        "apns-topic": this.config.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(message.expiresAt ? Math.floor(message.expiresAt.getTime() / 1000) : Math.floor(Date.now() / 1000) + 86_400),
      },
      apnsPayload(message),
    );
  }

  async sendLiveActivity(message: LiveActivityApnsMessage): Promise<ApnsResult> {
    return this.perform(
      message.token,
      message.environment,
      {
        "apns-topic": `${this.config.topic}.push-type.liveactivity`,
        "apns-push-type": "liveactivity",
        "apns-priority": "10",
        "apns-expiration": String(message.expiresAt ? Math.floor(message.expiresAt.getTime() / 1000) : Math.floor(Date.now() / 1000) + 86_400),
      },
      liveActivityApnsPayload(message),
    );
  }

  private async perform(
    token: string,
    environment: "production" | "sandbox",
    headers: Record<string,string>,
    payload: Record<string,unknown>,
  ): Promise<ApnsResult> {
    if (environment !== this.config.mode) {
      return { kind: "rejected", code: "environment_mismatch", message: "Device token environment does not match worker" };
    }
    const authority = this.config.mode === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    const client = connect(authority);
    try {
      return await new Promise<ApnsResult>((resolve, reject) => {
        let settled = false;
        const finish = (result: ApnsResult) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const request = client.request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${providerToken(this.config)}`,
          ...headers,
        });
        let status = 0;
        let apnsId: string | undefined;
        let response = "";
        request.setEncoding("utf8");
        request.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
          apnsId = typeof headers["apns-id"] === "string" ? headers["apns-id"] : undefined;
        });
        request.on("data", (chunk) => { response += chunk; });
        const timeout = setTimeout(() => {
          request.close();
          finish({ kind: "retry", code: "request_timeout", message: "APNs request timed out" });
        },15_000);
        client.once("error", (error) => {
          clearTimeout(timeout);
          if (!settled) reject(error);
        });
        request.on("error", (error) => {
          clearTimeout(timeout);
          if (!settled) reject(error);
        });
        request.on("end", () => {
          clearTimeout(timeout);
          if (status === 200) return finish(apnsId ? { kind: "accepted", providerMessageId: apnsId } : { kind: "accepted" });
          let reason = "APNs request failed";
          try { reason = (JSON.parse(response) as { reason?: string }).reason ?? reason; } catch { /* non-JSON response */ }
          if (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic" || reason === "Unregistered") {
            return finish({ kind: "invalid_token", code: reason, message: reason });
          }
          if (status === 429 || status >= 500) return finish({ kind: "retry", code: reason, message: reason });
          return finish({ kind: "rejected", code: reason, message: reason });
        });
        request.end(JSON.stringify(payload));
      });
    } finally {
      client.close();
    }
  }
}
