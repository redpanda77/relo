// What `relo auth join CODE` does after the code is redeemed (docs/internal/product/plan/13-onboarding-wizard.md):
// the clear one-line failures, the self-check, the first machine report, the "connected" notice and the summary.
// Owner type module. It never prompts, never opens a browser and never waits on stdin: it runs from `curl | sh`
// and under agents.
import { ApiError, EXIT, NetworkError, ReloError } from "../shared/errors.mjs";
import { harnessLabel } from "../harness/catalog.mjs";
import { getAuthenticated } from "../shared/login.mjs";
import { sealNoticeRequest, sealablePhones, trustFor } from "../crypto/seal-notice.mjs";
import { quietSelfCheck } from "./doctor.mjs";
import { harnessesOf } from "./machine-report.mjs";

const hostOf = (apiUrl) => { try { return new URL(apiUrl).host; } catch { return String(apiUrl); } };

const GATE = (host) => `${host} answered with a sign-in page or a refusal that is not Relo's. A gate in front of the server (Cloudflare Access) is blocking this computer.`;

/** The one-line failure for a redeem that did not work, as a ReloError; undefined `error` is an answer that is not Relo's. */
export function joinRedeemFailure(error, apiUrl) {
  const host = hostOf(apiUrl);
  if (error === undefined) return new ReloError(GATE(host), { code: "ACCESS_BLOCKED", exitCode: EXIT.NETWORK });
  if (error instanceof ApiError) {
    const code = String(error.code ?? "").toLowerCase();
    if (code === "invalid_code") {
      return new ReloError("This code expired or was already used. Make a new one in Connect a computer.", { code: "INVALID_CODE", exitCode: EXIT.CLOSED });
    }
    if (code === "rate_limited" || error.status === 429) {
      return new ReloError("Too many attempts. Wait a minute, then run the command again.", { code: "JOIN_RATE_LIMITED", exitCode: EXIT.API });
    }
    // The redeem route needs no login: a 401 or 403 that is not Relo's own error is a gate in front of it.
    if ((error.status === 401 || error.status === 403) && code === "api_error") {
      return new ReloError(GATE(host), { code: "ACCESS_BLOCKED", exitCode: EXIT.NETWORK });
    }
    return error;
  }
  if (error instanceof NetworkError) {
    const cause = String(error.details?.reason ?? "");
    const text = `${error.message} ${cause}`;
    const why = /CERT|SSL|TLS|self.signed|unable.to.verify|LEAF_SIGNATURE/iu.test(text) ? `its TLS certificate was not accepted (${cause || error.message})`
      : /ENOTFOUND|EAI_AGAIN/u.test(text) ? "the name does not resolve (check the address and this computer's network)"
      : /ECONNREFUSED/u.test(text) ? "the connection was refused (is the server running?)"
      : /ETIMEDOUT|TimeoutError|timed out|aborted/iu.test(text) ? "it did not answer in time"
      : cause || error.message;
    return new ReloError(`Cannot reach ${host}: ${why}.`, { code: "SERVER_UNREACHABLE", exitCode: EXIT.NETWORK });
  }
  return error;
}

/** Agents here, split into set up (Relo's block is in) and found but not set up. */
function agentsHere(dependencies) {
  const { env, home, cwd, platform } = dependencies;
  let rows = [];
  try { rows = harnessesOf(dependencies, { env, home, cwd, platform }); } catch { rows = []; }
  const here = rows.filter((row) => row.id !== "agents" && row.detected);
  return { setUp: here.filter((row) => row.level !== "none").map((row) => row.id), notSetUp: here.filter((row) => row.level === "none").map((row) => row.id) };
}

/**
 * One notification, "Relo is connected", sealed for the trusted phones through the same path `relo notify` uses.
 * The key comes from the login's id, so running the join again with the same login sends nothing twice.
 * Returns "sent", "no-phone" (nobody to seal to) or "failed"; never throws.
 */
async function connectedNotice({ dependencies, computerName, loginId }) {
  try {
    const { config, client } = await getAuthenticated(dependencies);
    const notes = [];
    const trust = await trustFor({ client, config, dependencies, notes });
    if (!trust || sealablePhones(trust.store, config.apiUrl, trust.devices).eligible.length === 0) return "no-phone";
    const key = `relo-join:${String(loginId ?? config.principal?.id ?? "login").replace(/[^A-Za-z0-9._:-]/gu, "").slice(0, 100)}`;
    const body = {
      title: "Relo is connected", body: `${computerName} is connected to your Relo.`, sourceName: "Relo",
      context: { providerName: "Relo", project: "Relo setup", threadName: "Computers", providerThreadId: "relo-join:computers" },
    };
    const occurredAt = dependencies.commandOccurredAt ?? dependencies.now();
    const captured = await dependencies.prepareNotificationCommand({ config, key, body, kind: "notice", occurredAt },
      { root: dependencies.activityCaptureDirectory, environment: dependencies.env, home: dependencies.home });
    const outgoing = await sealNoticeRequest({ body: captured, key, client, config, dependencies, notes });
    await client.sendNotification(outgoing, key);
    return "sent";
  } catch {
    return "failed";
  }
}

/**
 * After a successful redeem and setup: the self-check (recorded like a doctor run), the first machine report (sent
 * now, whatever the throttle says), the connected notice and the summary. `outcome` is what setup returned.
 * Returns { lines, data } for the output. A failing check is listed, not thrown: the login and the setup are done.
 */
export async function joinSummary({ joined, apiUrl, dependencies, outcome }) {
  const check = await quietSelfCheck(dependencies)
    .catch((error) => ({ ok: false, failing: [{ name: "selfCheck", state: String(error?.code ?? "failed") }] }));
  const report = await Promise.resolve(dependencies.sendMachineReport?.({ force: true })).catch(() => ({ sent: false, reason: "failed" }));
  const notice = await connectedNotice({ dependencies, computerName: joined.clientName, loginId: joined.saved.data.credential?.id });
  const agents = agentsHere(dependencies);
  const level = joined.setup.level;
  const named = (ids) => ids.map(harnessLabel).join(", ");
  const lines = [
    ...(joined.left ? [`Switched from ${joined.left.name ? `${joined.left.name} on ` : ""}${joined.left.server}.`] : []),
    `Computer: ${joined.clientName}`,
    `Server: ${hostOf(apiUrl)}`,
    `Level: ${level}${joined.setup.approvals ? " (approvals from your phone)" : ""}`,
    `Agents set up: ${agents.setUp.length ? named(agents.setUp) : "none"}`,
    ...(agents.notSetUp.length ? [`Found, not set up: ${named(agents.notSetUp)}`,
      ...agents.notSetUp.map((id) => `  relo setup --agent ${id}`)] : []),
    check.ok ? "Self-check: passed" : "Self-check: failed",
    ...check.failing.map((row) => `  ${row.name}: ${row.state}`),
    ...(notice === "no-phone" ? ["Install the Relo iPhone app to get notifications."] : []),
    ...(report?.reason === "failed" ? ["The report to the server did not go through; it is sent again with the next command."] : []),
  ];
  const restart = Array.isArray(outcome?.data?.next) ? outcome.data.next.filter((step) => /^Restart /u.test(step)) : [];
  return {
    lines: [...lines, ...restart],
    data: {
      computer: joined.clientName, server: apiUrl, level, approvals: joined.setup.approvals,
      ...(joined.left ? { left: joined.left } : {}),
      agents: { setUp: agents.setUp, notSetUp: agents.notSetUp },
      selfCheck: check, notice, reported: report?.sent === true,
    },
  };
}
