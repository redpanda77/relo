import { createHash } from "node:crypto";
import { describe,expect,test } from "vitest";
import {
  MAX_NOTIFICATION_BODY_BYTES,
  createNotificationContentCipher,
  notificationContentForPrivacy,
  prepareNotificationContent,
  truncateUtf8,
} from "./notification-content.js";

describe("notification content",() => {
  test("derives one deterministic plain preview from text and safe markdown",() => {
    expect(prepareNotificationContent({ body: "  Alpha\r\n beta  " }).summary).toBe("Alpha beta");
    expect(prepareNotificationContent({
      body: "# Build\n\n- **Passed** [details](https://example.test)",bodyFormat: "markdown",
    }).summary).toBe("Build Passed details");
  });

  test("enforces UTF-8 bytes and truncates without splitting a scalar",() => {
    expect(() => prepareNotificationContent({ body: "界".repeat(21_846) })).toThrow(
      "notification_body_bytes_invalid",
    );
    const exact = "a".repeat(MAX_NOTIFICATION_BODY_BYTES);
    expect(prepareNotificationContent({ body: exact }).bodyBytes).toBe(MAX_NOTIFICATION_BODY_BYTES);
    const preview = truncateUtf8("🙂".repeat(200),31);
    expect(Buffer.byteLength(preview,"utf8")).toBeLessThanOrEqual(31);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("encrypts with event-bound authenticated data",() => {
    const cipher = createNotificationContentCipher("x".repeat(32));
    const envelope = cipher.encrypt("event-a","private body");
    expect(envelope).not.toContain("private body");
    expect(cipher.decrypt("event-a",envelope)).toBe("private body");
    expect(() => cipher.decrypt("event-b",envelope)).toThrow();
  });

  test("redacts private summary and preview before durable routing",() => {
    const privateContent = notificationContentForPrivacy(prepareNotificationContent({
      body:"Secret release detail",summary:"Secret summary",
    }),"private");
    expect(privateContent.summary).toBe("Private notification");
    expect(privateContent.preview).toBe("Open Relo to view");
    expect(privateContent.body).toBe("Secret release detail");
  });
});

describe("keyed body digest (E1.3)",() => {
  test("is not the body's plain SHA-256 and depends on the server secret",() => {
    const body = "Deploy 0.11.0 to production";
    const plain = createHash("sha256").update(body,"utf8").digest("hex");
    const first = createNotificationContentCipher("a".repeat(32));
    const second = createNotificationContentCipher("b".repeat(32));
    expect(first.digest(body)).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digest(body)).not.toBe(plain);
    expect(first.digest(body)).toBe(first.digest(body));
    expect(second.digest(body)).not.toBe(first.digest(body));
  });
});
