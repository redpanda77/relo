import { describe, expect, test } from "vitest";
import { cardContext } from "./card-projection.js";
import type { WorkRow } from "./store.js";

const work = (context: Record<string,unknown> | null) =>
  ({ id: "ba35b0ed-1111-4222-8333-444455556666",context } as unknown as WorkRow);

describe("work card context", () => {
  test("never makes a topic from the work id", () => {
    for (const context of [null,{},{ project: "relo",providerName: "Claude Code" },{ project: "relo",threadName: 42 }]) {
      const card = cardContext(work(context));
      expect(card.threadName).toBeUndefined();
      expect(JSON.stringify(card)).not.toMatch(/work-[0-9a-f]{8}/);
    }
  });

  test("carries the session's own name as the topic", () => {
    expect(cardContext(work({ providerName: "Claude Code",project: "relo",threadName: "Release review" })))
      .toEqual({ providerName: "Claude Code",project: "relo",threadName: "Release review" });
  });
});

describe("sealed card placeholders", () => {
  // The iPhone swaps only its own exact placeholder strings for the opened text; a different wording
  // ("Encrypted work") was shown to the owner as if it were the card's text.
  test("server, CLI and iPhone use the same strings", async () => {
    const { readFile } = await import("node:fs/promises");
    const { SEALED_CARD_PLACEHOLDERS } = await import("@relo/notification-contracts");
    const root = new URL("../../../../",import.meta.url);
    const swift = await readFile(new URL("apps/ios/Sources/ReloCore/E2EE/ReloSealedCards.swift",root),"utf8");
    const cli = await readFile(new URL("packages/cli/src/seal-card.mjs",root),"utf8");
    expect(swift).toContain(`titlePlaceholder = "${SEALED_CARD_PLACEHOLDERS.title}"`);
    expect(swift).toContain(`statusPlaceholder = "${SEALED_CARD_PLACEHOLDERS.status}"`);
    expect(cli).toContain(`SEALED_CARD_TITLE = "${SEALED_CARD_PLACEHOLDERS.title}"`);
    expect(cli).toContain(`SEALED_CARD_STATUS = "${SEALED_CARD_PLACEHOLDERS.status}"`);
    const projection = await readFile(new URL("apps/server/src/works/card-projection.ts",root),"utf8");
    expect(projection).not.toMatch(/"Encrypted work"|"Open Relo to read"/u);
  });
});
