// Codex (CLI and IDE): CODEX_* variables in the agent's shell (CODEX_HOME is only config), CODEX_THREAD_ID
// the session id (per its maintainers). Skills: the shared ~/.agents/skills. MCP: developers.openai.com/codex/mcp;
// its default tool timeout (60 s) would cut a question short, so Relo's entry raises it.
export default Object.freeze({
  id: "codex",
  label: "Codex",
  aliases: [],
  detect: (env) => Object.keys(env).some((key) => /^CODEX_(?!HOME$)/u.test(key)),
  sessionVariable: "CODEX_THREAD_ID",
  config: { variable: "CODEX_HOME", home: ".codex" },
  instructions: { global: "AGENTS.md" },
  skills: "~/.agents/skills",
  // Older Codex releases read <CODEX_HOME>/skills: copies there are still found, so they can be removed.
  legacySkills: "skills",
  // Optimize's agents: ~/.codex/agents/<name>.toml, one custom agent per file (developers.openai.com/codex/subagents).
  agents: "agents",
  agentFormat: "toml",
  mcp: { format: "toml", key: "mcp_servers", launch: "shell", toolTimeout: true, global: "config.toml" },
  mcpClient: /^codex/iu,
});
