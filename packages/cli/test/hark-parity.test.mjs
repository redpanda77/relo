import assert from "node:assert/strict";
import test from "node:test";
import { execute, run, EXIT } from "../src/cli.mjs";

const token = "t".repeat(44);
const identity = () => ({ providerName: "Codex",project: "Relo",threadName: "Release" });
function capture(overrides = {}) {
  const bodies = [];
  const record = (name) => async (body) => { bodies.push({ name,body }); return { delivery: { eligibleDevices: 1,durableCommands: 1,apnsJobs: 1 } }; };
  const client = { sendNotification: record("send"),createInteraction: record("ask"),startActivity: record("start") };
  return { bodies,deps: {
    loadConfig: async () => ({ apiUrl: "https://relo.example",token }),clientFactory: () => client,identityDefaults: identity,
    readStdinJson: async () => ({}),prepareNotificationCommand: async ({ body }) => body,
    captureActivityCommand: async ({ body }) => ({ target: null,ifSequence: body.ifSequence }),...overrides,
  } };
}

test("RELO_TOKEN with RELO_API_URL authenticates without a config file and logout refuses it", async () => {
  const env = { RELO_TOKEN: token,RELO_API_URL: "https://relo.example" };
  let seen;
  const clientFactory = (config) => { seen = config; return { authStatus: async () => ({ authenticated: true,
    credential: { id: "cred_1",clientName: "CI",prefix: "relo_",scopes: [] } }) }; };
  const status = await execute(["auth","status"],{ env,clientFactory,configPath: () => "/nonexistent/config.json" });
  assert.equal(status.data.credentialSource,"environment");
  assert.equal(seen.token,token);
  assert.equal(seen.apiUrl,"https://relo.example");
  await assert.rejects(execute(["auth","logout"],{ env,clientFactory }),/comes from RELO_TOKEN/);
  await assert.rejects(execute(["auth","status"],{ env: { RELO_TOKEN: token },clientFactory }),
    (error) => error.exitCode === EXIT.AUTH && /RELO_API_URL/.test(error.message));
});

test("errors print the JSON envelope whenever stdout is not a terminal", async () => {
  const lines = [];
  const code = await run(["notify","send"],{ stdout: (line) => lines.push(line),stderr: () => {},stdoutIsTTY: false },capture().deps);
  assert.equal(code,EXIT.USAGE);
  assert.equal(JSON.parse(lines[0]).error.code,"USAGE_ERROR");
  const quiet = [];
  await run(["notify","send"],{ stdout: (line) => quiet.push(line),stderr: () => {},stdoutIsTTY: true },capture().deps);
  assert.deepEqual(quiet,[]);
});

test("--markdown, app links and Shortcuts URLs reach the server; executable schemes do not", async () => {
  const { bodies,deps } = capture();
  await execute(["notify","Deployed","--markdown","--url","shortcuts://run-shortcut?name=Deploy%20Follow-up"],deps);
  await execute(["notify","Incident","--url","your-app://incidents/INC-42"],deps);
  assert.equal(bodies[0].body.bodyFormat,"markdown");
  assert.equal(bodies[0].body.destinationUrl,"shortcuts://run-shortcut?name=Deploy%20Follow-up");
  assert.equal(bodies[1].body.destinationUrl,"your-app://incidents/INC-42");
  for (const url of ["javascript:alert(1)","http://example.com","file:///etc/passwd"]) {
    await assert.rejects(execute(["notify","x","--url",url],deps),/cannot use|valid URL/);
  }
  await assert.rejects(execute(["notify","x","--markdown","--format","text"],deps),/--markdown cannot be combined/);
});

test("questions carry a callback read from a token file and a correlation ID", async () => {
  const { fakeCards, cardDependencies } = await import("./fake-cards.mjs");
  const fake = fakeCards();
  const files = [];
  const deps = { ...cardDependencies(fake.client),
    readTextFile: async (path) => { files.push(path); return "  cb-token-0123456789abcdef\n"; } };
  await execute(["ask","Ship?","--approval","--no-wait","--topic","Release","--correlation-id","deploy-184",
    "--callback-url","https://ci.example.com/relo","--callback-token-file","/secure/token"],deps);
  assert.deepEqual(files,["/secure/token"]);
  const asked = fake.calls.find((call) => call.op === "ask").body;
  assert.deepEqual(asked.callback,{ url: "https://ci.example.com/relo",token: "cb-token-0123456789abcdef" });
  assert.equal(asked.correlationId,"deploy-184");
  await assert.rejects(execute(["ask","Ship?","--approval","--topic","Release","--callback-url","https://ci.example.com/relo"],deps),
    /16-512 character token/);
  await assert.rejects(execute(["ask","Ship?","--approval","--topic","Release","--callback-url","https://localhost/relo",
    "--callback-token-file","/secure/token"],deps),/public HTTPS/);
});

test("activities accept the ring style and private mode", async () => {
  const { bodies,deps } = capture();
  await execute(["activity","start","--title","Deploy","--status","Building","--progress","0.4","--style","ring","--privacy","private"],deps);
  assert.equal(bodies[0].body.style,"ring");
  assert.equal(bodies[0].body.privacy,"private");
});
