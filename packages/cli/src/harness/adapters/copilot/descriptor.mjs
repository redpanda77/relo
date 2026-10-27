// GitHub Copilot CLI: COPILOT_HOME or ~/.copilot (docs.github.com "Add custom instructions"). Not detected
// from the shell: no marker is documented.
export default Object.freeze({
  id: "copilot",
  label: "GitHub Copilot",
  aliases: ["github-copilot", "copilot-cli"],
  config: { variable: "COPILOT_HOME", home: ".copilot" },
  installation: { binaries: ["copilot"], folder: { ignore: ["copilot-instructions.md", "skills"] } },
  instructions: { global: "copilot-instructions.md" },
  skills: "skills",
});
