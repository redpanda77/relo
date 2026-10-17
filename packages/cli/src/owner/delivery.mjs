// The owner's delivery tools: `relo delivery reconcile`, `relo evidence timeline|metrics`, `relo devices list`.
import { assertNoExtra, enumOption, numberOption, requireText } from "../shared/validate.mjs";
import { UsageError } from "../shared/errors.mjs";
import { result } from "../shared/outcome.mjs";
import { listAllDevices } from "../shared/devices.mjs";

/** `relo delivery reconcile`, `relo evidence timeline|metrics`, `relo devices list`. Returns undefined when the command is not one of them. */
export async function runDeliveryCommand(command) {
  const { options, group, action, rest, client } = command;
  if (group === "delivery" && action === "reconcile") {
    assertNoExtra(rest, 2, "Usage: relo delivery reconcile JOB_ID mark-accepted|retry|cancel");
    const deliveryId = requireText(rest[0], "Delivery job ID", 80);
    if (!/^job_[A-Za-z0-9-]{12,64}$/u.test(deliveryId)) {
      throw new UsageError("Delivery job ID must use the public job_ identifier.");
    }
    const reconciliationAction = enumOption(
      requireText(rest[1], "Reconciliation action", 32),
      "reconciliation action",
      ["mark-accepted", "retry", "cancel"],
    ).replace("-", "_");
    return result(
      "delivery.reconcile",
      await client.reconcileDelivery(deliveryId, reconciliationAction),
    );
  }

  if (group === "evidence" && action === "timeline") {
    assertNoExtra(rest, 0, "Usage: relo evidence timeline [--notification ID] [--limit 1..100] [--cursor CURSOR]");
    const notificationId = options.notification === undefined
      ? undefined
      : requireText(options.notification, "Notification ID", 80);
    if (notificationId !== undefined && !/^ntf_[A-Za-z0-9-]{12,64}$/u.test(notificationId)) {
      throw new UsageError("Notification ID must use the public ntf_ identifier.");
    }
    const limit = numberOption(options.limit, "limit", {
      minimum: 1,maximum: 100,integer: true,
    });
    const cursor = options.cursor === undefined
      ? undefined
      : requireText(options.cursor, "Evidence cursor", 2_000);
    return result(
      "evidence.timeline",
      await client.getEvidenceTimeline({ notificationId,limit,cursor }),
    );
  }

  if (group === "evidence" && action === "metrics") {
    assertNoExtra(rest, 0, "Usage: relo evidence metrics");
    return result("evidence.metrics",await client.getEvidenceMetrics());
  }

  if (group === "devices" && action === "list") {
    assertNoExtra(rest, 0, "Usage: relo devices list [--page-size 1..100]");
    const pageSize = numberOption(options["page-size"], "page-size", {
      minimum: 1,
      maximum: 100,
      integer: true,
    });
    return result("devices.list", await listAllDevices(client, pageSize));
  }
  return undefined;
}
