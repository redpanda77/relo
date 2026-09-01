import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  discoverOpenCodeService,
  drainOpenCodeV1Queue,
  handleOpenCodeV1Event,
  handleOpenCodeV2Event,
  openCodeBridgeInternals,
  probeOpenCodeV2Runtime,
  reconcileOpenCodeV2,
} from "../src/opencode-bridge.mjs";

const REQUEST = {
  id: "perm_123",
  sessionID: "ses_123",
  permission: "bash",
  patterns: ["secret command", "/absolute/private/path"],
  always: [],
  metadata: { category: "tool", opaque: "local-only-metadata" },
};

test("OpenCode request identity is restart-stable, domain-separated, and fingerprint-sensitive", () => {
  const firstProcess = openCodeBridgeInternals.approvalInput(
    "bash", "/private/workspace", ["secret command"], "ses_stable", "per_stable", "a".repeat(64),
  );
  const secondProcess = openCodeBridgeInternals.approvalInput(
    "bash", "/private/workspace", ["secret command"], "ses_stable", "per_stable", "a".repeat(64),
  );
  const changedRequest = openCodeBridgeInternals.approvalInput(
    "bash", "/private/workspace", ["changed command"], "ses_stable", "per_stable", "b".repeat(64),
  );
  assert.equal(firstProcess.idempotency_key, secondProcess.idempotency_key);
  assert.notEqual(firstProcess.idempotency_key, changedRequest.idempotency_key);
  assert.match(firstProcess.idempotency_key, /^relo-opencode:[a-f0-9]{64}$/);
  assert.equal(firstProcess.idempotency_key.includes("secret command"), false);
});

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for asynchronous bridge work");
}

test("OpenCode V1 event bridge rechecks the exact request and allows once without forwarding raw resources", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "relo-v1-state-"));
  const calls = [];
  let approvalInput;
  try {
    await handleOpenCodeV1Event(
    {
      serverUrl: "http://127.0.0.1:4096",
      directory: "/private/workspace",
      event: { type: "permission.asked", properties: REQUEST },
    },
    {
      ask: async (value) => { approvalInput = value; return true; },
      stateDirectory,
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (init.method === "POST") return new Response(null, { status: 204 });
        return Response.json([REQUEST]);
      },
    },
    );
  assert.deepEqual(approvalInput, {
    hook_event_name: "permission.ask",
    permission: "bash",
    workspace: "/private/workspace",
    resource_count: 2,
    idempotency_key: approvalInput.idempotency_key,
  });
  assert.match(approvalInput.idempotency_key, /^relo-opencode:[a-f0-9]{64}$/);
  assert.equal(calls[1].url.includes("/permission/perm_123/reply"), true);
  assert.deepEqual(JSON.parse(calls[1].init.body), { reply: "once" });
    await handleOpenCodeV1Event(
      { serverUrl: "http://127.0.0.1:4096", directory: "/private/workspace", event: { type: "permission.updated", properties: REQUEST } },
      { ask: async () => { throw new Error("duplicate must not ask"); }, stateDirectory, fetchImpl: async () => { throw new Error("duplicate must not fetch"); } },
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("OpenCode V1 and V2 permission failures fail closed with reject", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "relo-v1-state-"));
  const v1Bodies = [];
  try {
    await handleOpenCodeV1Event(
    {
      serverUrl: "http://localhost:4096",
      directory: "/private/workspace",
      event: { type: "permission.updated", properties: REQUEST },
    },
    {
      ask: async () => { throw new Error("phone unavailable"); },
      stateDirectory,
      fetchImpl: async (_url, init = {}) => {
        if (init.method === "POST") {
          v1Bodies.push(JSON.parse(init.body));
          return new Response(null, { status: 204 });
        }
        return Response.json([REQUEST]);
      },
    },
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
  assert.deepEqual(v1Bodies, [{ reply: "reject", message: "Denied through Relo." }]);

  const replies = [];
  const current = {
    id: "per_123",
    sessionID: REQUEST.sessionID,
    action: "bash",
    resources: REQUEST.patterns,
  };
  await reconcileOpenCodeV2(
    {
      location: async () => ({ directory: "/private/workspace", project: { id: "project", directory: "/private/workspace" } }),
      pending: async (location) => ({ data: [current], location }),
      get: async () => current,
      reply: async (_permission, reply) => replies.push(reply),
    },
    async () => { throw new Error("denied by outage"); },
  );
  assert.deepEqual(replies, ["reject"]);

  const recheckFailureReplies = [];
  await reconcileOpenCodeV2(
    {
      location: async () => ({ directory: "/private/workspace", project: { id: "project", directory: "/private/workspace" } }),
      pending: async (location) => ({ data: [{ ...current, id: "per_recheck_failure" }], location }),
      get: async () => { throw new Error("recheck unavailable"); },
      reply: async (_permission, reply) => recheckFailureReplies.push(reply),
    },
    async () => true,
  );
  assert.deepEqual(recheckFailureReplies, ["reject"]);
});

test("OpenCode V1 persists a failed reject and drains it without another phone approval", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "relo-v1-reject-"));
  let asks = 0;
  try {
    await assert.rejects(
      handleOpenCodeV1Event(
        { serverUrl: "http://127.0.0.1:4096", directory: "/private/workspace", event: { type: "permission.asked", properties: REQUEST } },
        {
          stateDirectory,
          ask: async () => { asks += 1; throw new Error("phone unavailable"); },
          fetchImpl: async () => { throw new Error("server unavailable"); },
        },
      ),
    );
    const replies = [];
    await drainOpenCodeV1Queue({
      stateDirectory,
      ask: async () => { asks += 1; return true; },
      fetchImpl: async (_url, init = {}) => {
        if (init.method === "POST") { replies.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
        return Response.json([REQUEST]);
      },
    });
    assert.equal(asks, 1);
    assert.deepEqual(replies, [{ reply: "reject", message: "Denied through Relo." }]);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("overlapping OpenCode V1 drains serialize one daemon-owned durable record", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "relo-v1-overlap-"));
  let asks = 0;
  try {
    await assert.rejects(handleOpenCodeV1Event(
      { serverUrl: "http://127.0.0.1:4096", directory: "/private/workspace", event: { type: "permission.asked", properties: REQUEST } },
      {
        stateDirectory,
        ask: async () => { asks += 1; throw new Error("phone unavailable"); },
        fetchImpl: async () => { throw new Error("server unavailable"); },
      },
    ));
    let releaseReply;
    const replyReleased = new Promise((resolve) => { releaseReply = resolve; });
    let replyStarted;
    const replyObserved = new Promise((resolve) => { replyStarted = resolve; });
    let replies = 0;
    const options = {
      stateDirectory,
      ask: async () => { asks += 1; return true; },
      fetchImpl: async (_url, init = {}) => {
        if (init.method === "POST") {
          replies += 1;
          replyStarted();
          await replyReleased;
          return new Response(null, { status: 204 });
        }
        return Response.json([REQUEST]);
      },
    };
    const first = drainOpenCodeV1Queue(options);
    await replyObserved;
    const second = drainOpenCodeV1Queue(options);
    assert.equal(second, first);
    releaseReply();
    await Promise.all([first, second]);
    assert.equal(asks, 1);
    assert.equal(replies, 1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("OpenCode V1 exact recheck includes official request metadata", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "relo-v1-metadata-"));
  const replies = [];
  let approval;
  try {
    await handleOpenCodeV1Event(
      { serverUrl: "http://127.0.0.1:4096", directory: "/private/workspace", event: { type: "permission.asked", properties: REQUEST } },
      {
        stateDirectory,
        ask: async (value) => { approval = value; return true; },
        fetchImpl: async (_url, init = {}) => {
          if (init.method === "POST") {
            replies.push(JSON.parse(init.body));
            return new Response(null, { status: 204 });
          }
          return Response.json([{ ...REQUEST, metadata: { ...REQUEST.metadata, opaque: "changed" } }]);
        },
      },
    );
    assert.equal(JSON.stringify(approval).includes("local-only-metadata"), false);
    assert.deepEqual(replies, [{ reply: "reject", message: "Denied through Relo." }]);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("OpenCode V1 refuses symlinked or non-private persistent state", async () => {
  const root = await mkdtemp(join(tmpdir(), "relo-v1-unsafe-"));
  const target = join(root, "target");
  const linked = join(root, "linked");
  try {
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked, "dir");
    await assert.rejects(
      handleOpenCodeV1Event(
        { serverUrl: "http://127.0.0.1:4096", directory: "/private/workspace", event: { type: "permission.asked", properties: REQUEST } },
        { stateDirectory: linked, ask: async () => false, fetchImpl: async () => Response.json([REQUEST]) },
      ),
      (error) => error.code === "INSECURE_OPENCODE_STATE",
    );

    if (process.platform !== "win32") {
      await chmod(target, 0o755);
      await assert.rejects(
        handleOpenCodeV1Event(
          { serverUrl: "http://127.0.0.1:4096", directory: "/private/workspace", event: { type: "permission.asked", properties: REQUEST } },
          { stateDirectory: target, ask: async () => false, fetchImpl: async () => Response.json([REQUEST]) },
        ),
        (error) => error.code === "INSECURE_OPENCODE_STATE",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode V2 never shares one approval across distinct request IDs", async () => {
  let asks = 0;
  const replies = [];
  const pending = ["per_a", "per_b"].map((id) => ({
    id,
    sessionID: "ses_shared",
    action: "edit",
    resources: ["resource-b", "resource-a"],
  }));
  await reconcileOpenCodeV2(
    {
      location: async () => ({ directory: "/private/workspace", workspaceID: "wrk_one", project: { id: "project", directory: "/private/workspace" } }),
      pending: async (location) => ({ data: pending, location }),
      get: async (permission) => pending.find((item) => item.id === permission.id),
      reply: async (permission, reply) => replies.push([permission.id, reply]),
    },
    async () => { asks += 1; return true; },
  );
  assert.equal(asks, 2);
  assert.deepEqual(replies.sort(), [["per_a", "once"], ["per_b", "once"]]);
});

test("OpenCode V2 shares only an exact replay and rejects a changed fingerprint", async () => {
  let asks = 0;
  const replies = [];
  const exact = {
    id: "per_exact",
    sessionID: "ses_exact",
    action: "edit",
    resources: ["one"],
    save: ["one"],
    metadata: { category: "safe-local-only" },
    source: { type: "tool", messageID: "msg_one", callID: "call_one" },
  };
  let current = exact;
  const client = {
    location: async () => ({ directory: "/private/workspace", workspaceID: "wrk_one", project: { id: "project", directory: "/private/workspace" } }),
    pending: async (location) => ({ data: [exact, structuredClone(exact)], location }),
    get: async () => current,
    reply: async (permission, reply) => replies.push([permission.id, reply]),
  };
  await reconcileOpenCodeV2(client, async () => { asks += 1; return true; });
  assert.equal(asks, 1);
  assert.deepEqual(replies, [["per_exact", "once"]]);

  replies.length = 0;
  current = { ...exact, metadata: { category: "changed" }, source: { ...exact.source, callID: "call_two" } };
  client.location = async () => { throw new Error("event dispatch must use event.location"); };
  await handleOpenCodeV2Event(client, {
    id: "evt_changed",
    type: "permission.v2.asked",
    location: { directory: "/private/workspace", workspaceID: "wrk_one", project: { id: "project", directory: "/private/workspace" } },
    data: exact,
  }, async () => true);
  await waitFor(() => replies.length === 1);
  assert.deepEqual(replies, [["per_exact", "reject"]]);
});

test("OpenCode V2 external replied event settles a running job exactly once", async () => {
  const permission = {
    id: "per_external",
    sessionID: "ses_external",
    action: "bash",
    resources: ["local-only-resource"],
  };
  let resolveApproval;
  let asks = 0;
  let gets = 0;
  let replies = 0;
  const approval = new Promise((resolve) => { resolveApproval = resolve; });
  const client = {
    get: async () => { gets += 1; return permission; },
    reply: async () => { replies += 1; },
  };
  await handleOpenCodeV2Event(client, {
    type: "permission.v2.asked",
    location: { directory: "/private/workspace", project: { id: "project" } },
    data: permission,
  }, async () => { asks += 1; return approval; });
  await waitFor(() => asks === 1);
  await handleOpenCodeV2Event(client, {
    type: "permission.v2.replied",
    data: { sessionID: permission.sessionID, requestID: permission.id },
  }, async () => { throw new Error("must not ask again"); });
  resolveApproval(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gets, 0);
  assert.equal(replies, 0);
});

test("OpenCode V2 retries a transient reply failure without asking or rechecking again", async () => {
  const permission = {
    id: "per_retry",
    sessionID: "ses_retry",
    action: "edit",
    resources: ["one"],
  };
  const location = {
    directory: "/private/workspace",
    workspaceID: "wrk_retry",
    project: { id: "project", directory: "/private/workspace" },
  };
  let asks = 0;
  let gets = 0;
  let replies = 0;
  const client = {
    location: async () => location,
    pending: async () => ({ data: [permission], location }),
    get: async () => { gets += 1; return permission; },
    reply: async (_permission, reply) => {
      replies += 1;
      assert.equal(reply, "once");
      if (replies === 1) throw new Error("transient daemon delivery failure");
    },
  };
  await assert.rejects(
    reconcileOpenCodeV2(client, async () => { asks += 1; return true; }),
    /transient daemon delivery failure/,
  );
  await reconcileOpenCodeV2(client, async () => {
    asks += 1;
    throw new Error("settled phone decision must be reused");
  });
  assert.equal(asks, 1);
  assert.equal(gets, 1);
  assert.equal(replies, 2);
});

test("OpenCode V2 discovery accepts only a private loopback state file matching health", async () => {
  const home = await mkdtemp(join(tmpdir(), "relo-opencode-state-"));
  try {
    const path = join(home, ".local", "state", "opencode", "server.json");
    const passwordPath = join(dirname(path), "password");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({
      url: "http://127.0.0.1:4097",
      pid: 1234,
      version: "1.2.3",
    }), { mode: 0o600 });
    await writeFile(passwordPath, "local-only-password", { mode: 0o600 });
    await chmod(path, 0o600);
    await chmod(passwordPath, 0o600);
    let authorization;
    const endpoint = await discoverOpenCodeService({
      home,
      uid: process.getuid?.(),
      fetchImpl: async (_url, init) => {
        authorization = init.headers.authorization;
        return Response.json({ healthy: true });
      },
    });
    assert.equal(endpoint.url, "http://127.0.0.1:4097/");
    assert.match(authorization, /^Basic /);

    await writeFile(path, JSON.stringify({ url: "https://evil.example", pid: 1, version: "x" }));
    await assert.rejects(discoverOpenCodeService({ home }), /loopback/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenCode V2 probe requires current health, observation, and process-bound reply proof", async () => {
  const home = await mkdtemp(join(tmpdir(), "relo-v2-proof-"));
  const seen = [];
  const endpoint = { url: "http://127.0.0.1:4097/", pid: 9876, id: "server-current", version: "1.2.3", password: "local" };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    seen.push(parsed.pathname);
    if (parsed.pathname === "/api/location") {
      return Response.json({ directory: "/private/workspace", project: { id: "project", directory: "/private/workspace" } });
    }
    if (parsed.pathname === "/api/permission/request") {
      return Response.json({ location: { directory: "/private/workspace", project: { id: "project", directory: "/private/workspace" } }, data: [] });
    }
    if (parsed.pathname === "/api/event") {
      return new Response("event: connected\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unexpected ${parsed.pathname}`);
  };

  const unverified = await probeOpenCodeV2Runtime({
    discover: async () => endpoint,
    fetchImpl,
    readBridgeProof: async () => undefined,
  });
  assert.equal(unverified.functional, false);
  assert.equal(unverified.state, "reply-unverified");

  const incomplete = await probeOpenCodeV2Runtime({
    discover: async () => ({ url: endpoint.url, pid: endpoint.pid, password: endpoint.password }),
    fetchImpl,
    readBridgeProof: async () => ({
      version: 1,
      endpoint: { url: endpoint.url, pid: endpoint.pid },
      repliedAt: Date.now(),
    }),
  });
  assert.equal(incomplete.functional, false);
  assert.equal(incomplete.state, "registration-incomplete");

  const staleProof = await probeOpenCodeV2Runtime({
    discover: async () => endpoint,
    fetchImpl,
    readBridgeProof: async () => ({
      version: 1,
      endpoint: {
        url: endpoint.url,
        pid: endpoint.pid - 1,
        id: "server-previous",
        version: endpoint.version,
      },
      repliedAt: Date.now(),
    }),
  });
  assert.equal(staleProof.functional, false);
  assert.equal(staleProof.state, "reply-unverified");

  try {
    await openCodeBridgeInternals.writeOpenCodeV2Proof(endpoint, { home });
    const proofPath = process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Relo", "permission-bridge", "opencode-v2-proof.json")
      : join(home, ".local", "state", "relo", "permission-bridge", "opencode-v2-proof.json");
    assert.equal((await readFile(proofPath, "utf8")).includes("local"), false);
    const result = await probeOpenCodeV2Runtime({ home, discover: async () => endpoint, fetchImpl });
    assert.equal(result.functional, true);
    assert.equal(result.reply, true);
    assert.deepEqual(seen, [
      "/api/location", "/api/permission/request", "/api/event",
      "/api/location", "/api/permission/request", "/api/event",
      "/api/location", "/api/permission/request", "/api/event",
      "/api/location", "/api/permission/request", "/api/event",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
