import { describe,expect,test } from "vitest";
import { activityEndSchema,activityUpdateSchema,serializeTaskActivity } from "./activities.js";
import { activityContentState } from "./apns-runtime.js";
import {
  canonicalPresentation,
  persistedPresentationColumns,
  presentationCommandProjection,
  terminalPresentationColumnsFromRow,
  terminalPresentationFromRow,
} from "./presentation-runtime.js";

const presentation = {
    content: { header: "Relo",title: "Release",subtitle: "Server compiler",status: "Step 2 of 3" },
  identity: {
    project: { label: "Relo",color: "#E2C45B",icon: "project" as const,revision: 1,provenance: "generated" as const },
    thread: { label: "Release execution",color: "#63B3FF",icon: "thread" as const,revision: 1,provenance: "generated" as const },
    direct: false,
  },
  state: { kind: "active" as const,tone: "live" as const,icon: "active" as const },
  components: [
    { id: "steps",type: "steps" as const,colorRole: "project" as const,items: [
      { id: "contract",label: "Contract",state: "complete" as const },
      { id: "server",label: "Server",state: "current" as const },
      { id: "ios",label: "iOS",state: "pending" as const },
    ] },
    { id: "fraction",type: "progress_bar" as const,colorRole: "thread" as const,value: 0.25,label: "25%" },
  ],
  surfaces: {
    lock_screen: ["steps","fraction"],expanded_leading: [],expanded_trailing: ["fraction"],
    expanded_bottom: ["steps"],compact_leading: [],compact_trailing: ["fraction"],minimal: ["fraction"],
  },
  behavior: { type: "progress" as const },
  appearance: { theme: "system" as const,roles: {
    cardIdentity: "project" as const,componentIdentity: "thread" as const,statusEmphasis: "state" as const,
  } },
  privacy: "standard" as const,
};

describe("current presentation runtime",() => {
  test("persists one canonical presentation and verifies its integrity",() => {
    const stored = persistedPresentationColumns(presentation);
    expect(stored.presentation).toEqual(presentation);
    expect(stored.progress).toBe(0.25);
    const response = serializeTaskActivity({
      id: "00000000-0000-4000-8000-000000000001",title: stored.title,status: stored.status,
      detail: stored.detail,progress: stored.progress,symbol: stored.symbol,style: stored.style,
      privacy: stored.privacy,accent_color: stored.accentColor,presentation: stored.presentation,
      presentation_sha256: stored.presentationHash,sequence: 0,created_at: new Date(),updated_at: new Date(),
      expires_at: new Date(),stale_at: null,ended_at: null,state: "active",activity_key: null,
    });
    expect(response.presentation).toEqual(stored.presentation);
    expect(response).not.toHaveProperty("presentationVersion");
    expect(() => serializeTaskActivity({ ...response,
      id: "00000000-0000-4000-8000-000000000001",presentation_sha256: "0".repeat(64),
      created_at: new Date(),updated_at: new Date(),expires_at: new Date(),accent_color: stored.accentColor,
    })).toThrowError("presentation_integrity_failed");
  });

  test("rejects stale and compatibility-shaped presentations",() => {
    expect(() => canonicalPresentation({ version: 2 })).toThrow();
    expect(() => canonicalPresentation({ ...presentation,
      fallback: { presentationVersion: 2,visualComponentId: "fraction" },
    })).toThrow();
  });

  test("requires complete explicit replacements",() => {
    expect(activityUpdateSchema.safeParse({ presentation,status: "mixed" }).success).toBe(false);
    expect(activityUpdateSchema.safeParse({ presentation: { ...presentation,content: { title: "missing" } } }).success).toBe(false);
    expect(activityEndSchema.safeParse({ presentation,status: "mixed" }).success).toBe(false);
  });

  test("projects the complete component graph into flat ActivityKit state",() => {
    const command = presentationCommandProjection(presentation);
    const state = activityContentState({
      ...command,generation: 1,sequence: 2,expiresAt: null,staleAt: null,interaction: null,
    },"standard",1_700_000_000);
    expect(state).toMatchObject({ title: "Release",behaviorType: "progress" });
    expect(state).not.toHaveProperty("presentationVersion");
    expect(String(state.componentsJson)).toContain('"type":"steps"');
    expect(String(state.componentsJson)).toContain('"type":"progress_bar"');
    expect(state).not.toHaveProperty("presentation");
  });

  test("content state carries startedAt in epoch seconds beside updatedAt",() => {
    const command = presentationCommandProjection(presentation);
    const base = { ...command,generation: 1,sequence: 2,expiresAt: null,staleAt: null,interaction: null };
    expect(activityContentState({ ...base,startedAt: 1_699_999_000 },"standard",1_700_000_000))
      .toMatchObject({ updatedAt: 1_700_000_000,startedAt: 1_699_999_000 });
    expect(activityContentState(base,"standard",1_700_000_000)).not.toHaveProperty("startedAt");
    const legacy = activityContentState({ generation: 1,startedAt: 1_699_999_000 },"standard",1_700_000_000);
    expect(legacy).toMatchObject({ updatedAt: 1_700_000_000,startedAt: 1_699_999_000 });
  });

  test("terminal state remains a complete current presentation",() => {
    const approval = canonicalPresentation({
      ...presentation,components: [],surfaces: {},
      behavior: { type: "approval",primary: { action: "approve",label: "Approve" },
        secondary: { action: "deny",label: "Deny" } },
    });
    const terminal = terminalPresentationFromRow({ presentation: approval },"Approved","success");
    expect(terminal).toMatchObject({
      content: { status: "Approved" },components: [],behavior: { type: "informational" },
      state: { kind: "completed",tone: "success",icon: "completed" },
    });
    const columns = terminalPresentationColumnsFromRow({ presentation: approval },"Approved","success",{
      detail: "The release is ready",progress: 1,accentColor: "#30D158",
    });
    expect(columns).toMatchObject({ status: "Approved",detail: "The release is ready",progress: 1,
      symbol: "success",accentColor: "#30D158",presentation: {
      content: { status: "Approved",subtitle: "The release is ready" },
    } });

    const cleared = terminalPresentationColumnsFromRow({ presentation: columns.presentation },"Done","success",{
      detail: null,progress: null,
    });
    expect(cleared).toMatchObject({ detail: null,progress: null,presentation: {
      content: { subtitle: null },components: [],
    } });
  });

  test("a stopped work keeps the step it reached; only a finished one completes its steps",() => {
    const windowed = canonicalPresentation({ ...presentation,components: [
      { ...presentation.components[0],before: 3,after: 6 },presentation.components[1],
    ] });
    const steps = (value: ReturnType<typeof terminalPresentationFromRow>) =>
      value.components.find((component) => component.type === "steps");
    const stopped = terminalPresentationFromRow({ presentation: windowed },"Paused","stopped");
    expect(stopped.state).toEqual({ kind: "cancelled",tone: "neutral",icon: "cancelled" });
    expect(steps(stopped)).toMatchObject({ before: 3,after: 6,items: [
      { state: "complete" },{ state: "current" },{ state: "pending" },
    ] });
    const finished = terminalPresentationFromRow({ presentation: windowed },"Done","success",{ workFinished: true });
    expect(finished.state.kind).toBe("completed");
    expect(steps(finished)).toMatchObject({ before: 9,items: [
      { state: "complete" },{ state: "complete" },{ state: "complete" },
    ] });
  });
});
