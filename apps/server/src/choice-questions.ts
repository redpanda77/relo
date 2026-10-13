import type { ChoiceOption } from "@relo/notification-contracts";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export const CHOICE_CAPABILITY = "choice_questions";

/** Thrown when a choice would reach a phone whose Relo build cannot show it. */
export class ChoiceUnsupportedError extends Error {
  constructor(readonly deviceNames: string[]) { super("choice_unsupported"); }
}

export const choiceUnsupportedBody = (error: ChoiceUnsupportedError) => ({
  error: "choice_unsupported",
  message: error.deviceNames.length
    ? `Update Relo on ${error.deviceNames.join(", ")} to answer questions with options.`
    : "No phone can answer questions with options yet: install or update Relo on iPhone.",
  devices: error.deviceNames,
});

/**
 * The phones a choice notification reaches: the named ones when they can all show it, otherwise
 * every active phone that can. Throws when no phone could answer.
 */
export async function choiceDeviceTargets(query: Queryable,principalId: string,deviceIds: string[] | null): Promise<string[]> {
  if (deviceIds) {
    await assertChoiceTargets(query,principalId,deviceIds);
    return deviceIds;
  }
  const capable = (await query.query(
    `SELECT id FROM devices WHERE principal_id=$1 AND revoked_at IS NULL AND $2=ANY(capabilities) ORDER BY id`,
    [principalId,CHOICE_CAPABILITY],
  )).rows.map((row) => String(row.id));
  if (!capable.length) {
    await assertChoiceTargets(query,principalId,null);
    throw new ChoiceUnsupportedError([]);
  }
  return capable;
}

/**
 * A choice reaches only phones that declared they can show one; a phone without the capability
 * would fail to decode it. `deviceIds` null means every active phone of the account.
 */
export async function assertChoiceTargets(query: Queryable,principalId: string,deviceIds: string[] | null): Promise<void> {
  const missing = await query.query(
    `SELECT name FROM devices WHERE principal_id=$1 AND revoked_at IS NULL
       AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) AND NOT ($3=ANY(capabilities))
     ORDER BY name,id`,
    [principalId,deviceIds,CHOICE_CAPABILITY],
  );
  if (missing.rows.length) throw new ChoiceUnsupportedError(missing.rows.map((row) => String(row.name)));
}

/** The card's question behavior: Approve/Deny, Yes/No, or the choice's own options. */
export function questionBehavior(type: "approval" | "yes_no" | "choice",labels: {
  primary?: string | undefined; secondary?: string | undefined; options?: ChoiceOption[] | undefined;
}) {
  if (type === "choice") return { type: "choice" as const,options: labels.options! };
  const primary = labels.primary ?? (type === "approval" ? "Approve" : "Yes");
  const secondary = labels.secondary ?? (type === "approval" ? "Deny" : "No");
  return type === "approval"
    ? { type: "approval" as const,primary: { action: "approve" as const,label: primary },
        secondary: { action: "deny" as const,label: secondary } }
    : { type: "yes_no" as const,primary: { action: "yes" as const,label: primary },
        secondary: { action: "no" as const,label: secondary } };
}

/** Decisions on a card: the behaviors whose buttons answer a question. */
export const isQuestionBehavior = (type: string): type is "approval" | "yes_no" | "choice" =>
  type === "approval" || type === "yes_no" || type === "choice";
