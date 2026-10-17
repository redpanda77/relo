// Machine-readable command reference for agents: `relo schema --json`.
// test/schema.test.mjs pins every command's option list to what the CLI actually accepts.

import { PUBLIC_ENVIRONMENT } from "./shared/environment.mjs";
import { COMMANDS, optionsOf } from "./registry.mjs";
import { definedFields } from "./shared/validate.mjs";
import { OPTIONS, SESSION_IDS, flag } from "./shared/options.mjs";

export function commandSchema({ version, exitCodes, only }) {
  // Only what a command means: its handler fields (load, run, auth, variants) are the dispatcher's.
  const commands = (only ?? COMMANDS).map((entry) => definedFields({
    name: entry.name, alias: entry.alias, summary: entry.summary, positionals: entry.positionals, identity: entry.identity, internal: entry.internal,
    options: Object.fromEntries(optionsOf(entry).map((option) => [option, OPTIONS[option]])),
  }));
  if (only) return { schemaVersion: 1, cli: "relo", version, commands, exitCodes };
  return {
    schemaVersion: 1,
    cli: "relo",
    version,
    model: "One open work per session (relo work start, update, finish): a goal, then an optional plan of sequential milestone steps "
      + "(--plan, --next-step, --add) or a count (--progress DONE/TOTAL); parallel work is one step with a count. The session is identified "
      + "by the harness (" + SESSION_IDS + "); scripts and apps name a producer key (--producer KEY or RELO_SESSION=KEY). Questions (relo ask) "
      + "go on the open work's card; notifications (relo notify) are rare one-shot outcomes, never questions; the finish outcome is the notification.",
    output: "Card, question and notification commands print one compact JSON line, e.g. "
      + "{ok:true,id,state,sequence,step?,progress?,disposition?,note?}; --full prints the whole {ok,command,data} envelope. "
      + "Display text that is too long is shortened (title, status, detail, progress label, notify title/summary) and the line "
      + "says so in note; questions, topics, IDs, URLs and button labels are never shortened. "
      + "Errors print once: {ok:false,error:{code,message,hint?}} (a typo gets 'Did you mean …?') on stdout when it is not a terminal or --json is passed, "
      + "otherwise plain text on stderr. Exit codes are unchanged.",
    identity: {
      required: ["source", "project", "topic"],
      appliesTo: COMMANDS.filter((command) => command.identity).map((command) => command.name),
      resolution: ["flags", "--stdin JSON or --origin-file", "RELO_SOURCE / RELO_PROJECT / RELO_TOPIC",
        "the calling agent (source) and git repository (project)"],
    },
    environment: PUBLIC_ENVIRONMENT,
    exitCodes,
    globalOptions: { json: flag("Force JSON output and JSON errors (automatic when piped)."),
      full: flag("Print the whole server envelope instead of the compact line."), help: flag("Show help.") },
    commands,
  };
}
