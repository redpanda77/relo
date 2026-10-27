// Google Antigravity (the agent app and IDE, 2.x): ANTIGRAVITY_AGENT=1 and ANTIGRAVITY_CONVERSATION_ID (the conversation,
// one session) in the shell its agent runs commands in (read from its language_server, 2.26). Its config folder is
// ~/.gemini/config; MCP servers: mcp_config.json there, `mcpServers` like Gemini CLI, started with that folder as
// their working directory. It reads ~/.gemini/GEMINI.md, which Gemini CLI's block already covers. A GUI app: the
// MCP entry names node. Its MCP clientInfo name is "antigravity".
export default Object.freeze({
  id: "antigravity",
  label: "Antigravity",
  aliases: ["google-antigravity", "agy"],
  detect: (env) => env.ANTIGRAVITY_AGENT === "1" || Boolean(env.ANTIGRAVITY_CONVERSATION_ID?.trim()),
  sessionVariable: "ANTIGRAVITY_CONVERSATION_ID",
  config: { home: ".gemini/config" },
  // Its config folder is Relo's own write target (~/.gemini/config): only the app's own folder, app or binary prove it is installed.
  installation: { binaries: ["agy", "antigravity"], apps: ["Antigravity.app"], markers: ["~/.gemini/antigravity", "~/.antigravity"] },
  // Hooks: named hooks in hooks.json there, user-level only (a workspace's .agents/hooks.json is shared).
  hooks: { global: "hooks.json" },
  mcp: { format: "json", key: "mcpServers", launch: "absolute", global: "mcp_config.json" },
  mcpClient: /^(google )?antigravity/iu,
});
