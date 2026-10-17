import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signinNumber } from "../src/crypto/signin-number.mjs";
import { qrText } from "../src/shared/qr.mjs";
import { ApiError, AuthError, EXIT, NetworkError } from "../src/shared/errors.mjs";
import { execute, run, CONFIG, overrides, LOGIN_SCOPES, DEVICE_CODE, ACCESS_TOKEN, authorizationStart, issuedCredential } from "./cli-fixtures.mjs";

test("auth login follows pending and slow-down, opens the frozen URL, and stores safely", async () => {
  let now = 0;
  let polls = 0;
  let opened;
  let written;
  let sentIdentityKey;
  const diagnostics = [];
  const client = {
    startDeviceAuthorization: async (body) => {
      assert.match(body.identityKey, /^[A-Za-z0-9_-]{87}$/u);
      sentIdentityKey = body.identityKey;
      assert.deepEqual({ ...body, identityKey: undefined }, {
        clientName: "Mac Codex",
        scopes: LOGIN_SCOPES,
        expiresInSeconds: 7_776_000,
        identityKey: undefined,
      });
      return authorizationStart();
    },
    pollDeviceAuthorization: async () => {
      polls += 1;
      if (polls === 1) {
        throw new ApiError("authorization_pending", {
          status: 400,
          code: "AUTHORIZATION_PENDING",
          details: { intervalSeconds: 5 },
        });
      }
      if (polls === 2) {
        throw new ApiError("slow_down", {
          status: 400,
          code: "SLOW_DOWN",
          details: { intervalSeconds: 10 },
        });
      }
      return issuedCredential();
    },
  };
  const output = await execute(
    [
      "auth",
      "login",
      "--client-name",
      "Mac Codex",
      "--scope",
      "notifications:send",
      "--scope",
      "interactions:create",
      "--scope",
      "interactions:read",
      "--open",
    ],
    {
      env: { RELO_API_URL: "http://192.168.1.10:8180" },
      configPath: () => CONFIG.path,
      clientFactory: () => client,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      openBrowser: (url) => {
        opened = url;
      },
      stderr: (line) => diagnostics.push(line),
      writeConfig: async (path, value) => {
        written = { path, value };
      },
    },
  );
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(opened, authorizationStart().verificationUriComplete);
  assert.deepEqual(diagnostics, [
    "Open this link to connect the Relo CLI:",
    "http://192.168.1.10:8180/cli/authorize?code=ABCD-EFGH",
    "",
    qrText("http://192.168.1.10:8180/cli/authorize?code=ABCD-EFGH"),
    "Scan it with the Relo app on your iPhone to approve, or with your phone's camera to open the link.",
    "",
    "Fallback page: http://192.168.1.10:8180/cli/authorize",
    "Fallback code: ABCD-EFGH",
    `Number on your phone: ${signinNumber("ABCD-EFGH", sentIdentityKey)}`,
    "Approve it in the Relo app (scan or type the code) or open the link.",
  ]);
  assert.equal(polls, 3);
  assert.equal(written.path, CONFIG.path);
  assert.deepEqual(written.value.principal.scopes, LOGIN_SCOPES);
  assert.equal(written.value.token, ACCESS_TOKEN);
  assert.equal(JSON.stringify(output).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(output).includes(DEVICE_CODE), false);
});

test("auth login survives transient network and server failures while authorization is pending",async () => {
  let now = 0;
  let polls = 0;
  let written = false;
  const diagnostics = [];
  const output = await execute([
    "auth","login","--no-open",
    "--scope","notifications:send",
    "--scope","interactions:create",
    "--scope","interactions:read",
  ],{
    env: { RELO_API_URL: "http://192.168.1.10:8180" },
    configPath: () => CONFIG.path,
    configRevision: async () => null, computerName: () => undefined,
    clientFactory: () => ({
      startDeviceAuthorization: async () => authorizationStart(),
      pollDeviceAuthorization: async () => {
        polls += 1;
        if (polls === 1) throw new NetworkError("temporary network failure");
        if (polls === 2) throw new ApiError("temporary gateway failure",{ status: 502 });
        return issuedCredential({
          credential: { ...issuedCredential().credential,clientName: "Relo CLI" },
        });
      },
    }),
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    writeConfig: async () => { written = true; },
    stderr: (line) => diagnostics.push(line),
  });
  assert.equal(output.exitCode,EXIT.OK);
  assert.equal(polls,3);
  assert.equal(written,true);
  assert.equal(
    diagnostics.includes(authorizationStart().verificationUriComplete),
    true,
  );
});

test("auth login keeps the complete link visible when browser launch fails", async () => {
  let now = 0;
  const diagnostics = [];
  const output = await execute([
    "auth", "login", "--open",
    "--scope", "notifications:send",
    "--scope", "interactions:create",
    "--scope", "interactions:read",
  ], {
    ...overrides({
      startDeviceAuthorization: async () => authorizationStart(),
      pollDeviceAuthorization: async () => issuedCredential({
        credential: {
          ...issuedCredential().credential,
          clientName: "Relo CLI",
          scopes: LOGIN_SCOPES,
        },
      }),
    }),
    env: { RELO_API_URL: "http://192.168.1.10:8180" },
    computerName: () => undefined,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    openBrowser: () => { throw new Error("browser unavailable"); },
    stderr: (line) => diagnostics.push(line),
    writeConfig: async () => {},
  });
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(diagnostics[1], authorizationStart().verificationUriComplete);
  assert.equal(
    diagnostics.includes("Could not open browser: browser unavailable"),
    true,
  );
});

test("first login requires an explicit trusted origin while re-login preserves the configured origin", async () => {
  await assert.rejects(
    execute(["auth", "login"], {
      env: {},
      configPath: () => "/missing/config.json",
      loadConfig: async () => { throw new AuthError("missing", { code: "CONFIG_NOT_FOUND" }); },
    }),
    /server origin is required/,
  );
  let usedOrigin;
  await assert.rejects(
    execute(["auth", "login", "--no-open"], {
      ...overrides({
        startDeviceAuthorization: async () => {
          usedOrigin = CONFIG.apiUrl;
          return authorizationStart({
            verificationUri: `${CONFIG.apiUrl}/cli/authorize`,
            verificationUriComplete: `${CONFIG.apiUrl}/cli/authorize?code=ABCD-EFGH`,
          });
        },
        pollDeviceAuthorization: async () => {
          throw new ApiError("denied", { code: "ACCESS_DENIED" });
        },
      }),
      env: {},
      now: (() => { let value = 0; return () => value += 5_000; })(),
      sleep: async () => {},
    }),
    /denied/,
  );
  assert.equal(usedOrigin, CONFIG.apiUrl);
});

test("auth login rejects a foreign authorization URL before browser launch or polling", async () => {
  let opened = false;
  await assert.rejects(
    execute(["auth", "login"], {
      env: { RELO_API_URL: "http://192.168.1.10:8180" },
      configRevision: async () => null,
      clientFactory: () => ({
        startDeviceAuthorization: async () =>
          authorizationStart({
            verificationUriComplete: "https://attacker.example/cli/authorize?code=ABCD-EFGH",
          }),
      }),
      openBrowser: () => {
        opened = true;
      },
    }),
    (error) => error.code === "INVALID_API_RESPONSE",
  );
  assert.equal(opened, false);
});

test("auth login revokes an issued token when secure persistence fails", async () => {
  let now = 0;
  let revoked = 0;
  const clientFactory = (config) =>
    config.token
      ? {
          revokeAuth: async () => {
            assert.equal(config.token, ACCESS_TOKEN);
            revoked += 1;
          },
        }
      : {
          startDeviceAuthorization: async () => authorizationStart(),
          pollDeviceAuthorization: async () => issuedCredential({
            credential: { ...issuedCredential().credential, clientName: "Relo CLI" },
          }),
        };
  await assert.rejects(
    execute(["auth", "login", "--scope", "notifications:send", "--scope", "interactions:create", "--scope", "interactions:read"], {
      env: { RELO_API_URL: "http://192.168.1.10:8180" },
      configRevision: async () => null, computerName: () => undefined,
      clientFactory,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      writeConfig: async () => {
        throw new Error("disk unavailable");
      },
    }),
    (error) => error.message === "disk unavailable" && !error.message.includes(ACCESS_TOKEN),
  );
  assert.equal(revoked, 1);
});

test("auth login maps denial, expiry, and timeout to frozen exit codes", async () => {
  const runCase = async (pollError, expectedExit) => {
    let now = 0;
    const stdout = [];
    const stderr = [];
    const exitCode = await run(
      ["auth", "login", "--timeout", "6s", "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        env: { RELO_API_URL: "http://192.168.1.10:8180" },
        configRevision: async () => null,
        clientFactory: () => ({
          startDeviceAuthorization: async () => authorizationStart(),
          pollDeviceAuthorization: async () => {
            throw pollError;
          },
        }),
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    );
    assert.equal(exitCode, expectedExit);
    assert.equal(stdout.length, 1);
    assert.equal(JSON.parse(stdout[0]).ok, false);
    assert.equal(stderr.join("\n").includes(DEVICE_CODE), false);
    assert.equal(stderr.join("\n").includes(ACCESS_TOKEN), false);
  };
  await runCase(
    new ApiError("access_denied", { status: 400, code: "ACCESS_DENIED" }),
    EXIT.NEGATIVE,
  );
  await runCase(
    new ApiError("expired_token", { status: 400, code: "EXPIRED_TOKEN" }),
    EXIT.CLOSED,
  );
  await runCase(
    new ApiError("authorization_pending", {
      status: 400,
      code: "AUTHORIZATION_PENDING",
      details: { intervalSeconds: 5 },
    }),
    EXIT.TERMINAL,
  );
});

test("auth status verifies the live credential and emits safe metadata", async () => {
  const output = await execute(
    ["auth", "status"],
    overrides({
      authStatus: async () => ({
        authenticated: true,
        credential: issuedCredential().credential,
        accessToken: "malicious-server-field-must-not-be-forwarded",
      }),
    }),
  );
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(output.data.authenticated, true);
  assert.equal("token" in output.data, false);
  assert.equal("accessToken" in output.data, false);
  assert.equal(JSON.stringify(output).includes(CONFIG.token), false);
  assert.equal(JSON.stringify(output).includes("malicious-server-field"), false);
});

test("auth logout removes local credentials when remote revocation is unconfirmed", async () => {
  let removed;
  const output = await execute(["auth", "logout"], {
    configPath: () => CONFIG.path,
    loadConfig: async () => CONFIG,
    clientFactory: () => ({
      revokeAuth: async () => {
        throw new NetworkError("offline");
      },
    }),
    removeConfig: async (path) => {
      removed = path;
      return true;
    },
  });
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(removed, CONFIG.path);
  assert.deepEqual(output.data, {
    authenticated: false,
    revoked: false,
    credentialsRemoved: true,
    serverRevocation: "unconfirmed",
    revocationError: "NETWORK_ERROR",
  });
});

test("separate hosts retain distinct browser-approved client identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-distinct-auth-"));
  const hosts = [
    {
      name: "MacBook Codex notifier",
      id: "key_macbook0001",
      token: `relo_${"m".repeat(43)}`,
    },
    {
      name: "Relo server Codex notifier",
      id: "key_server001",
      token: `relo_${"h".repeat(43)}`,
    },
  ];
  try {
    for (const [index, host] of hosts.entries()) {
      const path = join(directory, `host-${index}`, "config.json");
      let now = 0;
      const credential = {
        ...issuedCredential().credential,
        id: host.id,
        clientName: host.name,
      };
      const clientFactory = (config) => config.token
        ? {
            authStatus: async () => ({ authenticated: true, credential }),
          }
        : {
            startDeviceAuthorization: async (body) => {
              assert.equal(body.clientName, host.name);
              return authorizationStart();
            },
            pollDeviceAuthorization: async () => ({
              accessToken: host.token,
              credential,
            }),
          };
      const dependencies = {
        env: { RELO_API_URL: "http://192.168.1.10:8180" },
        configPath: () => path,
        clientFactory,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        stderr: () => {},
      };
      const loggedIn = await execute([
        "auth", "login", "--client-name", host.name,
        "--scope", "notifications:send",
        "--scope", "interactions:create",
        "--scope", "interactions:read",
        "--no-open",
      ], dependencies);
      assert.equal(loggedIn.data.credential.id, host.id);
      assert.equal(loggedIn.data.credential.clientName, host.name);
      assert.equal(JSON.stringify(loggedIn).includes(host.token), false);

      const status = await execute(["auth", "status"], dependencies);
      assert.equal(status.data.credential.id, host.id);
      assert.equal(status.data.credential.clientName, host.name);
      assert.equal(JSON.stringify(status).includes(host.token), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("confirmed logout revokes once, removes the credential, and rejects post-logout auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-confirmed-logout-"));
  const path = join(directory, "config.json");
  let revocations = 0;
  let authenticatedCalls = 0;
  try {
    await writeFile(path, `${JSON.stringify({
      version: 1,
      apiUrl: CONFIG.apiUrl,
      token: CONFIG.token,
      principal: CONFIG.principal,
    })}\n`, { mode: 0o600 });
    const dependencies = {
      configPath: () => path,
      clientFactory: (config) => {
        assert.equal(config.token, CONFIG.token);
        return {
          revokeAuth: async () => {
            revocations += 1;
            return { revoked: true };
          },
          authStatus: async () => {
            authenticatedCalls += 1;
            return { authenticated: true, credential: issuedCredential().credential };
          },
        };
      },
    };
    const loggedOut = await execute(["auth", "logout"], dependencies);
    assert.deepEqual(loggedOut.data, {
      authenticated: false,
      revoked: true,
      credentialsRemoved: true,
      serverRevocation: "confirmed",
    });
    assert.equal(revocations, 1);

    const stdout = [];
    const stderr = [];
    const postLogout = await run(
      ["auth", "status", "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      dependencies,
    );
    assert.equal(postLogout, EXIT.AUTH);
    assert.equal(stdout.length, 1);
    assert.equal(JSON.parse(stdout[0]).error.code, "CONFIG_NOT_FOUND");
    assert.equal(authenticatedCalls, 0);
    assert.equal(JSON.stringify({ stdout, stderr }).includes(CONFIG.token), false);

    const repeated = await execute(["auth", "logout"], dependencies);
    assert.deepEqual(repeated.data, {
      authenticated: false,
      revoked: false,
      credentialsRemoved: false,
      alreadyLoggedOut: true,
    });
    assert.equal(revocations, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
