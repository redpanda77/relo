import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureIdentity, loadKeyStore, saveKeyStore } from "../src/crypto/keystore.mjs";
import { ensureTrust, trustNotices } from "../src/crypto/trust.mjs";

async function harness(patch = {}) {
  const folder = mkdtempSync(join(tmpdir(), "relo-strict-note-"));
  const path = join(folder, "e2ee.json");
  const { store } = await ensureIdentity(path);
  await saveKeyStore(path, { ...store, ...patch });
  const env = { RELO_KEY_STORE_PATH: path };
  const dependencies = { configPath: () => join(folder, "config.json"), env, now: () => Date.parse("2026-10-15T10:00:00Z") };
  const client = { publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices: [] }) };
  const notes = async (apiUrl) => {
    const { store: loaded, devices } = await ensureTrust({ client, config: { apiUrl }, dependencies });
    return trustNotices(loaded, apiUrl, dependencies.now(), devices).filter((note) => note.startsWith("Strict mode"));
  };
  return { path, notes, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

test("strict mode by default on a public address is explained once per server", async () => {
  const h = await harness();
  try {
    const [first] = await h.notes("https://relo.example.com");
    assert.equal(first, "Strict mode is on because https://relo.example.com is a public address: a changed phone key needs"
      + " `relo keys verify`, and linked browsers can't approve phones or answer. Turn it off with `relo keys strict off`.");
    assert.deepEqual(await h.notes("https://relo.example.com"), []);
    assert.ok((await loadKeyStore(h.path)).strictNoticeShown["https://relo.example.com"]);
    assert.equal((await h.notes("https://other.example.org")).length, 1);
  } finally {
    h.cleanup();
  }
});

test("no strict note on a private network or when the owner chose", async () => {
  const privateServer = await harness();
  const chosen = await harness({ strict: false });
  const on = await harness({ strict: true });
  try {
    assert.deepEqual(await privateServer.notes("https://relo.internal"), []);
    assert.deepEqual(await chosen.notes("https://relo.example.com"), []);
    assert.deepEqual(await on.notes("https://relo.example.com"), []);
  } finally {
    privateServer.cleanup();
    chosen.cleanup();
    on.cleanup();
  }
});

test("a keystore from before the marker shows the note once", async () => {
  const h = await harness({ committed: {} });
  try {
    assert.equal((await h.notes("https://relo.example.com")).length, 1);
    assert.equal((await h.notes("https://relo.example.com")).length, 0);
  } finally {
    h.cleanup();
  }
});
