import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const APP_SERVER_TIMEOUT_MS = 1_500;

function childEnvironment(environment) {
  const allowed = ["HOME","USER","LOGNAME","PATH","LANG","LC_ALL","TMPDIR"];
  return Object.fromEntries(allowed.flatMap((key) => (
    environment[key] === undefined ? [] : [[key,environment[key]]]
  )));
}

function redact(value) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/gu," [code omitted] ")
    .replace(/https?:\/\/[^\s<>)]+/giu,"[link]")
    .replace(/\b(?:Bearer\s+)?(?:sk[-_]|[a-z][a-z0-9]{1,12}_)[A-Za-z0-9_-]{12,}\b/gu,"[credential redacted]")
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,"credential=[redacted]")
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*/gu,"[private key omitted]")
    .replace(/(^|\s)(?:\/(?:Users|home|private|var|tmp|etc|Volumes)\/[^\s,;]+)/gu,"$1[path]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B]/gu," ")
    .replace(/\s+/gu," ")
    .trim();
}

function bounded(value,maximum) {
  if (typeof value !== "string") return undefined;
  const normalized = Array.from(value.trim()).slice(0,maximum).join("");
  return normalized || undefined;
}

export function instructionTitle(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) return undefined;
  const normalized = redact(
    prompt
      .replace(/# Files mentioned by the user:[\s\S]*?(?=\n# |\nMy request|$)/giu," ")
      .replace(/<image\b[\s\S]*?<\/image>/giu," ")
      .replace(/```[\s\S]*?```/gu," ")
      .replace(/`[^`\r\n]+`/gu," "),
  )
    .replace(/\[(?:code omitted|private key omitted|credential redacted|link|path)\]/giu," ")
    .replace(/credential=\[redacted\]/giu," ")
    .replace(/^[\s#>*-]+/gu,"")
    .replace(/\s+/gu," ")
    .trim();
  if (!normalized) return undefined;
  const sentence = normalized.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? normalized;
  const characters = Array.from(sentence);
  return characters.length <= 160
    ? sentence
    : `${characters.slice(0,159).join("").trimEnd()}…`;
}

export function readCodexThread(threadId,{
  command = "codex",
  environment = process.env,
  spawnImpl = spawn,
  timeout = APP_SERVER_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader?.close();
      child?.kill();
      resolve(value);
    };
    let reader;
    const timer = setTimeout(() => finish(null),timeout);
    timer.unref?.();
    try {
      child = spawnImpl(command,["app-server"],{
        shell: false,windowsHide: true,stdio: ["pipe","pipe","ignore"],
        env: childEnvironment(environment),
      });
      child.once("error",() => finish(null));
      child.once("exit",() => finish(null));
      reader = createInterface({ input: child.stdout });
      reader.on("line",(line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message?.id !== 2) return;
        if (message.error) return finish(null);
        const thread = message.result?.thread;
        finish(thread && typeof thread === "object" ? thread : null);
      });
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      send({ id: 1,method: "initialize",params: {
        clientInfo: { name: "relo",title: "Relo",version: "0.7.17" },
        capabilities: { optOutNotificationMethods: [] },
      } });
      send({ method: "initialized",params: {} });
      send({ id: 2,method: "thread/read",params: { threadId,includeTurns: false } });
    } catch {
      finish(null);
    }
  });
}

export function codexIdentityContext(input) {
  const providerThreadId = bounded(input?.session_id,200);
  const providerWorkItemId = bounded(input?.turn_id,200);
  return {
    providerName: "Codex",
    producerKind: "agent",
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(providerWorkItemId ? { providerWorkItemId } : {}),
  };
}

export async function resolveCodexContext(input,dependencies = {}) {
  const identity = codexIdentityContext(input);
  const providerThreadId = identity.providerThreadId;
  const taskTitle = instructionTitle(input?.prompt);
  let thread;
  if (providerThreadId) {
    try {
      thread = await (dependencies.readThread ?? readCodexThread)(providerThreadId,dependencies);
    } catch {
      thread = null;
    }
  }
  const threadName = bounded(thread?.name,160);
  const resolvedThreadName = threadName ?? taskTitle ?? "Codex task";
  const resolvedTaskTitle = taskTitle ?? "Agent work";
  return {
    ...identity,
    threadName: resolvedThreadName,
    threadNameSource: threadName ? "provider" : "fallback",
    taskTitle: resolvedTaskTitle,
    taskTitleSource: taskTitle ? "prompt_summary" : "fallback",
  };
}
