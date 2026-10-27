import { describe,expect,test } from "vitest";
import {
  applyActivityPrivacyPolicy,
  effectivePresentationPolicy,
  preserveActivePresentationPolicy,
  resolveActivityPresentation,
  SYSTEM_PRESENTATION_POLICY,
} from "./presentation-policy.js";
import { persistedPresentationColumns } from "./presentation-runtime.js";

describe("Live Activity presentation policy", () => {
  const currentPresentation = {
        content: { header: "Relo",title: "Release",subtitle: "Compiler",status: "Working" },
    identity: { project: null,thread: null,direct: true },
    state: { kind: "active" as const,tone: "live" as const,icon: "active" as const },
    components: [
      { id: "steps",type: "steps" as const,colorRole: "project" as const,items: [
        { id: "contract",label: "Contract",state: "complete" as const },
        { id: "server",label: "Server",state: "current" as const },
      ] },
      { id: "fraction",type: "progress_bar" as const,colorRole: "thread" as const,value: 0.25,label: "25%" },
    ],
    surfaces: { lock_screen: ["steps","fraction"],expanded_leading: [],expanded_trailing: ["fraction"],
      expanded_bottom: ["steps"],compact_leading: [],compact_trailing: ["fraction"],minimal: ["fraction"] },
    behavior: { type: "progress" as const },
    appearance: { theme: "system" as const,roles: { cardIdentity: "project" as const,
      componentIdentity: "thread" as const,statusEmphasis: "state" as const } },
    privacy: "standard" as const,
  };

  test("resolves scoped, account, and system precedence", () => {
    const account = { ...SYSTEM_PRESENTATION_POLICY,accentColor: "#F2A65A" };
    const client = { ...SYSTEM_PRESENTATION_POLICY,colorStrategy: "fixed" as const };
    expect(effectivePresentationPolicy(client,account,"client")).toEqual({
      policy: client,source: "client",
    });
    expect(effectivePresentationPolicy(null,account,"client")).toEqual({
      policy: account,source: "account",
    });
    expect(effectivePresentationPolicy(null,null,"service")).toEqual({
      policy: SYSTEM_PRESENTATION_POLICY,source: "system",
    });
  });

  test("presentation policy does not add a private mode", () => {
    expect(SYSTEM_PRESENTATION_POLICY).not.toHaveProperty("privateActivityPolicy");
    expect(applyActivityPrivacyPolicy({ status: "Working" },SYSTEM_PRESENTATION_POLICY))
      .toEqual({ status: "Working" });
  });

  test("labels Codex topics by name even when the opaque origin thread exceeds the label limit", () => {
    const codexThread = `codex-task-${"b".repeat(40)}`;
    const input = {
      title: "Codex · relo",
      status: "Planning",
      lifecycle: { provider: "codex",runId: "codex-run-1" },
      origin: { sourceInstance: "codex-notify-1",project: "relo",thread: codexThread,channel: "task-progress" },
      context: { project: "relo",threadName: "Codex task" },
    };
    const resolved = resolveActivityPresentation(input,{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    });
    expect(resolved.stored.presentation.identity.thread?.label).toBe("Codex task");
    const unnamed = resolveActivityPresentation({ ...input,context: { project: "relo" } },{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    });
    expect(unnamed.stored.presentation.identity.thread?.label).toHaveLength(48);
    expect(unnamed.stored.presentation.identity.thread?.label.endsWith("…")).toBe(true);
    // Colors still key on the stable origin identity.
    expect(unnamed.stored.presentation.identity.thread?.color).toBe(resolved.stored.presentation.identity.thread?.color);
  });

  test("applies automatic server defaults without client appearance fields", () => {
    const resolved = resolveActivityPresentation({
      title: "Codex task",
      status: "Planning",
      progress: 0.05,
      lifecycle: { provider: "codex",runId: "run-1" },
      origin: {
        sourceInstance: "desktop",
        project: "relo",
        thread: "opaque-thread",
        channel: "task-progress",
      },
    },{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    });
    expect(resolved.stored).toMatchObject({
      title: "Codex task",
      style: "standard",
      symbol: "build",
      progress: 0.05,
    });
    expect(resolved.snapshot).toMatchObject({ source: "system",explicit: [] });
    expect(resolved.snapshot).toMatchObject({
      presetId: "system.agent.measured",presetRevision: 1,
    });
  });

  test("treats explicit automatic as server delegation and omits meaningless progress",() => {
    const inherited = { ...SYSTEM_PRESENTATION_POLICY };
    const delegated = resolveActivityPresentation({
      title: "Codex task",status: "Working",preset: "automatic",privacyMode: "standard",
    },{
      principalId: "principal-1",
      effective: { policy: inherited,source: "account" },
    });
    expect(delegated.stored).toMatchObject({ style: "standard",progress: null });
    expect(delegated.snapshot).toMatchObject({
      source: "account",explicit: [],presetId: "system.agent.informational",presetRevision: 1,
    });

    const attention = resolveActivityPresentation({
      title: "Codex task",status: "Needs attention",symbol: "warning",privacyMode: "standard",
    },{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    });
    expect(attention.stored).toMatchObject({ style: "standard",progress: null });
    expect(attention.snapshot.presetId).toBe("system.agent.attention");
  });

  test("honors fixed scoped policy and explicit invocation overrides", () => {
    const policy = {
      colorStrategy: "fixed" as const,
      accentColor: "#63B3FF",
    };
    const inherited = resolveActivityPresentation({
      title: "Release",status: "Building",progress: 0.4,privacyMode: "standard",
    },{
      principalId: "principal-1",
      effective: { policy,source: "service" },
    });
    expect(inherited.stored).toMatchObject({
      style: "standard",accentColor: "#63B3FF",
    });
    expect(inherited.stored.presentation).toMatchObject({
      components: [{ type: "progress_bar",value: 0.4 }],
    });
    expect(inherited.stored.presentation.appearance.theme).toBe("system");

    const explicit = resolveActivityPresentation({
      title: "Release",status: "Building",progress: 0.4,privacyMode: "standard",
      style: "steps",symbol: "warning",accentColor: "#FF7A90",theme: "light",
    },{
      principalId: "principal-1",
      effective: { policy,source: "service" },
    });
    expect(explicit.stored).toMatchObject({
      style: "standard",symbol: "warning",accentColor: "#FF7A90",
    });
    expect(explicit.stored.presentation.appearance.theme).toBe("light");
    expect(explicit.snapshot.explicit).toEqual([
      "theme","symbol","style","accentColor",
    ]);
  });

  test("assigns one deterministic color to the same opaque task", () => {
    const input = {
      title: "Task",status: "Working",privacyMode: "standard",
      origin: {
        sourceInstance: "desktop",project: "relo",thread: "task-123",channel: "work",
      },
    };
    const effective = { policy: SYSTEM_PRESENTATION_POLICY,source: "account" as const };
    const first = resolveActivityPresentation(input,{ principalId: "principal-1",effective });
    const second = resolveActivityPresentation(input,{ principalId: "principal-1",effective });
    expect(first.stored.accentColor).toBe(second.stored.accentColor);
  });

  test("owns project, thread, and state identity while keeping their roles distinct",() => {
    const resolve = (project: string,threadName: string) => resolveActivityPresentation({
      presentation: currentPresentation,status: "Waiting for review",context: { project,threadName },
    },{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    }).stored.presentation;
    const first = resolve("Relo","Release execution");
    const repeated = resolve("Relo","Release execution");
    const sibling = resolve("Heard","Release execution");
    expect(first).toMatchObject({
            identity: {
        project: { label: "Relo",icon: "project",provenance: "generated" },
        thread: { label: "Release execution",icon: "thread",provenance: "generated" },
        direct: false,
      },
      state: { kind: "waiting",tone: "waiting",icon: "waiting" },
      components: [
        { id: "steps",type: "steps" },
        { id: "fraction",type: "progress_bar" },
      ],
    });
    expect(first.identity).toEqual(repeated.identity);
    expect(first.identity.project?.color).not.toBe(first.identity.thread?.color);
    expect(first.identity.project?.color).not.toBe(sibling.identity.project?.color);
  });

  test("preserves server-authored steps and measured progress on active updates",() => {
    const original = persistedPresentationColumns(currentPresentation);
    const preserved = preserveActivePresentationPolicy({
      title: original.title,status: original.status,detail: original.detail,progress: original.progress,
      symbol: original.symbol,style: original.style,privacy: original.privacy,
      accent_color: original.accentColor,presentation: original.presentation,
      presentation_sha256: original.presentationHash,
    },{ status: "Server tests",progress: 0.5 },original);
    expect(preserved.presentation).toMatchObject({
      content: { status: "Server tests" },
      components: [
        { id: "steps",type: "steps" },
        { id: "fraction",type: "progress_bar",value: 0.5,label: "25%" },
      ],
    });
  });

  test("steps draw the plan's own states; no step is current when none is marked", () => {
    const items = (steps: Record<string,unknown>) => (resolveActivityPresentation({
      title: "Release",status: "Building",steps: steps as never,privacyMode: "standard",
    },{ principalId: "principal-1",effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" } }).stored.presentation
      .components.find((component) => component.type === "steps") as { items: Array<{ state: string }> }).items.map((item) => item.state);
    expect(items({ labels: ["A","B","C"],current: 3 })).toEqual(["complete","complete","current"]);
    expect(items({ labels: ["A","B","C"],current: 1,states: ["pending","pending","pending"] })).toEqual(["pending","pending","pending"]);
    expect(items({ labels: ["A","B","C"],current: 3,states: ["pending","done","current"] })).toEqual(["pending","complete","current"]);
  });

  test("keeps the current layout when only cosmetic appearance changes",() => {
    const original = resolveActivityPresentation({
      title: "Release",status: "Building",progress: 0.5,progressLabel: "2 of 4",
      steps: { labels: ["Plan","Build","Verify"],current: 2 },privacyMode: "standard",
    },{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    }).stored;
    const cosmetic = resolveActivityPresentation({
      title: "Release",status: "Building",progress: 0.5,symbol: "success",privacyMode: "standard",
    },{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    }).stored;
    const preserved = preserveActivePresentationPolicy({
      title: original.title,status: original.status,detail: original.detail,progress: original.progress,
      symbol: original.symbol,style: original.style,privacy: original.privacy,
      accent_color: original.accentColor,presentation: original.presentation,
      presentation_sha256: original.presentationHash,
    },{ symbol: "success" },cosmetic);
    expect(preserved).toMatchObject({
      title: "Release",status: "Building",progress: 0.5,style: "steps",symbol: "success",
      presentation: {
        components: [
          { type: "steps" },
          { type: "progress_bar",value: 0.5,label: "2 of 4" },
        ],
      },
    });
  });

  test("compiles semantic steps and independent measured progress together",() => {
    const resolved = resolveActivityPresentation({
      title: "Release",status: "Building",progress: 0.625,progressLabel: "5 of 8",
      steps: { labels: ["Plan","Build","Verify"],current: 2 },
      context: { project: "Relo",threadName: "Release execution" },
      privacyMode: "standard",
    },{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    });
    expect(resolved.snapshot).toMatchObject({
      source: "invocation",presetId: "invocation.semantic-steps-progress",
      explicit: ["steps","progress","progressLabel"],
    });
    expect(resolved.stored.presentation).toMatchObject({
            content: { title: "Release",status: "Building" },
      identity: {
        project: { label: "Relo",provenance: "generated" },
        thread: { label: "Release execution",provenance: "generated" },
      },
      components: [
        { id: "named_steps",type: "steps",colorRole: "thread",items: [
          { label: "Plan",state: "complete" },
          { label: "Build",state: "current" },
          { label: "Verify",state: "pending" },
        ] },
        { id: "measured_progress",type: "progress_bar",colorRole: "project",
          value: 0.625,label: "5 of 8" },
      ],
      surfaces: {
        lock_screen: ["named_steps","measured_progress"],
        expanded_trailing: ["measured_progress"],
        expanded_bottom: ["named_steps"],
        compact_leading: ["named_steps"],
        compact_trailing: ["measured_progress"],
        minimal: ["measured_progress"],
      },
    });
  });

  test("a sealed work's steps carry the plan's ids, so the phone opens their labels by id",() => {
    const resolved = resolveActivityPresentation({
      title: "Encrypted card",status: "Updating…",
      steps: { labels: ["Step 1","Step 2"],ids: ["s1","s2"],current: 2,states: ["done","current"] },
      privacyMode: "standard",
    },{ principalId: "principal-1",effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" } });
    const steps = resolved.stored.presentation.components.find((component) => component.type === "steps");
    expect(steps).toMatchObject({ items: [{ id: "s1",label: "Step 1" },{ id: "s2",label: "Step 2" }] });
  });

  test("adds semantic steps to an active activity",() => {
    const original = resolveActivityPresentation({
      title: "Release",status: "Planning",progress: 0.25,privacyMode: "standard",
    },{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    }).stored;
    const semantic = resolveActivityPresentation({
      status: "Building",progress: 0.5,progressLabel: "2 of 4",
      steps: { labels: ["Plan","Build","Verify"],current: 2 },
      context: { project: "Relo",threadName: "Release execution" },
      privacyMode: "standard",
    },{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    }).stored;
    const upgraded = preserveActivePresentationPolicy({
      title: original.title,status: original.status,detail: original.detail,progress: original.progress,
      symbol: original.symbol,style: original.style,privacy: original.privacy,
      accent_color: original.accentColor,presentation: original.presentation,
      presentation_sha256: original.presentationHash,
    },{
      status: "Building",progress: 0.5,progressLabel: "2 of 4",
      steps: { labels: ["Plan","Build","Verify"],current: 2 },
    },semantic);
    expect(upgraded.presentation).toMatchObject({
      content: { title: "Release",status: "Building" },
      components: [{ type: "steps" },{ type: "progress_bar",value: 0.5,label: "2 of 4" }],
    });
  });

  test("keeps a started activity's appearance when inherited settings later change", () => {
    const original = resolveActivityPresentation({
      title: "Task",status: "Planning",progress: 0.05,privacyMode: "standard",
    },{
      principalId: "principal-1",
      effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    }).stored;
    const changed = resolveActivityPresentation({
      title: "Task",status: "Working",progress: 0.5,privacyMode: "standard",
    },{
      principalId: "principal-1",
      effective: {
        policy: {
          ...SYSTEM_PRESENTATION_POLICY,
          colorStrategy: "fixed",
          accentColor: "#FF7A90",
        },
        source: "account",
      },
    }).stored;
    const preserved = preserveActivePresentationPolicy({
      title: original.title,
      status: original.status,
      detail: original.detail,
      progress: original.progress,
      symbol: original.symbol,
      style: original.style,
      privacy: original.privacy,
      accent_color: original.accentColor,
      presentation: original.presentation,
      presentation_sha256: original.presentationHash,
    },{
      title: "Task",status: "Working",progress: 0.5,privacyMode: "standard",
    },changed);
    expect(preserved).toMatchObject({
      style: original.style,
      symbol: original.symbol,
      accentColor: original.accentColor,
      status: "Working",
      progress: 0.5,
    });
  });

  describe("computer icon and policy changes on open cards", () => {
    const input = { title: "Export",status: "Running",progress: 0.4,context: { project: "Relo",threadName: "Export run" } };
    const resolve = (policy: typeof SYSTEM_PRESENTATION_POLICY,computerIcon?: "server" | "cloud") =>
      resolveActivityPresentation(input,{ principalId: "principal-1",effective: { policy,source: "client" },computerIcon });
    const asRow = (stored: ReturnType<typeof resolve>["stored"]) => ({
      title: stored.title,status: stored.status,detail: stored.detail,progress: stored.progress,symbol: stored.symbol,
      style: stored.style,privacy: stored.privacy,accent_color: stored.accentColor,presentation: stored.presentation,
      presentation_sha256: stored.presentationHash,
    });

    test("a computer icon becomes the project token icon; the thread keeps its own", () => {
      const withIcon = resolve(SYSTEM_PRESENTATION_POLICY,"server").stored.presentation.identity;
      expect(withIcon.project).toMatchObject({ label: "Relo",icon: "server",provenance: "generated" });
      expect(withIcon.thread).toMatchObject({ icon: "thread" });
      expect(resolve(SYSTEM_PRESENTATION_POLICY).stored.presentation.identity.project).toMatchObject({ icon: "project" });
    });

    test("color follows the strategy: per project, or one accent", () => {
      const perProject = resolve(SYSTEM_PRESENTATION_POLICY).stored.presentation.identity.project!;
      const fixed = resolve({ ...SYSTEM_PRESENTATION_POLICY,colorStrategy: "fixed",accentColor: "#112233" }).stored
        .presentation.identity.project!;
      expect(fixed.color).toBe("#112233");
      expect(perProject.color).not.toBe("#112233");
    });

    test("an update that resolves the same project takes the policy's color and icon; an unscoped one does not", () => {
      const original = resolve(SYSTEM_PRESENTATION_POLICY).stored;
      const next = { ...SYSTEM_PRESENTATION_POLICY,colorStrategy: "fixed" as const,accentColor: "#112233" };
      const followed = preserveActivePresentationPolicy(asRow(original),
        { ...input },resolve(next,"cloud").stored);
      expect(followed.presentation.identity.project).toMatchObject({
        label: "Relo",color: "#112233",icon: "cloud",provenance: "generated" });
      // Labels, the thread and the content stay as stored.
      expect(followed.presentation.identity.thread).toEqual(original.presentation.identity.thread);
      expect(followed.presentation.content.title).toBe("Export");

      // An update without context resolves to the unscoped "Relo" identity: nothing is copied from it.
      const unscoped = resolveActivityPresentation({ title: "Export",status: "Running",progress: 0.5 },
        { principalId: "principal-1",effective: { policy: next,source: "client" },computerIcon: "cloud" }).stored;
      const kept = preserveActivePresentationPolicy(asRow(original),{ status: "Running",progress: 0.5 },unscoped);
      expect(kept.presentation.identity.project).toEqual(original.presentation.identity.project);
    });
  });
});
