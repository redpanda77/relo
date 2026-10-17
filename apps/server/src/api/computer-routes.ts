import type { Hono } from "hono";
import { computerRenameSchema,computerReportSchema,FACTS } from "@relo/notification-contracts";
import { requireScope } from "../auth.js";
import { wakeAccountStreams } from "../computer-invites.js";
import { findComputerByLogin,storeComputerReport,updateComputer } from "../computers/store.js";
import type { ApiRouteContext } from "./route-context.js";

/**
 * A computer's own routes (ADR 0011), for the CLI signed in on it. The report is observed device facts: the machine
 * says what its Relo setup looks like, the server stores the last one and shows it. It can only ever replace the
 * caller's own computer (the login's), so no body can name another. `PUT /api/computers/self` is the name and icon the
 * owner picks in `relo setup`: appearance, so the server stores it like the Dashboard's rename does.
 */
export function registerComputerRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db } = shared;
  app.put("/api/computers/self",requireScope("services:write"),async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId) return context.json({ error: "cli_credential_required" },403);
    if (auth.loginKind !== "login") return context.json({ error: "computer_rename_not_allowed" },403);
    const body = await context.req.json().catch(() => undefined);
    const parsed = computerRenameSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_request",message: "Send a name (1 to 80 characters), an icon, or both." },400);
    const computer = await findComputerByLogin(db,auth.credentialId);
    if (!computer || !await updateComputer(db,auth.principalId,computer.id,parsed.data)) return context.json({ error: "computer_rename_not_allowed" },403);
    return context.body(null,204);
  });
  app.put("/api/computers/self/report",requireScope("services:write"),async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId) return context.json({ error: "cli_credential_required" },403);
    // A CI token is a pipeline's, not a computer: it has none to report on.
    if (auth.loginKind !== "login") return context.json({ error: "computer_report_not_allowed" },403);
    const text = await context.req.text();
    if (Buffer.byteLength(text) > FACTS.computers.reportMaxBytes) {
      return context.json({ error: "report_too_large",message: `A report is at most ${FACTS.computers.reportMaxBytes} bytes.` },413);
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch { return context.json({ error: "invalid_request" },400); }
    const parsed = computerReportSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_request",message: "The report does not match the report schema." },400);
    if (!await storeComputerReport(db,auth.credentialId,parsed.data)) return context.json({ error: "computer_report_not_allowed" },403);
    await wakeAccountStreams(db,auth.principalId);
    return context.body(null,204);
  });
}
