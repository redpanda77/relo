import assert from "node:assert/strict";
import test from "node:test";
import { CREDENTIAL_KINDS, LOGIN_SCOPES, SCOPES, SCOPE_NAMES, isScope, scopeSchema, scopesFor } from "../src/scopes.js";

test("every scope says what it allows and who may hold it", () => {
  for (const scope of SCOPE_NAMES) {
    const definition = SCOPES[scope];
    assert.match(scope, /^[a-z]+:[a-z]+$/u);
    assert.ok(definition.means.length > 10 && definition.means.endsWith("."), `${scope} needs a sentence`);
    assert.ok(definition.kinds.length > 0, `${scope} needs a credential kind`);
    for (const kind of definition.kinds) assert.ok((CREDENTIAL_KINDS as readonly string[]).includes(kind));
  }
});

test("retired scopes stay gone and each kind holds only its own", () => {
  for (const retired of ["sessions:write", "devices:pair"]) {
    assert.equal(isScope(retired), false);
    assert.equal(scopeSchema.safeParse(retired).success, false);
  }
  assert.deepEqual(scopesFor("harness"), ["presence:write"]);
  assert.deepEqual(scopesFor("device"), ["device:self", "inbox:read", "interactions:respond"]);
  assert.deepEqual(scopesFor("service"), ["hooks:notify", "hooks:cards", "hooks:works", "hooks:read"]);
  assert.deepEqual(scopesFor("ci-token"), scopesFor("login"));
  assert.equal(LOGIN_SCOPES.some((scope) => scope.startsWith("hooks:") || scope === "presence:write"), false);
});
