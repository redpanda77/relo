// Builds the public docs site (/docs) from docs/site/*.md and the facts that live in code: the CLI's
// command registry and options, its exit codes and harness catalog, and the HTTP API's OpenAPI document.
// The result is one module the server serves (src/web/docs/site.generated.ts); the server never renders
// Markdown at runtime. `pnpm --filter @relo/server docs:build` rewrites it; docs-site.test.ts fails when
// it is stale. Docs conventions: plan 08 (docs/internal/product/plan/08-docs-site.md).
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SITE = join(ROOT, "docs/site");
const EDIT_BASE = "https://github.com/redpanda77/relo/blob/main/";

/** Loads the code facts the generated pages and embeds render (the CLI is plain ESM, read in place). */
async function loadFacts() {
  const cli = (path) => import(new URL(`../../../packages/cli/src/${path}`, import.meta.url).href);
  const [{ COMMANDS, optionsOf }, { OPTIONS, optionUsage }, { EXIT_CODES }, { HARNESSES }, { ADAPTERS }, { ENVIRONMENT }, { VERSION }, { factText, FACTS, spokenDuration }, { SCOPES }] = await Promise.all([
    cli("registry.mjs"), cli("shared/options.mjs"), cli("shared/errors.mjs"), cli("harness/catalog.mjs"),
    cli("harness/adapters/index.mjs"), cli("shared/environment.mjs"), cli("version.mjs"),
    cli("shared/facts.mjs"), cli("shared/scopes.generated.mjs"),
  ]);
  const openapi = JSON.parse(readFileSync(join(ROOT, "docs/api/openapi.json"), "utf8"));
  return { COMMANDS, optionsOf, OPTIONS, optionUsage, EXIT_CODES, HARNESSES, ADAPTERS, ENVIRONMENT, VERSION, factText, FACTS, spokenDuration, SCOPES, openapi };
}

// ---------- Front matter ----------

/** `---` key: value lines `---`, then the body. Values are plain strings (no YAML). */
export function frontMatter(source, file) {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  if (!match) throw new Error(`${file}: missing front matter`);
  const data = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue;
    const pair = /^([a-z][a-z-]*):\s*(.*)$/u.exec(line);
    if (!pair) throw new Error(`${file}: bad front matter line "${line}"`);
    data[pair[1]] = pair[2].trim();
  }
  for (const key of ["title", "summary"]) if (!data[key]) throw new Error(`${file}: front matter needs ${key}`);
  return { data, body: source.slice(match[0].length) };
}

// ---------- Embeds: generated Markdown from code facts ----------

const escapeCell = (text) => String(text ?? "").replace(/\|/gu, "\\|").replace(/\n/gu, " ");
const code = (text) => `\`${String(text).replace(/`/gu, "'")}\``;

/** The CLI reference pages: which command groups each one shows. Every command is on exactly one page. */
export const CLI_PAGES = {
  work: ["work", "state"],
  questions: ["ask", "interaction", "listen"],
  notify: ["notify"],
  setup: ["setup", "uninstall", "update", "hooks", "config"],
  account: ["auth", "test", "doctor", "devices", "account", "services"],
  keys: ["keys"],
  admin: ["admin", "sessions", "activity"],
  machine: ["mcp", "hook", "help", "schema", "delivery", "evidence", "outbox"],
};

/** A usage line wrapped at about 88 characters, continuation lines indented, as relo help shows it. */
function usageLines(parts) {
  const lines = [];
  let line = "";
  for (const part of parts) {
    if (line && line.length + 1 + part.length > 88) { lines.push(line); line = `    ${part}`; }
    else line = line ? `${line} ${part}` : part;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

const typedName = (entry) => (entry.alias && entry.alias.length < entry.name.length ? entry.alias : entry.name);

function commandMarkdown(facts, entry) {
  const options = facts.optionsOf(entry);
  const usage = usageLines([`relo ${typedName(entry)}`, entry.positionals, ...options.map((name) => `[${facts.optionUsage(name, entry.types?.[name])}]`)].filter(Boolean));
  const variants = entry.variants ? Object.entries(entry.variants).filter(([, handler]) => handler?.load) : [];
  const who = (name) => {
    if (variants.length < 2) return "";
    const takers = variants.filter(([, handler]) => (handler.options ?? []).includes(name)).map(([surface]) => surface);
    if (takers.length === variants.length) return "";
    return takers.map((surface) => ({ agent: "agents", script: "scripts and apps", owner: "the owner" })[surface] ?? surface).join(", ");
  };
  const lines = [`### relo ${typedName(entry)}`, "", "```sh", usage, "```", "", entry.summary];
  if (entry.alias && typedName(entry) !== entry.name) lines.push("", `Also: ${code(`relo ${entry.name}`)}.`);
  if (entry.ownerOnly) lines.push("", `The owner's command: refused inside an agent session${entry.admin ? `; \`relo admin ${entry.name}\` runs it across sessions` : ""}.`);
  else if (entry.admin) lines.push("", `Across every session, as the owner: \`relo admin ${entry.name}\`.`);
  if (options.length) {
    const scoped = options.some((name) => who(name));
    lines.push("", scoped ? "| Option | For | What it does |" : "| Option | What it does |", scoped ? "| --- | --- | --- |" : "| --- | --- |");
    for (const name of options) {
      const description = ownWords(entry.describe?.[name] ?? facts.OPTIONS[name]?.description ?? "");
      const flag = code(facts.optionUsage(name, entry.types?.[name]));
      lines.push(scoped ? `| ${flag} | ${escapeCell(who(name) || "all")} | ${escapeCell(description)} |` : `| ${flag} | ${escapeCell(description)} |`);
    }
  }
  return lines.join("\n");
}

/** On a command's own entry, "work start|update: the steps" reads "The steps": the prefix names commands the reader already sees. */
function ownWords(description) {
  const stripped = description.replace(/^(?:[a-z][a-z-]*(?: [a-z][a-z|-]*)?)(?:(?:, | and )[a-z][a-z |-]*)*: /u, "");
  return stripped === description ? description : stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function cliGroupMarkdown(facts, page) {
  const groups = CLI_PAGES[page];
  if (!groups) throw new Error(`{{cli ${page}}}: unknown CLI page`);
  const entries = facts.COMMANDS.filter((entry) => groups.includes(entry.name.split(" ")[0]));
  return entries.map((entry) => commandMarkdown(facts, entry)).join("\n\n");
}

function harnessesMarkdown(facts) {
  const mark = (value) => (value ? "yes" : "—");
  const rows = facts.HARNESSES.filter((harness) => harness.instructions || harness.skills || harness.hooks || harness.mcp).map((harness) =>
    `| ${harness.label} | ${code(harness.id)} | ${mark(harness.instructions)} | ${mark(harness.skills)} | ${mark(harness.hooks && facts.ADAPTERS[harness.id])} | ${mark(harness.mcp)} |`);
  return ["| Harness | `--agent` | Instructions block | Skill | Hooks | MCP |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function exitCodesMarkdown(facts) {
  return ["| Code | Name | Meaning |", "| --- | --- | --- |", ...facts.EXIT_CODES.map(({ code: value, name, meaning }) => `| ${value} | ${code(name)} | ${escapeCell(meaning)} |`)].join("\n");
}

function environmentMarkdown(facts) {
  return ["| Variable | What it does |", "| --- | --- |", ...facts.ENVIRONMENT.map(({ name, purpose }) => `| ${code(name)} | ${escapeCell(purpose)} |`)].join("\n");
}

/** A JSON Schema's type in words: "string", "object", "string or object", "one of: a, b". */
function schemaType(schema) {
  if (!schema || typeof schema !== "object") return "any";
  if (schema.enum) return `one of: ${schema.enum.map((value) => JSON.stringify(value)).join(", ")}`;
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return [...new Set(variants.map(schemaType))].join(" or ");
  if (schema.type === "array") return `array of ${schemaType(schema.items)}`;
  if (Array.isArray(schema.type)) return schema.type.join(" or ");
  return schema.type ?? "object";
}

/** The child properties of a schema: an object's own, an array's item fields (`name[]`), or those of each variant. */
function childProperties(schema) {
  if (!schema || typeof schema !== "object") return [];
  const own = Object.entries(schema.properties ?? {}).map(([name, property]) => [name, property, new Set(schema.required ?? [])]);
  const items = schema.type === "array" ? childProperties(schema.items).map(([name, property, required]) => [`[].${name}`, property, required]) : [];
  const variants = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].flatMap(childProperties);
  return [...own, ...items, ...variants];
}

/** Table rows for a request body's fields; nested fields are dotted (`context.title`, `steps[].label`) and shown when described. */
function fieldRows(schema, prefix, depth) {
  const rows = [];
  const seen = new Set();
  for (const [key, property, required] of childProperties(schema)) {
    const name = key.startsWith("[].") ? `${prefix}${key}` : `${prefix}${prefix ? "." : ""}${key}`;
    const path = name.replace(/\[\]\./gu, "[].");
    if (seen.has(path)) continue;
    seen.add(path);
    const described = Boolean(property.description);
    if (depth === 0 || described) {
      const type = schemaType(property);
      rows.push(`| ${code(path)}${depth === 0 && required.has(key) ? " (required)" : ""} | ${escapeCell(Array.isArray(type) ? type.join(" or ") : type)} | ${escapeCell(property.description ?? "")} |`);
    }
    if (depth < 3) rows.push(...fieldRows(property, path, depth + 1));
  }
  return rows;
}

/** The HTTP API: every operation of the OpenAPI document whose path starts with one of `prefixes`. */
function apiMarkdown(facts, prefixes) {
  const methods = ["get", "post", "put", "patch", "delete"];
  const sections = [];
  for (const [path, item] of Object.entries(facts.openapi.paths ?? {})) {
    if (!prefixes.some((prefix) => path.startsWith(prefix))) continue;
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      const lines = [`#### ${method.toUpperCase()} ${path}`, "", operation.summary ?? ""];
      if (operation.description) lines.push("", operation.description);
      const schema = operation.requestBody?.content?.["application/json"]?.schema;
      const rows = fieldRows(schema, "", 0);
      if (rows.length) {
        lines.push("", "| Field | Type | |", "| --- | --- | --- |", ...rows);
      }
      sections.push(lines.join("\n"));
    }
  }
  if (!sections.length) throw new Error(`{{api ${prefixes.join(" ")}}}: no operations`);
  return sections.join("\n\n");
}

function commandEmbed(facts, name) {
  const entry = facts.COMMANDS.find((candidate) => candidate.name === name || candidate.alias === name);
  if (!entry) throw new Error(`{{command ${name}}}: no such command`);
  const options = facts.optionsOf(entry);
  return ["```sh", usageLines([`relo ${typedName(entry)}`, entry.positionals, ...options.map((option) => `[${facts.optionUsage(option, entry.types?.[option])}]`)].filter(Boolean)), "```"].join("\n");
}

/** `{{name args}}` on a line of its own becomes generated Markdown. */
const KIND_LABELS = { login: "CLI login", "ci-token": "CI token", device: "phone", harness: "hooks", service: "webhook service" };

/** The scope registry as a table; `{{scopes service}}` lists only the scopes that kind may hold. */
function scopesMarkdown(facts, kind) {
  const rows = Object.entries(facts.SCOPES).filter(([, scope]) => !kind || scope.kinds.includes(kind));
  if (!rows.length) throw new Error(`{{scopes ${kind}}}: no scope for that kind`);
  return ["| Scope | Allows | Held by |", "| --- | --- | --- |",
    ...rows.map(([name, scope]) => `| \`${name}\` | ${scope.means} | ${scope.kinds.map((item) => KIND_LABELS[item] ?? item).join(", ")} |`)].join("\n");
}

/** The answer-callback retry schedule as a table, from the facts. */
function callbackScheduleMarkdown(facts) {
  const spoken = (seconds) => facts.factText ? facts.spokenDuration(seconds) : String(seconds);
  const rows = ["| Attempt | After the previous one |", "| --- | --- |", "| 1 | at once |"];
  facts.FACTS.callback.retryDelaysSeconds.forEach((seconds, index) => rows.push(`| ${index + 2} | ${spoken(seconds)} |`));
  return rows.join("\n");
}

/** `{{fact id}}` (or `{{fact id short}}`) anywhere in prose: the number from the facts module, as it reads. */
function expandFacts(body, facts, file) {
  return body.split(/(^```[\s\S]*?^```$)/mu).map((part) => part.startsWith("```") ? part
    : part.replace(/\{\{fact ([a-zA-Z.]+)( short)?\}\}/gu, (_, id, short) => {
      try { return facts.factText(id, { short: Boolean(short) }); } catch { throw new Error(`${file}: unknown fact {{fact ${id}}}`); }
    })).join("");
}

function expandEmbeds(body, facts, file) {
  return expandFacts(body, facts, file).replace(/^\{\{([a-z-]+)(?: ([^}]+))?\}\}$/gmu, (_, name, args = "") => {
    switch (name) {
      case "cli": return cliGroupMarkdown(facts, args.trim());
      case "command": return commandEmbed(facts, args.trim());
      case "harnesses": return harnessesMarkdown(facts);
      case "exit-codes": return exitCodesMarkdown(facts);
      case "environment": return environmentMarkdown(facts);
      case "api": return apiMarkdown(facts, args.trim().split(/\s+/u));
      case "version": return facts.VERSION;
      case "scopes": return scopesMarkdown(facts, args.trim() || undefined);
      case "callback-schedule": return callbackScheduleMarkdown(facts);
      default: throw new Error(`${file}: unknown embed {{${name}}}`);
    }
  });
}

// ---------- Callouts ----------

const TONES = { note: "Note", tip: "Tip", warning: "Waits on you", privacy: "Privacy", never: "Never" };

/** `:::tone [Title]` … `:::` → an <aside> whose inside is Markdown (CommonMark HTML-block rules). */
function calloutsToHtml(body, file) {
  return body.replace(/^:::([a-z]+)(?: (.+))?\n([\s\S]*?)\n:::$/gmu, (_, tone, title, inner) => {
    if (!TONES[tone]) throw new Error(`${file}: unknown callout :::${tone}`);
    const label = escapeHtml(title ?? TONES[tone]);
    return `<aside class="docs-callout" data-tone="${tone}"><p class="docs-callout-title">${label}</p>\n\n${inner}\n\n</aside>`;
  });
}

/** The same callouts as Markdown blockquotes, for the .md routes. */
function calloutsToMarkdown(body) {
  return body.replace(/^:::([a-z]+)(?: (.+))?\n([\s\S]*?)\n:::$/gmu, (_, tone, title, inner) =>
    [`> **${title ?? TONES[tone]}.**`, ...inner.split("\n").map((line) => (line ? `> ${line}` : ">"))].join("\n"));
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

export function slugify(text) {
  return String(text).toLowerCase().replace(/<[^>]+>/gu, "").replace(/`/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "section";
}

// ---------- Markdown → HTML ----------

function renderer() {
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false });
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const info = token.info.trim();
    const language = info.split(/\s+/u)[0] || "text";
    const title = /title="([^"]+)"/u.exec(info)?.[1];
    if (language === "mermaid") return defaultFence(tokens, index, options, env, self);
    const lines = token.content.replace(/\n$/u, "").split("\n").map((line) => {
      const safe = escapeHtml(line);
      if (["sh", "bash", "shell"].includes(language) && /^\s*#/u.test(line)) return `<span class="docs-code-comment">${safe}</span>`;
      return safe;
    });
    const copy = ["sh", "bash", "shell"].includes(language) ? token.content.split("\n").filter((line) => line.trim() && !/^\s*#/u.test(line)).join("\n") : token.content.replace(/\n$/u, "");
    return `<figure class="docs-code" data-language="${escapeHtml(language)}">${title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ""}`
      + `<button class="docs-copy" type="button" data-copy="${escapeHtml(copy)}" hidden>Copy</button>`
      + `<pre><code>${lines.join("\n")}</code></pre></figure>\n`;
  };
  md.renderer.rules.table_open = () => '<div class="docs-table"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";
  const defaultLink = md.renderer.rules.link_open ?? ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const href = tokens[index].attrGet("href") ?? "";
    if (/^https?:\/\//u.test(href)) { tokens[index].attrSet("rel", "external noopener"); }
    env.links.push(href);
    return defaultLink(tokens, index, options, env, self);
  };
  return md;
}

/** Heading ids (unique per page), anchor links, the outline (h2, h3) and the search sections. */
function annotateHeadings(tokens, page) {
  const used = new Map();
  const outline = [];
  const sections = [{ id: null, title: page.title, text: [] }];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "heading_open") {
      const level = Number(token.tag.slice(1));
      const inline = tokens[index + 1];
      const text = inline.children.filter((child) => child.type === "text" || child.type === "code_inline").map((child) => child.content).join("");
      let id = slugify(text);
      const seen = used.get(id) ?? 0;
      used.set(id, seen + 1);
      if (seen) id = `${id}-${seen + 1}`;
      token.attrSet("id", id);
      if (level >= 2 && level <= 3) outline.push({ id, text, level });
      if (level >= 2) sections.push({ id, title: text, text: [] });
      inline.children.push(Object.assign(new inline.children[0].constructor("html_inline", "", 0), { content: ` <a class="docs-anchor" href="#${id}" aria-label="Link to ${escapeHtml(text)}">#</a>` }));
    } else if (token.type === "inline" && tokens[index - 1]?.type !== "heading_open") {
      sections.at(-1).text.push((token.children ?? []).filter((child) => child.type === "text" || child.type === "code_inline").map((child) => child.content).join(""));
    }
  }
  return { outline, sections };
}

// ---------- The site ----------

/** /docs → index.md; /docs/a/b → a/b.md, or a/b/index.md for a section's own page. */
function pathToFile(path, files) {
  if (!path.startsWith("/docs")) throw new Error(`nav: ${path} is not under /docs`);
  const rest = path.slice("/docs".length).replace(/^\//u, "");
  if (rest === "") return "index.md";
  return files.has(`${rest}/index.md`) ? `${rest}/index.md` : `${rest}.md`;
}

/** Reads nav.json: sections with pages or groups of pages, in reading order. */
function readNav() {
  const nav = JSON.parse(readFileSync(join(SITE, "nav.json"), "utf8"));
  const order = [];
  for (const section of nav) {
    if (section.path) order.push({ path: section.path, section: section.title });
    for (const path of section.pages ?? []) order.push({ path, section: section.title });
    for (const group of section.groups ?? []) for (const path of group.pages) order.push({ path, section: section.title, group: group.title });
  }
  return { nav, order };
}

function allMarkdownFiles(directory = SITE) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return allMarkdownFiles(path);
    // README.md is the authors' guide to this folder (GitHub shows it), not a page.
    return entry.name.endsWith(".md") && !(directory === SITE && entry.name === "README.md") ? [relative(SITE, path).replaceAll("\\", "/")] : [];
  });
}

const plainText = (text) => text.replace(/<[^>]+>/gu, " ").replace(/[`*_[\]()#>|]/gu, " ").replace(/\s+/gu, " ").trim();

export async function buildDocsSite() {
  const facts = await loadFacts();
  const { nav, order } = readNav();
  const files = new Set(allMarkdownFiles());
  const md = renderer();
  const pages = [];
  for (const [index, entry] of order.entries()) {
    const file = pathToFile(entry.path, files);
    if (!files.has(file)) throw new Error(`nav: ${entry.path} has no docs/site/${file}`);
    files.delete(file);
    const source = readFileSync(join(SITE, file), "utf8");
    const { data, body } = frontMatter(source, file);
    if (/DRAFT-STUB/u.test(body) && !process.env.DOCS_DRAFT) throw new Error(`docs/site/${file} is still a stub`);
    checkTypedFacts(body, file);
    const expanded = expandEmbeds(body, facts, file);
    const env = { links: [] };
    const tokens = md.parse(calloutsToHtml(expanded, file), env);
    const { outline, sections } = annotateHeadings(tokens, { title: data.title });
    const html = md.renderer.render(tokens, md.options, env);
    pages.push({
      path: entry.path, file: `docs/site/${file}`, title: data.title, nav: data.nav ?? data.title, summary: data.summary,
      section: entry.section, group: entry.group ?? null, html, outline, links: env.links,
      markdown: `# ${data.title}\n\n${data.summary}\n\n${calloutsToMarkdown(expanded).trim()}\n`,
      search: sections.map((section) => ({ anchor: section.id, title: section.title, text: plainText(section.text.join(" ")).slice(0, 280) })),
      prev: index > 0 ? order[index - 1].path : null, next: index < order.length - 1 ? order[index + 1].path : null,
    });
  }
  if (files.size) throw new Error(`docs/site has pages that are not in nav.json: ${[...files].join(", ")}`);
  checkCommands(pages, facts);
  const byPath = new Map(pages.map((page) => [page.path, page]));
  checkLinks(pages, byPath);
  const titled = (path) => ({ path, title: byPath.get(path).nav });
  return {
    version: 1,
    cli: facts.VERSION,
    sections: nav.map((section) => ({
      title: section.title,
      path: section.path ?? null,
      pages: (section.pages ?? []).map(titled),
      groups: (section.groups ?? []).map((group) => ({ title: group.title, pages: group.pages.map(titled) })),
    })),
    pages: pages.map(({ links: _links, prev, next, file, ...page }) => ({
      ...page,
      editUrl: `${EDIT_BASE}${file}`,
      prev: prev ? titled(prev) : null,
      next: next ? titled(next) : null,
      breadcrumbs: breadcrumbs(page, nav),
    })),
  };
}

function breadcrumbs(page, nav) {
  if (page.path === "/docs") return [];
  const section = nav.find((candidate) => candidate.title === page.section);
  const crumbs = [{ path: "/docs", title: "Docs" }];
  if (section && section.path !== page.path) crumbs.push({ path: section.path ?? null, title: section.title });
  if (page.group) crumbs.push({ path: null, title: page.group });
  return crumbs;
}

/**
 * Docs drift: every `relo …` command and `--flag` a page names (in code blocks and inline code) is a real
 * command or option, so a page can never teach something the CLI does not accept. npm's own flags and
 * text after `#` in shell code are not Relo's.
 */
const GLOBAL_FLAGS = new Set(["json", "full", "help", "version"]);
/**
 * Numbers the product promises are embedded, never typed (plan 10 C2.3): a phrase that names one of them followed
 * by a typed number is refused, with the embed to use. Code blocks are examples and are not checked.
 */
const TYPED_FACTS = [
  [/\b(?:dimmed|dims) after\s+\d/iu, "card.freshSeconds"],
  [/leaves? the Lock Screen after\s+\d/iu, "card.retireSeconds"],
  [/\bfinal card (?:stays|for) \d/iu, "card.doneSeconds"],
  [/\b(?:quiet|has not reported) for \d+ minutes/iu, "card.freshSeconds"],
  [/\bwaits? up to \d+ ?(?:s|seconds)\b/iu, "question.agentWaitSeconds"],
  [/answerable \(default \d/iu, "question.defaultSeconds"],
  [/\bPast \d+ hours the card ends/iu, "card.maxSeconds"],
  [/\bover about \d+ (?:hours|days)/iu, "callback.giveUpSeconds"],
  [/\b\d+ (?:writes )?a minute per (?:login|account)/iu, "requests.loginPerMinute"],
  [/\blease[^.\n]{0,40}\b\d+ to \d+ minutes/iu, "lease.minSeconds"],
  [/\bkept for \d+ hours by default|\(\d+ hours by default/iu, "retention.defaultHours"],
];

export function checkTypedFacts(body, file) {
  const prose = body.replace(/^```[\s\S]*?^```$/gmu, "");
  for (const [pattern, fact] of TYPED_FACTS) {
    const match = pattern.exec(prose);
    if (match) throw new Error(`docs/site/${file}: "${match[0]}…" types a product number; write {{fact ${fact}}} instead`);
  }
}

function checkCommands(pages, facts) {
  const names = new Set(facts.COMMANDS.flatMap((entry) => [entry.name, ...(entry.alias ? [entry.alias] : [])]));
  // relo admin also runs every cross-session view as the owner: relo admin sessions, relo admin activity end.
  for (const entry of facts.COMMANDS.filter((candidate) => candidate.admin)) names.add(`admin ${entry.name.split(" ")[0]}`);
  const words = new Set([...names].map((name) => name.split(" ")[0]));
  const problems = [];
  for (const page of pages) {
    // Shell lines are commands as typed; inline code may also name a family (`relo work`, `relo keys`).
    const snippets = [...page.markdown.matchAll(/```(?:sh|bash|shell)[^\n]*\n([\s\S]*?)```/gu)].flatMap((match) => match[1].split("\n").map((text) => ({ text, shell: true })))
      .concat([...page.markdown.replace(/```[\s\S]*?```/gu, "").matchAll(/`([^`\n]+)`/gu)].map((match) => ({ text: match[1], shell: false })));
    for (const { text: raw, shell } of snippets) {
      const line = raw.replace(/\s#.*$/u, "").replace(/^\s*#.*$/u, "");
      if (/^\s*npm |\bnpm (?:un)?install\b/u.test(line)) continue;
      for (const match of line.matchAll(/(?:^|[\s|;&(])relo ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/gu)) {
        const [, first, second] = match;
        if (!words.has(first)) { problems.push(`${page.path}: "relo ${first}" is not a command`); continue; }
        const group = [...names].some((name) => name.startsWith(`${first} `));
        const bare = names.has(first);
        if (group && !bare && second && !names.has(`${first} ${second}`)) problems.push(`${page.path}: "relo ${first} ${second}" is not a command`);
        if (group && !bare && !second && shell) problems.push(`${page.path}: "relo ${first}" needs a command (${[...names].filter((name) => name.startsWith(`${first} `)).join(", ")})`);
      }
      // Flags count on a line that runs relo, or in inline code that is a flag on its own (`--plan`).
      if (!/(?:^|[\s|;&(])relo /u.test(line) && !/^--[a-z]/u.test(line.trim())) continue;
      for (const match of line.matchAll(/(?<![\w-])--([a-z][a-z-]*)/gu)) {
        if (!facts.OPTIONS[match[1]] && !GLOBAL_FLAGS.has(match[1])) problems.push(`${page.path}: --${match[1]} is not a relo option`);
      }
    }
  }
  if (problems.length) throw new Error(`docs drift:\n${[...new Set(problems)].join("\n")}`);
}

/** Every /docs link and #anchor resolves; a link to another server path is allowed only when listed. */
const ALLOWED_PATHS = new Set(["/", "/sign-in", "/dashboard", "/dashboard/account", "/dashboard/connections", "/llms.txt", "/llms-full.txt", "/agents.md", "/docs.md", "/mac/relo-mac.dmg"]);
function checkLinks(pages, byPath) {
  const problems = [];
  for (const page of pages) {
    for (const href of page.links) {
      if (/^(https?:|mailto:)/u.test(href)) continue;
      const [path, anchor] = href.split("#");
      const target = path === "" ? page : byPath.get(path.replace(/\/$/u, "") || "/docs");
      if (path && !target && !ALLOWED_PATHS.has(path) && !/^\/docs\/.+\.md$/u.test(path)) { problems.push(`${page.path}: link to ${href} has no page`); continue; }
      if (anchor && target && !target.outline.some((item) => item.id === anchor) && !target.search.some((section) => section.anchor === anchor)) {
        problems.push(`${page.path}: link to ${href} has no such heading`);
      }
    }
  }
  if (problems.length) throw new Error(`docs links:\n${problems.join("\n")}`);
}

/** The generated module's source. */
export function siteModuleSource(site) {
  return `// Generated by apps/server/docs-build/build-docs.mjs from docs/site and the CLI. Do not edit.\n`
    + `// Rebuild: pnpm --filter @relo/server docs:build\n`
    + `import type { DocsSite } from "./types.js";\n\n`
    + `export const DOCS_SITE: DocsSite = ${JSON.stringify(site, null, 1)};\n`;
}
