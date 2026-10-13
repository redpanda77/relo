import { describe, expect, test } from "vitest";
import { stableJson } from "./stable-json.js";

describe("stableJson", () => {
  test("orders keys so equal requests hash equally", () => {
    expect(stableJson({ b: 1, a: [{ d: true, c: null }] })).toBe('{"a":[{"c":null,"d":true}],"b":1}');
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
  });

  test("keeps the output persisted request hashes depend on", () => {
    expect(stableJson({ B: 1, a: 2 })).toBe('{"a":2,"B":1}');
    expect(stableJson({ a: undefined })).toBe('{"a":undefined}');
  });
});
