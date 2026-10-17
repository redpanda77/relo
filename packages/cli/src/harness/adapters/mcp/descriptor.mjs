// Relo's own MCP server (`relo mcp`): one agent session per connection, keyed by RELO_MCP_SESSION, which only
// `relo mcp` sets. The connected client's own name (clientInfo) is the source shown on the card.
export default Object.freeze({
  id: "mcp",
  label: "MCP",
  aliases: [],
});
