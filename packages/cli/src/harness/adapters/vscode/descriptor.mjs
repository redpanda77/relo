// VS Code (Copilot agent mode): MCP lives in a project's .vscode/mcp.json, top-level `servers`
// (code.visualstudio.com/docs/copilot/customization/mcp-servers); the user-level file has no documented path.
// Relo writes only user-level entries, so VS Code is listed for detection and help but gets none.
export default Object.freeze({
  id: "vscode",
  label: "VS Code",
  aliases: ["vs-code", "code"],

  mcpClient: /^(vscode|visual studio code|vs ?code)/iu,
});
