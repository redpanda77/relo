export type EntityPrefix = "usr" | "acc" | "key" | "svc" | "dev" | "ntf" | "int" | "job" | "act" | "cnv" | "wrk" | "pair" | "ags" | "brw" | "cbk";

export function publicId(prefix: EntityPrefix, id: string): string {
  return `${prefix}_${id}`;
}

export function internalId(prefix: EntityPrefix, value: string): string | undefined {
  const marker = `${prefix}_`;
  if (!value.startsWith(marker)) return undefined;
  const id = value.slice(marker.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : undefined;
}
