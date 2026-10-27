// Amp: ~/.config/amp/AGENTS.md (ampcode.com/docs/customize/agents-md); skills in ~/.config/agents/skills
// (the skills CLI's agent table). Not detected from the shell.
export default Object.freeze({
  id: "amp",
  label: "Amp",
  aliases: [],
  config: { home: ".config/amp" },
  installation: { binaries: ["amp"], markers: ["~/.local/share/amp"], folder: { ignore: ["AGENTS.md"] } },
  instructions: { global: "AGENTS.md" },
  skills: "~/.config/agents/skills",
});
