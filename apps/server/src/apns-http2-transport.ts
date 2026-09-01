import {
  connect,
  constants,
  sensitiveHeaders,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http2";
import { checkServerIdentity, type PeerCertificate, type TLSSocket } from "node:tls";
import type {
  ApnsConnection,
  ApnsStream,
  ApnsTransport,
  GoawayEvent,
  PreparedApnsRequest,
  TransportBinding,
  TransportResult,
} from "./apns-provider-cleanroom.js";

const goawayDiagnosticLimit = 16_384;

export type NodeHttp2TransportOptions = {
  /** Additional trust anchors are intended for deterministic local protocol tests only. */
  ca?: string | Buffer | (string | Buffer)[];
};

export class NodeHttp2ApnsTransport implements ApnsTransport {
  constructor(private readonly options: NodeHttp2TransportOptions = {}) {}

  async open(binding: TransportBinding, signal: AbortSignal): Promise<ApnsConnection> {
    if (signal.aborted) throw abortError();
    let hostnameVerified = false;
    const session = connect(`https://${binding.authority}`, {
      ALPNProtocols: [...binding.tls.alpnProtocols],
      minVersion: binding.tls.minimumVersion,
      rejectUnauthorized: true,
      servername: binding.servername,
      ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
      checkServerIdentity(hostname: string, certificate: PeerCertificate) {
        const error = checkServerIdentity(hostname, certificate);
        hostnameVerified = error === undefined;
        return error;
      },
    });
    const abort = () => session.destroy(abortError());
    signal.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          session.off("remoteSettings", ready);
          session.off("error", failed);
        };
        session.once("remoteSettings", ready);
        session.once("error", failed);
      });
    } catch (error) {
      session.destroy();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
    const socket = session.socket as TLSSocket;
    return new NodeHttp2ApnsConnection(session, {
      tlsVersion: socket.getProtocol() ?? "",
      alpnProtocol: socket.alpnProtocol || "",
      authorized: socket.authorized === true,
      hostnameVerified,
      servername: binding.servername,
    }, session.remoteSettings.maxConcurrentStreams);
  }
}

class NodeHttp2ApnsConnection implements ApnsConnection {
  readonly security;
  private readonly settingsListeners = new Set<(maximumConcurrentStreams: number) => void>();
  private readonly goawayListeners = new Set<(event: GoawayEvent) => void>();
  private nextStreamId = 1;
  private closed = false;
  private terminalNotified = false;
  private peerLimit: number | undefined;

  constructor(
    private readonly session: ClientHttp2Session,
    security: ApnsConnection["security"],
    initialPeerLimit: number | undefined,
  ) {
    this.security = security;
    this.peerLimit = initialPeerLimit;
    this.session.on("remoteSettings", (settings) => {
      const limit = settings.maxConcurrentStreams;
      if (typeof limit === "number") {
        this.peerLimit = limit;
        for (const listener of this.settingsListeners) listener(limit);
      }
    });
    this.session.on("goaway", (_errorCode, lastStreamId, opaqueData) => {
      this.terminalNotified = true;
      const event = boundedGoawayEvent(lastStreamId, opaqueData);
      for (const listener of this.goawayListeners) listener(event);
    });
    this.session.on("error", () => this.notifyTransportEnd());
    this.session.on("close", () => this.notifyTransportEnd());
  }

  openStream(request: PreparedApnsRequest, signal: AbortSignal): ApnsStream {
    if (signal.aborted) throw abortError();
    const headers = prepareNodeHttp2Headers(request);
    const stream = this.session.request(headers, { endStream: false });
    const streamId = stream.id ?? this.nextStreamId;
    this.nextStreamId = streamId + 2;
    const abort = () => stream.close(constants.NGHTTP2_CANCEL);
    signal.addEventListener("abort", abort, { once: true });
    const result = collectResult(stream, request.responseBodyLimitBytes)
      .finally(() => signal.removeEventListener("abort", abort));
    stream.end(request.body);
    return {
      streamId,
      result,
      cancel: abort,
    };
  }

  onPeerSettings(listener: (maximumConcurrentStreams: number) => void): () => void {
    this.settingsListeners.add(listener);
    if (this.peerLimit !== undefined) listener(this.peerLimit);
    return () => this.settingsListeners.delete(listener);
  }

  onGoaway(listener: (event: GoawayEvent) => void): () => void {
    this.goawayListeners.add(listener);
    return () => this.goawayListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.settingsListeners.clear();
    this.goawayListeners.clear();
    this.session.close();
  }

  private notifyTransportEnd(): void {
    if (this.closed || this.terminalNotified) return;
    this.terminalNotified = true;
    for (const listener of this.goawayListeners) listener({ lastStreamId: 0 });
  }
}

export function prepareNodeHttp2Headers(request: PreparedApnsRequest): OutgoingHttpHeaders {
  return {
    ":method": request.method,
    ":scheme": "https",
    ":authority": request.authority,
    ":path": request.path,
    ...request.headers,
    [sensitiveHeaders]: [...request.hpack.neverIndex, ...request.hpack.nameOnlyIndex],
  };
}

export function boundedGoawayEvent(lastStreamId: number, opaqueData?: Uint8Array): GoawayEvent {
  const diagnostic = opaqueData && opaqueData.byteLength > 0
    ? opaqueData.subarray(0, goawayDiagnosticLimit)
    : undefined;
  return {
    lastStreamId,
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(opaqueData && opaqueData.byteLength > goawayDiagnosticLimit
      ? { diagnosticTruncated: true }
      : {}),
  };
}

function collectResult(stream: ClientHttp2Stream, limit: number): Promise<TransportResult> {
  return new Promise((resolve) => {
    let settled = false;
    let status = 0;
    let responseHeaders: IncomingHttpHeaders | undefined;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const finish = (result: TransportResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    stream.once("response", (headers) => {
      responseHeaders = headers;
      status = typeof headers[":status"] === "number" ? headers[":status"] : 0;
    });
    stream.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = limit + 1 - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const bounded = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(bounded);
      bytes += bounded.byteLength;
      if (bytes > limit || bounded.byteLength < chunk.byteLength) {
        truncated = true;
        finish(responseResult(status, responseHeaders, chunks, bytes, true));
        stream.close(constants.NGHTTP2_CANCEL);
      }
    });
    stream.once("end", () => {
      finish(status === 0
        ? { kind: "failure", code: "reset" }
        : responseResult(status, responseHeaders, chunks, bytes, truncated));
    });
    stream.once("aborted", () => finish({ kind: "failure", code: "reset" }));
    stream.once("error", (error: NodeJS.ErrnoException) => {
      const code = error.code === "ERR_HTTP2_STREAM_CANCEL" || error.code === "ERR_HTTP2_STREAM_ERROR"
        ? "reset"
        : "protocol";
      finish({ kind: "failure", code });
    });
  });
}

function responseResult(
  status: number,
  headers: IncomingHttpHeaders | undefined,
  chunks: Buffer[],
  bytes: number,
  truncated: boolean,
): TransportResult {
  return {
    kind: "response",
    status,
    headers: selectedResponseHeaders(headers),
    body: Buffer.concat(chunks, bytes),
    ...(truncated ? { bodyTruncated: true } : {}),
  };
}

function selectedResponseHeaders(headers: IncomingHttpHeaders | undefined): Readonly<Record<string, string>> {
  if (!headers) return {};
  const apnsId = headers["apns-id"];
  return typeof apnsId === "string" ? { "apns-id": apnsId } : {};
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
