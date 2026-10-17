// `--stdin` JSON input, bounded.
import { UsageError } from "./errors.mjs";

const MAX_STDIN_INPUT_BYTES = 1024 * 1024;

export async function readStdinJson(stream = process.stdin) {
  let input = "";
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_STDIN_INPUT_BYTES) throw new UsageError("stdin JSON is too large");
    input += chunk;
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new UsageError("stdin must contain valid JSON");
  }
}

export async function stdinObject(options, dependencies) {
  if (!options.stdin) return {};
  const value = await dependencies.readStdinJson();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("stdin JSON must be an object");
  }
  return value;
}

export function stdinDeviceIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new UsageError("stdin deviceIds must be an array");
  return value;
}
