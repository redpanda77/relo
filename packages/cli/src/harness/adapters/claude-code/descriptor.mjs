// Claude Code: what Relo knows about the harness (no I/O; harness/catalog.mjs resolves the paths).
// Sources: Claude Code docs (environment variables, settings, memory, skills, MCP). MCP (code.claude.com/docs/en/mcp):
// user scope is top-level `mcpServers` in ~/.claude.json. Relo writes only user-level MCP entries: a project's
// .mcp.json is committed and shared, and the entry works in every project anyway.
export default Object.freeze({
  id: "claude-code",
  label: "Claude Code",
  aliases: ["claude", "claude-code-cli"],
  detect: (env) => env.CLAUDECODE === "1" || Boolean(env.CLAUDE_CODE_ENTRYPOINT?.trim()),
  // Claude Code on the web runs in a throwaway cloud sandbox, not on the owner's computer: no computer sign-in there.
  ephemeral: { label: "Claude Code on the web", detect: (env) => env.CLAUDE_CODE_REMOTE === "true" },
  // The harness's own process, for the liveness check: a command line of the claude binary (the CLI and the desktop app's bundled one) or of node running the package.
  processPattern: /(?:^|\/)claude(?:\s|$)|@anthropic-ai\/claude-code/u,
  sessionVariable: "CLAUDE_CODE_SESSION_ID",
  config: { variable: "CLAUDE_CONFIG_DIR", home: ".claude" },
  instructions: { global: "CLAUDE.md" },
  skills: "skills",
  // Optimize's extras (plan 12 §4.6): named subagent definitions, and the status line setting in the hooks file.
  agents: "agents",
  statusLine: "settings.json",
  // Project hooks go in the personal, uncommitted settings.local.json: a teammate without relo gets no broken hook.
  hooks: { global: "settings.json", project: ".claude/settings.local.json" },
  mcp: { format: "json", key: "mcpServers", stdioType: true, launch: "shell", global: "~/.claude.json" },
  mcpClient: /^claude[-_ ]?code/iu,
});
