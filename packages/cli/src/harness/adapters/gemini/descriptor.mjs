// Gemini CLI: GEMINI_CLI=1 for every shell command the agent runs (google-gemini/gemini-cli,
// shellExecutionService.ts); no session id in the shell (hooks get one on stdin). geminicli.com/docs.
export default Object.freeze({
  id: "gemini",
  label: "Gemini CLI",
  aliases: ["gemini-cli"],
  detect: (env) => env.GEMINI_CLI === "1",
  config: { home: ".gemini" },
  // ~/.gemini is shared with Antigravity: the folder alone proves nothing, only files Gemini CLI itself keeps do.
  installation: { binaries: ["gemini"], markers: ["oauth_creds.json", "installation_id", "google_accounts.json", "tmp"] },
  instructions: { global: "GEMINI.md" },
  skills: "skills",
  // Gemini CLI has no personal project settings file (its .gemini/settings.json is shared), so hooks are user-level only.
  hooks: { global: "settings.json" },
  mcp: { format: "json", key: "mcpServers", launch: "shell", global: "settings.json" },
  mcpClient: /^gemini/iu,
});
