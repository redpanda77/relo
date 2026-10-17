// The script and app surface on the CLI beyond relo work: relo listen.

const LISTEN = { load: () => import("./listen.mjs"), run: "runListenCommand" };

// relo run: a script's command as a work. Agents are refused in their own words (script/run.mjs), not "unknown".
const RUN = { load: () => import("./run.mjs"), options: [] };
const RUN_DESCRIBE = { goal: "What the run is for, in the owner's words (default: Run and the command's name; never its arguments or environment).", plan: "Optional steps to show, comma separated; the work finishes them all when the command ends.", producer: "The producer key for this run (or RELO_SESSION=KEY); default is one of its own.", lease: "How long the run may be silent and still count as moving (1m to 60m, default 15m); Relo renews it while the command runs." };

export const SCRIPT_COMMANDS = [
  { name: "run", positionals: "-- COMMAND [ARGS...]", describe: RUN_DESCRIBE, summary: "Run a command as a work on the owner's phone and finish it from how it ends: exit 0 is done (\"Done in 4m 2s\"), any other exit or a signal is failed (the owner gets an alert), Ctrl-C is dropped. The command's output, input and signals pass through untouched and relo exits with the command's own exit code. Not signed in or offline: the command still runs, and the result is queued. Put -- before the command.",
    options: ["goal", "plan", "producer", "lease"],
    variants: { agent: { ...RUN, run: "refuseAgentRun", options: [] }, script: { ...RUN, run: "runScriptRun", options: ["goal", "plan", "producer", "lease"] } } },
  { name: "listen", describe: { "timeout": "Stop after this long (otherwise it listens until stopped)." },  ownerOnly: true, summary: "Stream every answer to the questions this login asked, one JSON line each ({id,eventId,state,action,option?,label?,correlationId?,respondedAt,cursor}), over one long-lived connection the app opens. Ends with {cursor,received}. Resume after a restart with --since CURSOR.", options: ["since", "once", "timeout"], ...LISTEN, auth: "client" },
];
