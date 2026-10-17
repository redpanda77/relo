// Cursor (agent CLI and IDE terminals): CURSOR_AGENT in the agent's shell (Cursor staff on the forum;
// undocumented); no session id. MCP: cursor.com/docs/context/mcp. A GUI app: the MCP entry names node.
export default Object.freeze({
  id: "cursor",
  label: "Cursor",
  aliases: [],
  detect: (env) => Boolean(env.CURSOR_AGENT?.trim()),
  config: { home: ".cursor" },
  skills: "skills",
  mcp: { format: "json", key: "mcpServers", stdioType: true, launch: "absolute", global: "mcp.json" },
  mcpClient: /^cursor/iu,
});
