import "./hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCardText, checkLabels, checkText } from "../src/work/content-filter.mjs";

const refused = (fn, pattern) => assert.throws(fn, (error) => error.code === "CONTENT_REFUSED" && pattern.test(error.message));

test("placeholders and wordless text are refused; real words pass", () => {
  for (const text of ["Working", "in progress.", "Step 2", "step 2 of 5", "TBD", "...", "Done", "123", "Update"]) {
    refused(() => checkText("status", text), /placeholder/u);
  }
  for (const text of ["Done with the migration plan", "Building v0.17", "Review the diff", "Deploy 0.7.57"]) {
    assert.equal(checkText("status", text), text);
  }
});

test("paths and tokens are refused without echoing the secret", () => {
  refused(() => checkText("status", "Editing /Users/me/repo/file.ts"), /file path/u);
  refused(() => checkText("status", "Edit ~/notes.md"), /file path/u);
  assert.equal(checkText("status", "Calling /api/works"), "Calling /api/works");
  assert.equal(checkText("status", "See https://example.com/x"), "See https://example.com/x");
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123";
  assert.throws(() => checkText("status", `Using ${secret}`), (error) => !error.message.includes(secret) && /secret or token/u.test(error.message));
  refused(() => checkText("status", "key Ab3dEf5hIj7lMn9pQr1tUv3xYz5bCd7fGh"), /token/u);
  assert.ok(checkText("status", "Commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 pushed"));
  assert.ok(checkText("status", "Card 550e8400-e29b-41d4-a716-446655440000 ended"));
});

test("lengths, lines, labels and goal restating", () => {
  refused(() => checkText("label", "x".repeat(40) + " " + "y".repeat(40)), /limit is 80/u);
  refused(() => checkText("status", "two\nlines"), /two lines/u);
  refused(() => checkLabels(["Build image", "build image"]), /twice/u);
  refused(() => checkLabels(["ok"]), /placeholder/u);
  refused(() => checkCardText({ title: "Ship the release", status: "ship the release" }), /repeats the goal/u);
  assert.ok(checkCardText({ title: "Ship the release", status: "Building image", detail: "3 of 5" }, { labels: ["Build image", "Run tests"] }));
});
