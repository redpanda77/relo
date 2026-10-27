// Generated from packages/contracts/src/facts.ts by packages/contracts/scripts/generated.ts. Do not edit:
// change the source, then run `pnpm --filter @relo/notification-contracts generate`.
function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") deepFreeze(child);
  return Object.freeze(value);
}

export const FACTS = deepFreeze({
  "requests": {
    "accountPerMinute": 300,
    "loginPerMinute": 60,
    "devicePerMinute": 120,
    "servicePerMinute": 60,
    "workPerMinute": 120,
    "accountWorkPerMinute": 600,
    "upkeepPerMinute": 120,
    "accountUpkeepPerMinute": 600,
    "snapshotsPerMinute": 120,
    "accountSnapshotsPerMinute": 600
  },
  "question": {
    "defaultSeconds": 300,
    "ceilingSeconds": 2592000,
    "serverCapSeconds": 604800,
    "agentWaitSeconds": 100
  },
  "card": {
    "maxSeconds": 28800,
    "freshSeconds": 1200,
    "retireSeconds": 3600,
    "doneSeconds": 900,
    "failedSeconds": 3600
  },
  "work": {
    "goalMax": 120,
    "statusMax": 120,
    "outcomeMax": 200,
    "stepLabelMax": 80,
    "waitingMax": 60,
    "planMaxSteps": 30,
    "planMaxNodes": 120,
    "planMaxDepth": 3,
    "planRoundsWithSteps": 3,
    "detailMax": 200
  },
  "lease": {
    "minSeconds": 60,
    "maxSeconds": 3600,
    "defaultSeconds": 900
  },
  "callback": {
    "retryDelaysSeconds": [
      30,
      120,
      600,
      3600,
      10800,
      21600,
      43200,
      86400,
      86400
    ],
    "giveUpSeconds": 259200,
    "redeliveriesPerDay": 10
  },
  "outbox": {
    "deadDays": 7
  },
  "credentials": {
    "unusedDays": 30,
    "ciTokenDefaultDays": 30,
    "ciTokenMaxDays": 90,
    "ciTokenMaxActive": 20
  },
  "computers": {
    "reportMaxBytes": 32768
  },
  "retention": {
    "defaultHours": 10
  }
});

export const FACT_UNITS = deepFreeze({
  "requests.accountPerMinute": "per-minute",
  "requests.loginPerMinute": "per-minute",
  "requests.devicePerMinute": "per-minute",
  "requests.servicePerMinute": "per-minute",
  "requests.workPerMinute": "per-minute",
  "requests.accountWorkPerMinute": "per-minute",
  "requests.upkeepPerMinute": "per-minute",
  "requests.accountUpkeepPerMinute": "per-minute",
  "requests.snapshotsPerMinute": "per-minute",
  "requests.accountSnapshotsPerMinute": "per-minute",
  "question.defaultSeconds": "seconds",
  "question.ceilingSeconds": "seconds",
  "question.serverCapSeconds": "seconds",
  "question.agentWaitSeconds": "seconds",
  "card.maxSeconds": "seconds",
  "card.freshSeconds": "seconds",
  "card.retireSeconds": "seconds",
  "card.doneSeconds": "seconds",
  "card.failedSeconds": "seconds",
  "work.goalMax": "characters",
  "work.statusMax": "characters",
  "work.outcomeMax": "characters",
  "work.stepLabelMax": "characters",
  "work.waitingMax": "characters",
  "work.planMaxSteps": "count",
  "work.planMaxNodes": "count",
  "work.planMaxDepth": "count",
  "work.planRoundsWithSteps": "count",
  "work.detailMax": "characters",
  "lease.minSeconds": "seconds",
  "lease.maxSeconds": "seconds",
  "lease.defaultSeconds": "seconds",
  "callback.retryDelaysSeconds": "seconds-list",
  "callback.giveUpSeconds": "seconds",
  "callback.redeliveriesPerDay": "count",
  "outbox.deadDays": "days",
  "credentials.unusedDays": "days",
  "credentials.ciTokenDefaultDays": "days",
  "credentials.ciTokenMaxDays": "days",
  "credentials.ciTokenMaxActive": "count",
  "computers.reportMaxBytes": "bytes",
  "retention.defaultHours": "hours"
});
