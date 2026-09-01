import { describe, expect, test } from "vitest";
import {
  dashboardCurrentCommandReceipts,
  dashboardInteractionResponseText,
  dashboardPageNumber,
  dashboardProgressPresentationReplacement,
  dashboardReleaseIdentity,
  dashboardScript,
  dashboardSection,
  dashboardStyles,
  renderDashboardPager,
  renderDashboardDocument,
  renderDashboardActivityReceipt,
  renderDashboardActivityInteraction,
  renderDashboardServerAcceptedUpdate,
  updateDashboardActivityControlState,
  renderDashboardTabs,
  renderDocument,
  renderOneTimeServiceSecretPanel,
} from "./dashboard-ui.js";

describe("dashboard SSR shell", () => {
  test("recognizes only documented deep-link sections", () => {
    expect(dashboardSection(undefined)).toBe("inbox");
    for (const section of [
      "inbox", "inbox-notifications", "inbox-delivery", "connections-services",
      "connections-phones", "connections-clients", "testing", "account", "docs",
    ]) expect(dashboardSection(section)).toBe(section);
    expect(dashboardSection("admin")).toBeNull();
  });

  test("normalizes history pages and renders bounded accessible links", () => {
    expect(dashboardPageNumber(undefined)).toBe(1);
    expect(dashboardPageNumber("2")).toBe(2);
    for (const value of ["0","-1","1.5","abc","9007199254740992"]) {
      expect(dashboardPageNumber(value)).toBe(1);
    }
    expect(renderDashboardPager({ path: "/dashboard/inbox/notifications", page: 2, pageSize: 25, total: 61,
      query: { kind: "approval", state: undefined } })).toBe(
      '<nav class="pagination" data-slot="pagination" aria-label="History pages"><a class="button secondary" rel="prev" href="/dashboard/inbox/notifications?kind=approval&amp;page=1">Previous</a><span>Page 2 of 3 · 61 total</span><a class="button secondary" rel="next" href="/dashboard/inbox/notifications?kind=approval&amp;page=3">Next</a></nav>',
    );
    expect(renderDashboardPager({ path: "/dashboard/inbox/delivery", page: 99, pageSize: 25, total: 1 }))
      .toBe('<p class="pagination-summary" data-slot="pagination-summary">1 total</p>');
  });

  test("normalizes a public release identity with a safe development fallback", () => {
    expect(dashboardReleaseIdentity(" 0.2.0 ")).toBe("0.2.0");
    expect(dashboardReleaseIdentity(undefined)).toBe("dev");
    expect(dashboardReleaseIdentity("<script>")).toBe("dev");
  });

  test("builds one complete immutable current progress replacement", () => {
    const progress = {
            content: { header: "Relo",title: "Build",subtitle: "Compiling",status: "Working" },
      identity: { project: null,thread: null,direct: true },
      state: { kind: "active" as const,tone: "live" as const,icon: "active" as const },
      components: [{ id: "progress",type: "progress_bar" as const,colorRole: "project" as const,
        value: 0.42,label: "Compile" }],
      surfaces: { lock_screen: ["progress"],expanded_leading: [],expanded_trailing: ["progress"],
        expanded_bottom: ["progress"],compact_leading: [],compact_trailing: ["progress"],minimal: ["progress"] },
      behavior: { type: "progress" as const },
      appearance: { theme: "dark" as const,roles: { cardIdentity: "project" as const,
        componentIdentity: "thread" as const,statusEmphasis: "state" as const } },
      privacy: "standard" as const,
    };
    expect(dashboardProgressPresentationReplacement(progress,"Testing",63)).toEqual({
      ...progress,
      content: { ...progress.content,status: "Testing" },
      components: [{ ...progress.components[0],value: 0.63 }],
    });
    expect(progress.components[0]!.value).toBe(0.42);

    const steps = { ...progress,components: [{ id: "steps",type: "steps" as const,
      colorRole: "project" as const,items: [
      { id: "one",label: "One",state: "current" as const },
      { id: "two",label: "Two",state: "pending" as const },
      { id: "three",label: "Three",state: "pending" as const },
    ] }] };
    expect(dashboardProgressPresentationReplacement(steps,"Done",100).components[0]).toEqual({
      ...steps.components[0],items: steps.components[0]!.items.map((item) => ({ ...item,state: "complete" })),
    });
    expect(() => dashboardProgressPresentationReplacement({
      ...progress,components: [],surfaces: {},behavior: { type: "informational" },
    },"No update",50)).toThrow("does not support progress updates");
  });

  test("selects only exact current activity receipts from the canonical device ledger", () => {
    const current = { eventId: "ntf_current",device: { id: "dev_one",name: "iPhone" },
      receivedAt: "2026-08-07T12:00:00.000Z",activityId: "act_selected",operation: "start",sequence: 0 };
    const status = {
      id: "act_selected",sequence: 0,
      deviceReceipts: [
        current,
        { ...current,eventId: "ntf_old_sequence",sequence: 1 },
        { ...current,eventId: "ntf_sibling",activityId: "act_sibling" },
        { ...current,eventId: "ntf_missing_device",device: null },
      ],
      currentCommandReceipts: [],
    };

    expect(dashboardCurrentCommandReceipts(status)).toEqual([current]);
    expect(dashboardCurrentCommandReceipts({ ...status,sequence: "0" })).toEqual([current]);
    expect(dashboardCurrentCommandReceipts({ ...status,deviceReceipts: undefined })).toEqual([]);
  });

  test("refreshes the exact session containing the clicked receipt control", async () => {
    const receipt = (textContent: string) => ({ textContent });
    const recovery = { disabled: false,dataset: {} as Record<string,string>,textContent: null };
    const session = (receiptNode: { textContent: string }) => ({
      dataset: { activityId: "act_selected",state: "active" },
      querySelector: (selector: string) => selector === "[data-activity-receipt]" ? receiptNode
        : selector === "[data-receipt-recovery]" ? recovery : null,
      querySelectorAll: () => [],
      setAttribute: () => undefined,
    });
    const staleReceipt = receipt("0/1 exact event receipt(s) for sequence 0 remain unconfirmed.");
    const liveReceipt = receipt("Checking the exact current event ID...");
    const staleSession = session(staleReceipt);
    const liveSession = session(liveReceipt);
    const activity = {
      id: "act_selected",title: "Build",status: "Working",state: "active",progress: 0.42,sequence: 0,
      targets: [],delivery: null,interaction: null,
      deviceReceipts: [{ eventId: "ntf_start",device: { id: "dev_one",name: "iPhone" },
        receivedAt: "2026-08-07T12:00:00.000Z",activityId: "act_selected",operation: "start",sequence: 0 }],
    };
    const operation = { dataset: { state: "idle" },textContent: "Ready." };
    let clickHandler: ((event: { target: typeof button }) => Promise<void>) | undefined;
    const button = {
      dataset: { action: "retry-live-activity-receipt" },
      hasAttribute: (name: string) => name === "data-workbench-observer",
      closest: (selector: string) => selector === "button[data-action]" ? button
        : selector === "[data-workbench-session]" ? liveSession : null,
    };
    const documentStub = {
      activeElement: null,visibilityState: "visible",
      getElementById: (id: string) => id === "activity-session" ? staleSession
        : id === "workbench-operation" ? operation : null,
      querySelector: (selector: string) => selector.startsWith("[data-workbench-session]")
        ? staleSession : null,
      querySelectorAll: () => [],
      addEventListener: (type: string,handler: (event: { target: typeof button }) => Promise<void>) => {
        if (type === "click") clickHandler = handler;
      },
    };
    let fetchCount = 0;
    new Function("document","window","fetch","setInterval","CSS","navigator","location",dashboardScript)(
      documentStub,
      { matchMedia: () => ({ matches: false,addEventListener: () => undefined }),confirm: () => true },
      async () => ({ ok: true,json: async () => ({ activity: fetchCount++ ? activity : {
        ...activity,deviceReceipts: activity.deviceReceipts.map((item) => ({ ...item,receivedAt: null })),
      } }) }),
      () => 0,{ escape: (value: string) => value },{ clipboard: { writeText: async () => undefined } },
      { assign: () => undefined,reload: () => undefined },
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(staleReceipt.textContent).toBe("0/1 exact event receipt(s) for sequence 0 remain unconfirmed.");
    expect(clickHandler).toBeTypeOf("function");
    await clickHandler!({ target: button });

    expect(liveReceipt.textContent).toBe("1/1 exact event receipt(s) for sequence 0 confirmed by phone.");
    expect(staleReceipt.textContent).not.toBe(liveReceipt.textContent);
    expect(operation.textContent).toBe("The latest phone confirmation is committed.");
    expect(renderDashboardActivityReceipt(liveSession,activity)).toEqual({ expected: 1,confirmed: 1 });
  });

  test("closes terminal mutations while preserving an outstanding receipt observer", () => {
    const mutation = () => ({ disabled: false,dataset: {} as Record<string,string> });
    const status = mutation();
    const progress = mutation();
    const update = mutation();
    const end = mutation();
    const recovery = mutation();
    const root = {
      querySelectorAll: (selector: string) => selector === "input,[data-workbench-action]"
        ? [status,progress,update,end] : [],
      querySelector: (selector: string) => selector === "[data-receipt-recovery]" ? recovery : null,
    };

    expect(updateDashboardActivityControlState(root,"ended",{ expected: 1,confirmed: 0 }))
      .toEqual({ terminal: true,recoveryUnavailable: false });
    for (const control of [status,progress,update,end]) {
      expect(control).toMatchObject({ disabled: true,dataset: { terminal: "true" } });
    }
    expect(recovery).toMatchObject({ disabled: false,dataset: { terminal: "false" } });

    expect(updateDashboardActivityControlState(root,"ended",{ expected: 1,confirmed: 1 }))
      .toEqual({ terminal: true,recoveryUnavailable: true });
    expect(recovery).toMatchObject({ disabled: true,dataset: { terminal: "true" } });
  });

  test("keeps terminal approval, yes-no, and text responses scoped to the exact run", () => {
    const siblingInteraction = { textContent: "progress | ended | phone receipt remains unconfirmed" };
    const selectedInteraction = { textContent: "No response requested for this run." };
    const session = (activityId: string,node: typeof selectedInteraction) => ({
      dataset: { activityId,state: "ended" },
      querySelector: (selector: string) => selector === "[data-activity-interaction]" ? node : null,
    });
    const sibling = session("act_progress",siblingInteraction);
    const selected = session("act_interactive",selectedInteraction);
    const respondedAt = "2026-08-07T12:00:00.000Z";
    const device = { id: "dev_one",name: "Browser Acceptance iPhone" };

    expect(dashboardInteractionResponseText({ action: "approve" })).toBe("");
    expect(renderDashboardActivityInteraction(selected,{ interaction: {
      kind: "approval",state: "approved",action: "approve",response: { action: "approve" },
      device,respondedAt,
    } })).toBe(
      "approval | approved | action approve | device Browser Acceptance iPhone | responded 2026-08-07T12:00:00.000Z",
    );
    expect(renderDashboardActivityInteraction(selected,{ interaction: {
      kind: "yes_no",state: "yes",action: "yes",response: { action: "yes" },device,respondedAt,
    } })).toBe(
      "yes_no | yes | action yes | device Browser Acceptance iPhone | responded 2026-08-07T12:00:00.000Z",
    );
    expect(dashboardInteractionResponseText({ response: "Continue after browser acceptance." }))
      .toBe("Continue after browser acceptance.");
    expect(renderDashboardActivityInteraction(selected,{ interaction: {
      kind: "text",state: "replied",action: "answer",
      response: { response: "Continue after browser acceptance." },device,respondedAt,
    } })).toBe(
      "text | replied | action answer | value Continue after browser acceptance. | device Browser Acceptance iPhone | responded 2026-08-07T12:00:00.000Z",
    );
    expect(sibling.dataset.activityId).toBe("act_progress");
    expect(siblingInteraction.textContent).toBe("progress | ended | phone receipt remains unconfirmed");
  });

  test("repaints a server-accepted update before phone confirmation", () => {
    const node = (textContent = "") => ({ textContent,dataset: {} as Record<string,string> });
    const state = node("active");
    const server = node("Working | sequence 0 | 42%");
    const receipt = node("1/1 exact event receipt(s) for sequence 0 confirmed by phone.");
    const progress = { value: "42" };
    const progressOutput = node("42%");
    const previewProgress = node();
    const previewStatus = node("Working");
    const previewPercent = node("42%");
    const root = {
      dataset: { activityId: "act_selected",state: "active" },
      querySelector: (selector: string) => ({
        "[data-activity-state]": state,
        "[data-activity-server]": server,
        "[data-activity-receipt]": receipt,
        "#activity-progress": progress,
        "#activity-progress-output": progressOutput,
      } as Record<string,unknown>)[selector] ?? null,
      querySelectorAll: (selector: string) => ({
        "[data-preview-progress]": [previewProgress],
        "[data-preview-status]": [previewStatus],
        "[data-preview-percent],[data-preview-island-trailing]": [previewPercent],
      } as Record<string,unknown[]>)[selector] ?? [],
    };

    expect(renderDashboardServerAcceptedUpdate(root,{
      id: "act_selected",state: "active",status: "Browser running 63%",progress: 0.63,sequence: 1,
    })).toBe(true);
    expect(root.dataset).toEqual({ activityId: "act_selected",state: "active" });
    expect(state).toMatchObject({ textContent: "active",dataset: { state: "active" } });
    expect(server.textContent).toBe("Browser running 63% | sequence 1 | 63%");
    expect(receipt.textContent).toBe("Phone confirmation for update sequence 1 is pending.");
    expect(progress.value).toBe("63");
    expect(progressOutput.textContent).toBe("63%");
    expect(previewProgress.dataset.previewProgress).toBe("63");
    expect(previewStatus.textContent).toBe("Browser running 63%");
    expect(previewPercent.textContent).toBe("63%");
    expect(renderDashboardServerAcceptedUpdate({ ...root,dataset: { activityId: "act_sibling" } },{
      id: "act_selected",state: "active",status: "Wrong run",progress: 0.9,sequence: 2,
    })).toBe(false);
    expect(server.textContent).toBe("Browser running 63% | sequence 1 | 63%");
  });

  test("restores focus to a connected revoke control after a failed mutation", async () => {
    const message = { textContent: "" };
    let clickHandler: ((event: { target: typeof button }) => Promise<void>) | undefined;
    let disabled = false;
    const documentStub: any = {
      activeElement: null,visibilityState: "visible",
      getElementById: (id: string) => id === "dashboard-message" ? message : null,
      querySelector: () => null,querySelectorAll: () => [],
      addEventListener: (type: string,handler: typeof clickHandler) => {
        if (type === "click") clickHandler = handler;
      },
    };
    const button: any = {
      dataset: { action: "revoke-device",id: "dev_selected" },isConnected: true,
      hasAttribute: () => false,
      closest: (selector: string) => selector === "button[data-action]" ? button : null,
      focus: () => { documentStub.activeElement = button; },
    };
    Object.defineProperty(button,"disabled",{
      get: () => disabled,
      set: (value) => {
        disabled = value;
        if (value && documentStub.activeElement === button) documentStub.activeElement = null;
      },
    });
    button.focus();
    new Function("document","window","fetch","setInterval","CSS","navigator","location",dashboardScript)(
      documentStub,
      { matchMedia: () => ({ matches: false,addEventListener: () => undefined }),confirm: () => true },
      async () => ({ ok: false,json: async () => ({ error: "synthetic_revoke_device_failure" }) }),
      () => 0,{ escape: (value: string) => value },{ clipboard: { writeText: async () => undefined } },
      { assign: () => undefined,reload: () => undefined },
    );

    expect(clickHandler).toBeTypeOf("function");
    await clickHandler!({ target: button });
    expect(button.disabled).toBe(false);
    expect(documentStub.activeElement).toBe(button);
    expect(message.textContent).toBe("synthetic_revoke_device_failure");
  });

  test("renders external assets and an accessible active navigation state", () => {
    const html = renderDashboardDocument({
      active: "inbox-delivery",
      title: "Delivery <unsafe>",
      eyebrow: "Messaging",
      description: "Target-level status",
      content: "<section>Trusted server-rendered content</section>",
      releaseIdentity: "0.2.0",
      account: { initial: "K", name: "Owner", email: "owner@example.test" },
    });

    expect(html).toContain('class="skip-link" data-slot="skip-link" href="#main-content"');
    expect(html).toContain('aria-controls="dashboard-sidebar"');
    expect(html).toContain('<aside class="sidebar" data-slot="sidebar" id="dashboard-sidebar" aria-label="Dashboard navigation">');
    expect(html).toContain('href="/dashboard" aria-current="page">Inbox</a>');
    expect(html).toContain('<main class="dashboard-main" data-slot="dashboard-content" id="main-content" tabindex="-1">');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('data-release-identity="0.2.0" aria-label="Running release 0.2.0"');
    expect(html).toContain('<body class="dashboard-body" data-slot="dashboard-root"><!-- IMPECCABLE-DIRECTION seed=neon-shadcn-operate');
    for (const field of ["THESIS:","OWN-WORLD:","STORY:","FIRST VIEWPORT:","FORM:","FINISH:"]) {
      expect(html).toContain(field);
    }
    expect(html).not.toContain('<div class="eyebrow">');
    expect(html).not.toContain("Messaging");
    expect(html).not.toContain("☰");
    expect(html).not.toContain("↪");
    expect(html).toContain('<span class="menu-icon" aria-hidden="true"><i></i><i></i><i></i></span>');
    expect(html).toContain('<button id="sign-out" class="icon-button" data-slot="button" type="button">Sign out</button>');
    expect(html).toContain("Delivery &lt;unsafe&gt;");
    expect(html).toContain('/assets/relo-dashboard.css');
    expect(html).toContain('/assets/relo-dashboard.js');
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("<script>");
  });

  test("renders route-backed subtabs with counts and page history semantics", () => {
    expect(renderDashboardTabs({ label: "Inbox", active: "notifications", tabs: [
      { id: "inbox", label: "Inbox", href: "/dashboard", count: 2 },
      { id: "notifications", label: "Notifications", href: "/dashboard/inbox/notifications", count: 7 },
    ] })).toBe('<nav class="route-tabs" data-slot="tabs-list" aria-label="Inbox"><a class="route-tab" data-slot="tabs-trigger" href="/dashboard">Inbox<span class="route-tab-count" data-slot="badge">2</span></a><a class="route-tab" data-slot="tabs-trigger" href="/dashboard/inbox/notifications" aria-current="page">Notifications<span class="route-tab-count" data-slot="badge">7</span></a></nav>');
  });

  test("public documents use the same external asset boundary", () => {
    const html = renderDocument("Account", '<form id="auth-form"></form>');
    expect(html).toContain('<main class="public-main" data-slot="public-content" id="main-content">');
    expect(html).toContain('src="/assets/relo-dashboard.js" defer');
  });

  test("assets include semantic tokens and interaction safeguards", () => {
    for (const token of [
      "--background:#000000", "--card:#111315", "--popover:#18191b", "--border:#303236",
      "--foreground:#ffffff", "--muted-foreground:#a1a1aa", "--primary:#285d49",
      "--radius:4px", '--font-sans:Inter,"Inter Fallback"', "--font-mono:GeistMono",
    ]) expect(dashboardStyles).toContain(token);
    expect(dashboardStyles.match(/:root\{/g)).toHaveLength(1);
    expect(dashboardStyles).toContain("[hidden]{display:none!important}");
    expect(dashboardStyles).toContain("@media(prefers-reduced-motion:reduce)");
    expect(dashboardStyles).toContain("@media(max-width:800px)");
    expect(dashboardStyles).toContain(":focus-visible");
    expect(dashboardStyles).toContain("button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px");
    expect(dashboardStyles).toContain("details>summary{display:flex;align-items:center;gap:8px;min-height:44px");
    expect(dashboardStyles).toContain(".builder-preview-header{color:var(--preview-accent)}");
    expect(dashboardStyles).toContain(".history-link{display:flex");
    expect(dashboardStyles).toContain(".pagination");
    expect(dashboardStyles).toContain(".lab-workspace");
    expect(dashboardStyles).toContain(".route-tabs");
    expect(dashboardStyles).toContain(".run-list");
    expect(dashboardStyles).toContain(".run-entry.is-expanded");
    expect(dashboardStyles).toContain(".run-card-summary,.run-card-evidence{display:flex");
    expect(dashboardStyles).toContain(".run-detail-layout");
    expect(dashboardStyles).toContain(".builder-options,.builder-capabilities,.run-identity");
    expect(dashboardStyles).toContain(".run-status-timeline{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(dashboardStyles).toContain("li[data-evidence-state=current] .timeline-marker");
    expect(dashboardStyles).toContain("@keyframes timeline-current");
    expect(dashboardStyles).toContain(".operation-feedback.is-acknowledged");
    expect(dashboardStyles).toContain(".activity-builder-preview");
    expect(dashboardStyles).toContain(".workbench-selected-preview");
    expect(dashboardStyles).toContain(".builder-options-body");
    expect(dashboardStyles).toContain(".activity-builder-preview.theme-system");
    expect(dashboardStyles).toContain(".operation-feedback[data-state=failure]");
    expect(dashboardStyles).toContain(".operation-feedback[data-state=unconfirmed]");
    expect(dashboardScript).toContain("builderDraftKey='relo:test-lab-builder:v1'");
    expect(dashboardScript).toContain("window.sessionStorage?.setItem");
    expect(dashboardScript).toContain("window.sessionStorage?.getItem");
    expect(dashboardScript).toContain("builder?.addEventListener('submit'");
    expect(dashboardScript).toContain("builderPreview.style.setProperty('--la',accent)");
    for (const palette of [
      "--la:#47E8B8;--la2:#08755C",
      "--la:#FF7A40;--la2:#D1297A", "--la:#4DF594;--la2:#056B4D",
      "--la:#8FADFF;--la2:#38D1E0", "--la:#FF943D;--la2:#BF331A",
      "--la:#45ED9E;--la2:#0D96B8", "--la:#5CA8FF;--la2:#783DF0",
      "--la:#FF5E45;--la2:#FFAD33",
    ]) expect(dashboardStyles).toContain(palette);
    expect(dashboardStyles).toContain("border-radius:25px");
    expect(dashboardStyles).toContain("padding:16px");
    expect(dashboardStyles).not.toContain("gradient");
    expect(dashboardStyles).not.toContain("box-shadow");
    expect(dashboardStyles).not.toContain("border-left:3px");
    const luminance = (hex: string) => {
      const [red,green,blue] = hex.match(/[0-9a-f]{2}/gi)!.map((channel) => Number.parseInt(channel,16)/255)
        .map((channel) => channel <= 0.04045 ? channel/12.92 : ((channel+0.055)/1.055)**2.4);
      return 0.2126*red!+0.7152*green!+0.0722*blue!;
    };
    const mutedTextContrast = (luminance("#a1a1aa")+0.05)/(luminance("#111315")+0.05);
    expect(dashboardStyles).toContain(".nav-label{padding:0 10px 6px;color:var(--muted-foreground)");
    expect(dashboardStyles).toContain(".sidebar{position:fixed");
    expect(dashboardStyles).toContain("background:var(--sidebar);border-right:1px solid var(--border)");
    expect(mutedTextContrast).toBeGreaterThanOrEqual(4.5);
    expect(() => new Function(dashboardScript)).not.toThrow();
    expect(dashboardScript).toContain("window.confirm(confirmation)");
    expect(dashboardScript).toContain("mutate('/api/auth/sign-out','POST',{})");
    expect(dashboardScript).toContain("/api/auth/change-password");
    expect(dashboardScript).toContain("document.visibilityState==='visible'");
    expect(dashboardScript).toContain("document.activeElement!==progress");
    expect(dashboardScript).toContain("let activityRefresh=null");
    expect(dashboardScript).toContain("dashboardCurrentCommandReceipts(data)");
    expect(dashboardScript).toContain("dashboardCurrentCommandReceipts(current)");
    expect(dashboardScript).toContain("renderDashboardActivityReceipt(selected,data)");
    expect(dashboardScript).toContain("renderDashboardActivityInteraction(selected,data)");
    expect(dashboardScript).toContain("renderDashboardServerAcceptedUpdate(workbench,activity");
    expect(dashboardScript).toContain("updateDashboardActivityControlState(selected,data.state,receiptState)");
    expect(dashboardScript).toContain("[data-workbench-action],[data-workbench-observer]");
    expect(dashboardScript).toContain("refreshActivity(activityId,true,selectedSession)");
    expect(dashboardScript).toContain("[data-workbench-session][data-activity-id=");
    expect(dashboardScript).not.toContain("cache:'no-store'");
    expect(dashboardScript).toContain("snapshotRequest=null,snapshotSequence=0,snapshotApplied=0");
    expect(dashboardScript).toContain("if(document.visibilityState!=='visible'||snapshotRequest)return snapshotRequest");
    expect(dashboardScript).toContain("if(sequence<=snapshotApplied)return");
    expect(dashboardScript).toContain("setInterval(refreshSnapshot,15000)");
    expect(dashboardScript).toContain("'#activity-session'");
    expect(dashboardScript).toContain("document.addEventListener('visibilitychange'");
    expect(dashboardScript).toContain("data-device-last-seen");
    expect(dashboardScript).toContain("data-client-last-used");
    expect(dashboardScript).not.toContain("location.reload()\nif(document.querySelector('[data-snapshot-count]");
    expect(dashboardScript).toContain("['approval','yes_no','text'].includes(kind)");
    expect(dashboardScript).toContain("progressOutput.textContent=value");
    expect(dashboardStyles.match(/\[data-preview-progress="\d+"\]/g)).toHaveLength(101);
    expect(dashboardStyles).toContain('[data-preview-progress="0"]{--preview-progress:0%}');
    expect(dashboardStyles).toContain('[data-preview-progress="100"]{--preview-progress:100%}');
    expect(dashboardStyles).toContain("attr(data-preview-accent type(<color>),#47e8b8)");
    expect(dashboardStyles).toContain(".builder-steps i.is-current");
    expect(dashboardStyles).toContain(".activity-builder-preview.theme-light");
    expect(dashboardScript).toContain("node.dataset.previewProgress=value");
    expect(dashboardScript).toContain("const accent=(preview.identity.project?.color||'#47E8B8').toLowerCase()");
    expect(dashboardScript).toContain("builderPreview.dataset.previewAccent=accent");
    expect(dashboardScript).toContain("builderPreview.style.setProperty('--la',accent)");
    expect(dashboardScript).toContain("builderPreview.style.setProperty('--preview-accent',accent)");
    expect(dashboardScript).toContain("function builderConfiguration()");
    expect(dashboardScript).toContain("content:{header");
    expect(dashboardScript).toContain("components:component?[component]:[]");
    expect(dashboardScript).toContain("appearance:{theme:builderFields.theme?.value||'system',roles:");
    expect(dashboardScript).toContain("privacy:'standard'");
    expect(dashboardScript).toContain("presentation:builderConfiguration()");
    expect(dashboardScript).not.toContain("config:builderConfiguration()");
    expect(dashboardScript).toContain("presentation:selectedPresentationUpdate(status,percent)");
    expect(dashboardScript).toContain("dashboardProgressPresentationReplacement(presentation,status,percent)");
    expect(dashboardScript).not.toContain("{progress:percent/100,status}");
    expect(dashboardScript).toContain("builder.reportValidity()");
    expect(dashboardScript).toContain("function builderStepItems()");
    expect(dashboardScript).toContain("type==='steps'");
    expect(dashboardScript).toContain("type==='approval'");
    expect(dashboardScript).toContain("type==='yes_no'");
    expect(dashboardScript).toContain("function applyBuilderPreset()");
    expect(dashboardScript).toContain("JSON.parse(raw)");
    expect(dashboardScript).not.toContain("const builderPresets=");
    expect(dashboardScript).toContain("'[data-builder-progress-fields]').hidden=!progressBehavior");
    expect(dashboardScript).toContain("'[data-builder-steps-control]').hidden=!progressBehavior");
    expect(dashboardScript).not.toContain("function selectWorkbenchTab");
    expect(dashboardScript).toContain("location.assign('/dashboard/testing/runs/'");
    expect(dashboardScript).toContain("renderSelectedPreview(data.activity)");
    expect(dashboardScript).toContain("{kind,prompt}");
    expect(dashboardScript).toContain("waitForDeviceReceipts");
    expect(dashboardScript).toContain("for(let attempt=0;attempt<5;attempt+=1)");
    expect(dashboardScript).toContain("Response request remains committed and unanswered; lifecycle controls are available.");
    expect(dashboardScript).toContain("retry-live-activity-receipt");
    expect(dashboardScript).toContain("exact-event phone confirmation(s) are still outstanding");
    expect(dashboardScript).toContain("receipt.respondedAt");
    expect(dashboardScript).toContain("responded ${new Date(receipt.respondedAt).toISOString()}");
    expect(dashboardScript).toContain("exact event receipt(s) for sequence");
    expect(dashboardScript).toContain("Waiting for '+data.eventIds.length+' iPhone confirmation(s)");
    expect(dashboardScript).toContain("Phone confirmed update");
    expect(dashboardScript).toContain("/api/dashboard/live-activities/end-all");
    expect(dashboardScript).toContain("renderMutationState(path,method,data)");
    expect(dashboardScript).toContain("path.endsWith('/update')&&data.activity?.id");
    expect(dashboardScript).toContain("path.endsWith('/end')&&data.activity?.id&&data.activity?.state==='ended'");
    expect(dashboardScript).toContain("renderRunState(activityId,'ended',sequence,activity.progress??1)");
    expect(dashboardScript).toContain("Phone confirmation for finish sequence '+sequence+' is pending.");
    expect(dashboardScript).toContain("setOperation('failure',value)");
    expect(dashboardScript).toContain("function setOperation(state,value){if(operation){operation.dataset.state=state;operation.textContent=value;operation.classList?.remove('is-acknowledged')");
    expect(dashboardScript).toContain("['success','terminal'].includes(state)");
    expect(dashboardScript).toContain("operation.classList?.add('is-acknowledged')");
    expect(dashboardScript).not.toContain("operation.textContent=value}announce(value)");
    expect(dashboardScript).toContain("else{announce(value);button.disabled=false;if(button.isConnected)button.focus()}");
    expect(dashboardScript).toContain("if(button.isConnected)button.focus()");
    expect(dashboardScript).toContain("Activity finish confirmed by the iPhone.");
    expect(dashboardScript).toContain("showServiceSecret(data.webhookUrl,button)");
    expect(dashboardScript).toContain("navigator.clipboard.writeText(serviceSecretValue)");
    expect(dashboardScript).toContain("serviceSecretValue=''");
    expect(dashboardScript).toContain("if(trigger?.isConnected)trigger.focus()");
    expect(dashboardScript).not.toContain("Webhook URL (copy now): '+data.webhookUrl");
  });

  test("renders an initially empty accessible one-time secret panel", () => {
    const html = renderOneTimeServiceSecretPanel();
    expect(html).toContain('class="secret-panel" data-slot="alert"');
    expect(html).toContain('role="region" aria-labelledby="service-secret-heading" hidden');
    expect(html).toContain('id="copy-service-secret" data-slot="button"');
    expect(html).toContain('id="dismiss-service-secret" class="secondary" data-slot="button"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain("raw URL is never rendered");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("hook_");
  });
});
