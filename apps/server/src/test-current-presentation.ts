import type { LiveActivityPresentation } from "@relo/notification-contracts";
import { systemPresentationPolicySnapshot } from "./presentation-policy.js";
import { persistedPresentationColumns } from "./presentation-runtime.js";

export function currentTestPresentation(
  title = "Test activity",
  status = "Working",
  progress = 0.42,
): LiveActivityPresentation {
  const component = {
    id: "progress",
    type: "progress_bar" as const,
    colorRole: "project" as const,
    value: progress,
    label: `${Math.round(progress * 100)}%`,
  };
  return {
    content: { header: "Relo Test",title,subtitle: null,status },
    identity: {
      project: {
        label: "Relo",color: "#47E8B8",icon: "build",revision: 1,provenance: "generated",
      },
      thread: null,
      direct: false,
    },
    state: { kind: "active",tone: "live",icon: "active" },
    components: [component],
    surfaces: {
      lock_screen: [component.id],
      expanded_leading: [],
      expanded_trailing: [component.id],
      expanded_bottom: [component.id],
      compact_leading: [],
      compact_trailing: [component.id],
      minimal: [component.id],
    },
    behavior: { type: "progress" },
    appearance: {
      theme: "system",
      roles: { cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state" },
    },
    privacy: "standard",
  };
}

export function currentTestPresentationRecord(
  title = "Test activity",
  status = "Working",
  progress = 0.42,
) {
  const stored = persistedPresentationColumns(currentTestPresentation(title,status,progress));
  const policy = systemPresentationPolicySnapshot("system.test.current");
  return {
    presentation: stored.presentation,
    presentationHash: stored.presentationHash,
    presentationPolicy: policy,
    presentationPolicySource: policy.source,
    presentationPresetId: policy.presetId,
    presentationPresetRevision: policy.presetRevision,
  };
}
