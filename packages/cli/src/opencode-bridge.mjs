import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ApiError, UsageError } from "./errors.mjs";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_BYTES = 16 * 1024 * 1024;
const V1_TOMBSTONE_MS = 24 * 60 * 60 * 1_000;
const v1Jobs = new Map();
const v1DrainJobs = new Map();
const v2Jobs = new Map();

function localUrl(value, label = "OpenCode URL") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${label} is invalid`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new UsageError(`${label} must use a loopback origin`);
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new UsageError(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  return url;
}

function authHeaders(endpoint) {
  if (!endpoint.password) return {};
  return {
    authorization: `Basic ${Buffer.from(`${endpoint.username ?? "opencode"}:${endpoint.password}`).toString("base64")}`,
  };
}

async function request(endpoint, path, options = {}, fetchImpl = globalThis.fetch) {
  const { signal, ...requestOptions } = options;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(new URL(path, endpoint.url), {
    ...requestOptions,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      ...authHeaders(endpoint),
      ...(requestOptions.body ? { "content-type": "application/json" } : {}),
      ...requestOptions.headers,
    },
  });
  if (!response.ok) {
    const error = new ApiError(`OpenCode request failed: ${response.status}`, {
      code: "OPENCODE_REQUEST_FAILED",
    });
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return undefined;
  return response.json();
}

function normalizeV1(requestValue) {
  return {
    id: requestValue?.id,
    sessionID: requestValue?.sessionID,
    action: requestValue?.permission ?? requestValue?.type ?? "permission",
    resources: requestValue?.patterns ?? (requestValue?.pattern ? [requestValue.pattern] : []),
    save: requestValue?.always ?? [],
    metadata: requestValue?.metadata,
    source: requestValue?.tool
      ? { messageID: requestValue.tool.messageID, callID: requestValue.tool.callID }
      : requestValue?.messageID && requestValue?.callID
        ? { messageID: requestValue.messageID, callID: requestValue.callID }
        : undefined,
  };
}

function fingerprint(requestValue, location) {
  return createHash("sha256")
    .update(JSON.stringify([
      requestValue.id,
      requestValue.sessionID,
      requestValue.action,
      requestValue.resources,
      requestValue.save ?? null,
      requestValue.metadata ?? null,
      requestValue.source ?? null,
      location?.directory ?? null,
      location?.workspaceID ?? null,
    ]))
    .digest("hex");
}

function approvalInput(action, directory, resources, sessionID, requestID, exactRequestFingerprint) {
  const operation = createHash("sha256")
    .update("relo-opencode-permission-identity-v1\0")
    .update(JSON.stringify([
      sessionID ?? null,
      requestID ?? null,
      exactRequestFingerprint ?? null,
      action ?? null,
      Array.isArray(resources) ? resources : null,
    ]))
    .digest("hex");
  return {
    hook_event_name: "permission.ask",
    permission: typeof action === "string" ? action : "permission",
    workspace: typeof directory === "string" ? directory : "unknown-workspace",
    resource_count: Array.isArray(resources) ? Math.max(1, Math.min(100, resources.length)) : 1,
    idempotency_key: `relo-opencode:${operation}`,
  };
}

async function v1Request(serverUrl, directory, path, options, fetchImpl) {
  const endpoint = {
    url: localUrl(serverUrl).toString(),
    ...(process.env.OPENCODE_SERVER_PASSWORD
      ? {
          password: process.env.OPENCODE_SERVER_PASSWORD,
          username: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
        }
      : {}),
  };
  const url = new URL(path, endpoint.url);
  if (directory) url.searchParams.set("directory", directory);
  return request(endpoint, url, options, fetchImpl);
}

async function listV1(serverUrl, directory, fetchImpl) {
  const response = await v1Request(serverUrl, directory, "/permission", {}, fetchImpl);
  if (!Array.isArray(response)) throw new ApiError("OpenCode V1 permission list was invalid.", { code: "INVALID_OPENCODE_RESPONSE" });
  return response.map(normalizeV1);
}

async function replyV1(serverUrl, directory, permission, decision, fetchImpl) {
  try {
    await v1Request(serverUrl, directory, `/permission/${encodeURIComponent(permission.id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply: decision, ...(decision === "reject" ? { message: "Denied through Relo." } : {}) }),
    }, fetchImpl);
  } catch (error) {
    if (!permission.sessionID) throw error;
    await v1Request(serverUrl, directory, `/session/${encodeURIComponent(permission.sessionID)}/permissions/${encodeURIComponent(permission.id)}`, {
      method: "POST",
      body: JSON.stringify({ response: decision }),
    }, fetchImpl);
  }
}

function bridgeStateDirectory(home = homedir()) {
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Relo", "permission-bridge")
    : join(home, ".local", "state", "relo", "permission-bridge");
}

function v1StateDirectory(home = homedir()) {
  return join(bridgeStateDirectory(home), "opencode-v1");
}

function v2ProofPath(home = homedir()) {
  return join(bridgeStateDirectory(home), "opencode-v2-proof.json");
}

function endpointIdentity(endpoint) {
  return {
    url: endpoint.url,
    pid: endpoint.pid,
    ...(endpoint.id === undefined ? {} : { id: endpoint.id }),
    ...(endpoint.version === undefined ? {} : { version: endpoint.version }),
  };
}

function completeEndpointIdentity(endpoint) {
  return Number.isInteger(endpoint?.pid) && endpoint.pid > 0
    && typeof endpoint?.url === "string" && endpoint.url.length > 0
    && typeof endpoint?.id === "string" && endpoint.id.length > 0
    && typeof endpoint?.version === "string" && endpoint.version.length > 0;
}

function proofMatchesEndpoint(proof, endpoint) {
  return completeEndpointIdentity(endpoint)
    && proof?.version === 1
    && Number.isFinite(proof.repliedAt)
    && JSON.stringify(proof.endpoint) === JSON.stringify(endpointIdentity(endpoint));
}

async function ensurePrivateStateDirectory(path, uid = process.getuid?.()) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ApiError("OpenCode bridge state directory is unsafe.", { code: "INSECURE_OPENCODE_STATE" });
  }
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid))) {
    throw new ApiError("OpenCode bridge state directory permissions are unsafe.", { code: "INSECURE_OPENCODE_STATE" });
  }
}

async function readPrivateStateRecord(path, uid = process.getuid?.()) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_STATE_BYTES) {
    throw new ApiError("OpenCode bridge state record is unsafe.", { code: "INSECURE_OPENCODE_STATE" });
  }
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid))) {
    throw new ApiError("OpenCode bridge state record permissions are unsafe.", { code: "INSECURE_OPENCODE_STATE" });
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ApiError("OpenCode V1 dedupe record is invalid.", { code: "INVALID_OPENCODE_STATE" });
  }
}

async function readOpenCodeV2Proof({ home, env, uid } = {}) {
  try {
    return await readPrivateStateRecord(v2ProofPath(home), uid);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeOpenCodeV2Proof(endpoint, { home, env, uid } = {}) {
  const path = v2ProofPath(home);
  await ensurePrivateStateDirectory(dirname(path), uid);
  await writePrivateStateRecord(path, {
    version: 1,
    endpoint: endpointIdentity(endpoint),
    repliedAt: Date.now(),
  });
}

async function writePrivateStateRecord(path, record) {
  const temporary = `${path}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function acquireV1Record(serverUrl, directory, permission, options) {
  const exactFingerprint = fingerprint(permission);
  const key = createHash("sha256")
    .update(JSON.stringify([serverUrl, directory, permission.sessionID, permission.id, exactFingerprint]))
    .digest("hex");
  const stateDirectory = options.stateDirectory ?? v1StateDirectory(options.home);
  await ensurePrivateStateDirectory(stateDirectory, options.uid);
  const path = join(stateDirectory, `${key}.json`);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    const record = {
      version: 1,
      phase: "approval",
      ownerPid: process.pid,
      createdAt: Date.now(),
      serverUrl,
      directory,
      permission,
      fingerprint: exactFingerprint,
    };
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return { path, record, acquired: true };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code !== "EEXIST") throw error;
    const record = await readPrivateStateRecord(path, options.uid);
    if (record?.phase === "completed" && Date.now() - record.completedAt > V1_TOMBSTONE_MS) {
      await rm(path);
      return acquireV1Record(serverUrl, directory, permission, options);
    }
    return { path, record, acquired: false };
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function processV1Record(path, record, ask, fetchImpl) {
  const { serverUrl, directory, permission } = record;
  let decision = record.decision;
  if (record.phase === "approval") {
    try {
      decision = await ask(approvalInput(
        permission.action,
        directory,
        permission.resources,
        permission.sessionID,
        permission.id,
        record.fingerprint,
      )) === true ? "once" : "reject";
    } catch {
      decision = "reject";
    }
    record = { ...record, phase: "reply", decision, ownerPid: process.pid };
    await writePrivateStateRecord(path, record);
  }
  let current;
  try {
    current = (await listV1(serverUrl, directory, fetchImpl)).find((item) => item.id === permission.id);
  } catch {
    decision = "reject";
    record = { ...record, phase: "reject-pending", decision, ownerPid: process.pid };
    await writePrivateStateRecord(path, record);
    await replyV1(serverUrl, directory, permission, "reject", fetchImpl);
    await writePrivateStateRecord(path, { version: 1, phase: "completed", fingerprint: record.fingerprint, completedAt: Date.now() });
    return;
  }
  if (!current) {
    await writePrivateStateRecord(path, { version: 1, phase: "completed", fingerprint: record.fingerprint, completedAt: Date.now() });
    return;
  }
  if (fingerprint(current) !== record.fingerprint) {
    decision = "reject";
    permission.id = current.id;
    permission.sessionID = current.sessionID;
  }
  try {
    await replyV1(serverUrl, directory, permission, decision, fetchImpl);
    await writePrivateStateRecord(path, { version: 1, phase: "completed", fingerprint: record.fingerprint, completedAt: Date.now() });
  } catch (error) {
    await writePrivateStateRecord(path, { ...record, phase: "reject-pending", decision: "reject", ownerPid: process.pid });
    throw error;
  }
}

async function startV1(serverUrl, directory, raw, ask, fetchImpl, options = {}) {
  const permission = normalizeV1(raw);
  if (typeof permission.id !== "string" || typeof permission.sessionID !== "string") return;
  const key = `${serverUrl}:${directory}:${permission.id}:${fingerprint(permission)}`;
  if (v1Jobs.has(key)) return v1Jobs.get(key);
  const acquired = await acquireV1Record(serverUrl, directory, permission, options);
  if (!acquired.acquired) return;
  const job = (async () => {
    await processV1Record(acquired.path, acquired.record, ask, fetchImpl);
  })().finally(() => v1Jobs.delete(key));
  v1Jobs.set(key, job);
  return job;
}

export async function handleOpenCodeV1Event(envelope, { ask, fetchImpl = globalThis.fetch, ...options } = {}) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new UsageError("OpenCode V1 event must be an object");
  const serverUrl = localUrl(envelope.serverUrl).toString();
  const directory = typeof envelope.directory === "string" ? envelope.directory : "";
  const event = envelope.event;
  if (!event || typeof event !== "object") throw new UsageError("OpenCode V1 event payload is invalid");
  if (event.type === "server.connected") {
    const pending = await listV1(serverUrl, directory, fetchImpl);
    await Promise.all(pending.map((item) => startV1(serverUrl, directory, item, ask, fetchImpl, options)));
  } else if (event.type === "permission.asked" || event.type === "permission.updated") {
    await startV1(serverUrl, directory, event.properties, ask, fetchImpl, options);
  }
}

async function drainOpenCodeV1QueueOnce({ ask, fetchImpl = globalThis.fetch, stateDirectory, home } = {}) {
  const directory = stateDirectory ?? v1StateDirectory(home);
  let entries;
  try { entries = await readdir(directory); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  await ensurePrivateStateDirectory(directory);
  for (const entry of entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    const path = join(directory, entry);
    let record;
    try { record = await readPrivateStateRecord(path); }
    catch { continue; }
    if (record?.phase === "completed") {
      if (Date.now() - record.completedAt > V1_TOMBSTONE_MS) await rm(path).catch(() => {});
      continue;
    }
    if (record?.ownerPid !== process.pid && processAlive(record?.ownerPid)) continue;
    try { await processV1Record(path, { ...record, ownerPid: process.pid }, ask, fetchImpl); }
    catch { /* Durable reject-pending record remains for the next pass. */ }
  }
}

export function drainOpenCodeV1Queue(options = {}) {
  const directory = options.stateDirectory ?? v1StateDirectory(options.home);
  if (v1DrainJobs.has(directory)) return v1DrainJobs.get(directory);
  const job = drainOpenCodeV1QueueOnce({ ...options, stateDirectory: directory })
    .finally(() => v1DrainJobs.delete(directory));
  v1DrainJobs.set(directory, job);
  return job;
}

export async function discoverOpenCodeService({
  home = homedir(),
  env = process.env,
  uid = process.getuid?.(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const stateRoot = env.XDG_STATE_HOME ?? join(home, ".local", "state");
  const stateDirectory = join(stateRoot, "opencode");
  const statePath = join(stateDirectory, "server.json");
  const passwordPath = join(stateDirectory, "password");
  async function privateFile(path, maximumBytes, missingIsUndefined = false) {
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (error?.code === "ENOENT" && missingIsUndefined) return undefined;
      if (error?.code === "ENOENT") {
        throw new ApiError("OpenCode service state is incomplete.", { code: "INVALID_OPENCODE_STATE" });
      }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
      throw new ApiError("OpenCode service state file is unsafe.", { code: "INSECURE_OPENCODE_STATE" });
    }
    if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid))) {
      throw new ApiError("OpenCode service state file permissions are unsafe.", { code: "INSECURE_OPENCODE_STATE" });
    }
    return readFile(path, "utf8");
  }
  const registration = await privateFile(statePath, MAX_STATE_BYTES, true);
  if (registration === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(registration);
  } catch {
    throw new ApiError("OpenCode service state file is invalid.", { code: "INVALID_OPENCODE_STATE" });
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || !Number.isInteger(value.pid) || value.pid <= 0
    || typeof value.url !== "string"
    || (value.id !== undefined && typeof value.id !== "string")
    || (value.version !== undefined && typeof value.version !== "string")
  ) {
    throw new ApiError("OpenCode service state file is invalid.", { code: "INVALID_OPENCODE_STATE" });
  }
  const password = await privateFile(passwordPath, 4_096);
  const endpoint = {
    url: localUrl(value.url).toString(),
    pid: value.pid,
    password,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.version === undefined ? {} : { version: value.version }),
  };
  const response = await fetchImpl(new URL("/api/health", endpoint.url), {
    headers: authHeaders(endpoint),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) return undefined;
  const health = await response.json();
  if (health?.healthy !== true) return undefined;
  return endpoint;
}

export function createOpenCodeV2Client(endpoint, fetchImpl = globalThis.fetch) {
  return {
    endpoint,
    location: () => request(endpoint, "/api/location", {}, fetchImpl),
    pending: ({ directory, workspaceID }) => {
      const url = new URL("/api/permission/request", endpoint.url);
      if (directory) url.searchParams.set("location[directory]", directory);
      if (workspaceID) url.searchParams.set("location[workspace]", workspaceID);
      return request(endpoint, url, {}, fetchImpl);
    },
    get: async (permission) => {
      const response = await request(endpoint, `/api/session/${encodeURIComponent(permission.sessionID)}/permission/${encodeURIComponent(permission.id)}`, {}, fetchImpl);
      return response?.data;
    },
    reply: (permission, reply) => request(endpoint, `/api/session/${encodeURIComponent(permission.sessionID)}/permission/${encodeURIComponent(permission.id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply, ...(reply === "reject" ? { message: "Denied through Relo." } : {}) }),
    }, fetchImpl),
    subscribe: (signal) => subscribe(endpoint, signal, fetchImpl),
    probeEvents: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetchImpl(new URL("/api/event", endpoint.url), {
          headers: authHeaders(endpoint),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new ApiError("OpenCode event stream failed.", { code: "OPENCODE_EVENT_FAILED" });
        await response.body.cancel().catch(() => {});
        return true;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function* subscribe(endpoint, signal, fetchImpl) {
  const response = await fetchImpl(new URL("/api/event", endpoint.url), { headers: authHeaders(endpoint), signal });
  if (!response.ok || !response.body) throw new ApiError("OpenCode event stream failed.", { code: "OPENCODE_EVENT_FAILED" });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) throw new ApiError("OpenCode event exceeded the buffer limit.", { code: "OPENCODE_EVENT_TOO_LARGE" });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}

async function startV2(client, raw, location, ask, { onReply } = {}) {
  const permission = {
    id: raw?.id,
    sessionID: raw?.sessionID,
    action: raw?.action ?? raw?.permission ?? raw?.type ?? "permission",
    resources: Array.isArray(raw?.resources) ? raw.resources : Array.isArray(raw?.patterns) ? raw.patterns : [],
    save: raw?.save,
    metadata: raw?.metadata,
    source: raw?.source,
  };
  if (typeof permission.id !== "string" || typeof permission.sessionID !== "string") return;
  const exactFingerprint = fingerprint(permission, location);
  const key = `${permission.sessionID}:${permission.id}:${exactFingerprint}`;
  let state = v2Jobs.get(key);
  if (state?.job) return state.job;
  if (!state) {
    state = {
      externalSettled: false,
      reply: undefined,
      job: undefined,
      permission,
      exactFingerprint,
      location,
      decision: Promise.resolve().then(() => ask(
        approvalInput(
          permission.action,
          location?.directory,
          permission.resources,
          permission.sessionID,
          permission.id,
          exactFingerprint,
        ),
      )),
    };
    v2Jobs.set(key, state);
  }
  const job = (async () => {
    if (state.reply === undefined) {
      let allowed = false;
      try {
        allowed = await state.decision === true;
      } catch {
        allowed = false;
      }
      if (state.externalSettled) return;
      let current;
      try {
        current = await client.get(state.permission);
      } catch {
        state.reply = "reject";
      }
      if (state.externalSettled) return;
      if (state.reply === undefined) {
        const normalized = {
          id: current?.id,
          sessionID: current?.sessionID,
          action: current?.action ?? current?.permission ?? current?.type ?? "permission",
          resources: current?.resources ?? current?.patterns ?? [],
          save: current?.save,
          metadata: current?.metadata,
          source: current?.source,
        };
        state.reply = fingerprint(normalized, state.location) === state.exactFingerprint && allowed
          ? "once"
          : "reject";
      }
    }
    if (state.externalSettled) return;
    await client.reply(state.permission, state.reply);
    try { await onReply?.(); }
    catch { /* Doctor remains non-functional until proof can be recorded. */ }
    state.delivered = true;
  })().finally(() => {
    state.job = undefined;
    if ((state.externalSettled || state.delivered) && v2Jobs.get(key) === state) {
      v2Jobs.delete(key);
    }
  });
  state.job = job;
  return job;
}

export async function reconcileOpenCodeV2(client, ask, options = {}) {
  const location = await client.location();
  if (!location || typeof location.directory !== "string" || !location.project) {
    throw new ApiError("OpenCode location response was invalid.", { code: "INVALID_OPENCODE_RESPONSE" });
  }
  const pending = await client.pending(location);
  if (!Array.isArray(pending?.data)) throw new ApiError("OpenCode pending response was invalid.", { code: "INVALID_OPENCODE_RESPONSE" });
  await Promise.all(pending.data.map((permission) => startV2(client, permission, pending.location ?? location, ask, options)));
}

export async function probeOpenCodeV2Runtime(options = {}) {
  const endpoint = await (options.discover ?? discoverOpenCodeService)(options);
  if (!endpoint) return { functional: false, state: "not-running" };
  try {
    const client = createOpenCodeV2Client(endpoint, options.fetchImpl ?? globalThis.fetch);
    const location = await client.location();
    const pending = await client.pending(location);
    if (!location || typeof location.directory !== "string" || !Array.isArray(pending?.data)) {
      return { functional: false, state: "invalid-runtime-response" };
    }
    await client.probeEvents();
    if (!completeEndpointIdentity(endpoint)) {
      return {
        functional: false,
        state: "registration-incomplete",
        discovery: true,
        health: true,
        observe: true,
        reply: false,
      };
    }
    const proof = await (options.readBridgeProof ?? readOpenCodeV2Proof)(options);
    if (!proofMatchesEndpoint(proof, endpoint)) {
      return {
        functional: false,
        state: "reply-unverified",
        registrationId: endpoint.id,
        version: endpoint.version,
        discovery: true,
        health: true,
        observe: true,
        reply: false,
      };
    }
    return {
      functional: true,
      state: "functional",
      registrationId: endpoint.id,
      version: endpoint.version,
      discovery: true,
      health: true,
      observe: true,
      reply: true,
      replyRoute: "current-v2-contract",
    };
  } catch (error) {
    return { functional: false, state: "runtime-unavailable", error: error.code ?? "OPENCODE_RUNTIME_ERROR" };
  }
}

export async function handleOpenCodeV2Event(client, event, ask, options = {}) {
  if (event?.type === "permission.v2.asked") {
    if (!event.location || typeof event.location.directory !== "string") {
      throw new ApiError("OpenCode permission event location was invalid.", { code: "INVALID_OPENCODE_RESPONSE" });
    }
    void startV2(client, event.data, event.location, ask, options).catch(() => {});
  } else if (event?.type === "permission.v2.replied") {
    for (const [key, state] of v2Jobs) {
      if (key.startsWith(`${event.data?.sessionID}:${event.data?.requestID}:`)) {
        state.externalSettled = true;
        if (!state.job) v2Jobs.delete(key);
      }
    }
  }
}

export async function runOpenCodeV2Bridge({
  ask,
  discover = discoverOpenCodeService,
  fetchImpl = globalThis.fetch,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  home = homedir(),
  env = process.env,
  uid = process.getuid?.(),
  writeBridgeProof = writeOpenCodeV2Proof,
} = {}) {
  const controller = signal ? undefined : new AbortController();
  const bridgeSignal = signal ?? controller.signal;
  const stop = () => controller?.abort();
  const drainV1 = () => drainOpenCodeV1Queue({ ask, fetchImpl }).catch(() => {});
  const v1Timer = setInterval(() => void drainV1(), 5_000);
  void drainV1();
  if (controller) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
  try {
    while (!bridgeSignal.aborted) {
      const endpoint = await discover({ fetchImpl }).catch(() => undefined);
      if (!endpoint) { await sleep(1_000); continue; }
      const client = createOpenCodeV2Client(endpoint, fetchImpl);
      const bridgeOptions = {
        onReply: () => writeBridgeProof(endpoint, { home, env, uid }),
      };
      let timer;
      try {
        await reconcileOpenCodeV2(client, ask, bridgeOptions);
        timer = setInterval(() => void reconcileOpenCodeV2(client, ask, bridgeOptions).catch(() => {}), 30_000);
        for await (const event of client.subscribe(bridgeSignal)) {
          await handleOpenCodeV2Event(client, event, ask, bridgeOptions);
        }
      } catch {
        if (!bridgeSignal.aborted) await sleep(1_000);
      } finally {
        if (timer) clearInterval(timer);
      }
    }
  } finally {
    clearInterval(v1Timer);
    if (controller) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}

export const openCodeBridgeInternals = Object.freeze({
  approvalInput,
  fingerprint,
  localUrl,
  readOpenCodeV2Proof,
  writeOpenCodeV2Proof,
});
