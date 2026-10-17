// OpenCode: OPENCODE=1 and OPENCODE_SESSION_ID (the same id its plugins see as sessionID) in the agent's shell
// (captured from opencode 2.0.31). opencode.ai/docs/rules, /skills, /plugins. It has no command hooks: Relo's
// plugin (plugin.js, installed into plugins/) runs the `relo hook` commands that relo-hooks.json lists.
// It reads ~/.claude/skills and ~/.agents/skills beside its own skills folder, so setup gives it no second copy of the
// skill. Instructions: OpenCode 2 reads only its own AGENTS.md (it no longer falls back to ~/.claude/CLAUDE.md; checked
// on opencode 2.0.31), so the block goes there.
export default Object.freeze({
  id: "opencode",
  label: "OpenCode",
  aliases: [],
  detect: (env) => env.OPENCODE === "1",
  sessionVariable: "OPENCODE_SESSION_ID",
  config: { home: ".config/opencode" },
  instructions: { global: "AGENTS.md" },
  skills: "skills",
  inherits: Object.freeze({
    skills: Object.freeze(["~/.claude/skills", "~/.agents/skills"]),
    skillsOff: Object.freeze(["OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"]),
  }),
  // User-level only: a project's .opencode/ folder is shared with the team.
  hooks: { global: "relo-hooks.json" },
  mcpClient: /^opencode/iu,
  // The process its plugin runs `relo hook` from (`opencode`, `opencode serve`, or npm's `opencode.exe`): the liveness
  // check ends a session whose OpenCode process is gone (quit or killed: the plugin sends nothing then).
  processPattern: /(?:^|\/)opencode(?:\.exe)?(?:\s|$)/u,
});
