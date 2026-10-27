// Claude desktop app: MCP only (modelcontextprotocol.io "Connect to local MCP servers"). A GUI app does not
// inherit the shell PATH, so its entry names node and the relo script.
import { join } from "node:path";

export default Object.freeze({
  id: "claude-desktop",
  label: "Claude",
  aliases: ["desktop"],
  config: {
    at: ({ env, home, platform }) => platform === "darwin" ? join(home, "Library", "Application Support", "Claude")
      : platform === "win32" && env.APPDATA?.trim() ? join(env.APPDATA.trim(), "Claude") : undefined,
  },
  installation: { apps: ["Claude.app"], folder: { ignore: ["claude_desktop_config.json"] } },
  mcp: { format: "json", key: "mcpServers", launch: "absolute", global: "claude_desktop_config.json" },
  mcpClient: /^claude/iu,
});
