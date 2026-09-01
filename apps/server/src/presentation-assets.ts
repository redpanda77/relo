import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "./db.js";

const ingestSchema = z.object({ url: z.url().max(2_048) }).strict();
const MAX_ASSET_BYTES = 5_000_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

const blockedAddresses = new BlockList();
for (const [network,prefix] of [
  ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],
  ["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],
  ["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],
  ["224.0.0.0",4],["240.0.0.0",4],
] as const) blockedAddresses.addSubnet(network,prefix,"ipv4");
for (const [network,prefix] of [
  ["::",128],["::1",128],["fc00::",7],["fe80::",10],["ff00::",8],["2001:db8::",32],
] as const) blockedAddresses.addSubnet(network,prefix,"ipv6");

export class PresentationAssetIngestError extends Error {
  constructor(readonly code:
    | "invalid_asset_url"
    | "asset_host_not_public"
    | "asset_redirect_invalid"
    | "asset_fetch_failed"
    | "asset_too_large"
    | "asset_media_type_unsupported"
    | "asset_dimensions_invalid") {
    super(code);
    this.name = "PresentationAssetIngestError";
  }
}

function safeAssetUrl(input: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(input,base) : new URL(input);
  } catch {
    throw new PresentationAssetIngestError("invalid_asset_url");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new PresentationAssetIngestError("invalid_asset_url");
  }
  url.hash = "";
  return url;
}

function publicAddress(address: string, family: number): boolean {
  if (family === 4) return !blockedAddresses.check(address,"ipv4");
  if (family === 6) {
    if (address.toLowerCase().startsWith("::ffff:")) return false;
    return !blockedAddresses.check(address,"ipv6");
  }
  return false;
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (isIP(hostname)) {
    const family = isIP(hostname) as 4 | 6;
    if (!publicAddress(hostname,family)) throw new PresentationAssetIngestError("asset_host_not_public");
    return { address: hostname,family };
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname,{ all: true,verbatim: true });
  } catch {
    throw new PresentationAssetIngestError("asset_fetch_failed");
  }
  if (!records.length || records.some((record) => !publicAddress(record.address,record.family))) {
    throw new PresentationAssetIngestError("asset_host_not_public");
  }
  const selected = records[0]!;
  return { address: selected.address,family: selected.family as 4 | 6 };
}

async function fetchAsset(url: URL, redirects = 0): Promise<Buffer> {
  const resolved = await resolvePublicAddress(url.hostname);
  return new Promise<Buffer>((resolve,reject) => {
    const fail = (code: ConstructorParameters<typeof PresentationAssetIngestError>[0]) =>
      reject(new PresentationAssetIngestError(code));
    const req = request(url,{
      method: "GET",
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg", "user-agent": "Relo-asset-ingest/1" },
      lookup: (_hostname,_options,callback) => callback(null,resolved.address,resolved.family),
      servername: url.hostname,
      timeout: REQUEST_TIMEOUT_MS,
    },(response) => {
      const status = response.statusCode ?? 0;
      if ([301,302,303,307,308].includes(status)) {
        response.resume();
        if (redirects >= MAX_REDIRECTS || !response.headers.location) return fail("asset_redirect_invalid");
        let next: URL;
        try {
          next = safeAssetUrl(response.headers.location,url);
        } catch {
          return fail("asset_redirect_invalid");
        }
        fetchAsset(next,redirects+1).then(resolve,reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        return fail("asset_fetch_failed");
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_BYTES) {
        response.destroy();
        return fail("asset_too_large");
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data",(chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_ASSET_BYTES) {
          response.destroy();
          fail("asset_too_large");
          return;
        }
        chunks.push(chunk);
      });
      response.on("end",() => resolve(Buffer.concat(chunks,total)));
      response.on("error",() => fail("asset_fetch_failed"));
    });
    req.on("timeout",() => req.destroy(new Error("asset timeout")));
    req.on("error",() => fail("asset_fetch_failed"));
    req.end();
  });
}

type ImageMetadata = {
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
};

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset+9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset+1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset+2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset+length > bytes.length) return null;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 7) return null;
      return { height: bytes.readUInt16BE(offset+3),width: bytes.readUInt16BE(offset+5) };
    }
    offset += length;
  }
  return null;
}

function sniffImage(bytes: Buffer): ImageMetadata {
  let metadata: ImageMetadata | null = null;
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    metadata = { mediaType: "image/png",width: bytes.readUInt32BE(16),height: bytes.readUInt32BE(20) };
  } else if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dimensions = jpegDimensions(bytes);
    if (dimensions) metadata = { mediaType: "image/jpeg",...dimensions };
  } else if (bytes.length >= 30 && bytes.toString("ascii",0,4) === "RIFF"
    && bytes.toString("ascii",8,12) === "WEBP") {
    const kind = bytes.toString("ascii",12,16);
    if (kind === "VP8X") {
      metadata = { mediaType: "image/webp",
        width: 1+bytes.readUIntLE(24,3),height: 1+bytes.readUIntLE(27,3) };
    } else if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      metadata = { mediaType: "image/webp",
        width: bytes.readUInt16LE(26)&0x3fff,height: bytes.readUInt16LE(28)&0x3fff };
    } else if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      metadata = { mediaType: "image/webp",width: (bits&0x3fff)+1,height: ((bits>>14)&0x3fff)+1 };
    }
  }
  if (!metadata) throw new PresentationAssetIngestError("asset_media_type_unsupported");
  if (metadata.width < 1 || metadata.height < 1 || metadata.width > 4_096 || metadata.height > 4_096) {
    throw new PresentationAssetIngestError("asset_dimensions_invalid");
  }
  return metadata;
}

function assetResource(row: any) {
  return {
    kind: "relo_asset" as const,
    assetId: row.asset_id,
    revision: Number(row.revision),
    sha256: row.sha256,
    mediaType: row.media_type,
    byteSize: Number(row.byte_size),
    pixelWidth: Number(row.pixel_width),
    pixelHeight: Number(row.pixel_height),
  };
}

export function registerPresentationRoutes(app: Hono, db: Database): void {
  app.post("/api/presentation-assets", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:write") || !auth.credentialId) {
      return context.json({ error: "forbidden" },403);
    }
    const input = ingestSchema.parse(await context.req.json());
    let bytes: Buffer;
    let metadata: ImageMetadata;
    try {
      bytes = await fetchAsset(safeAssetUrl(input.url));
      if (!bytes.length) throw new PresentationAssetIngestError("asset_media_type_unsupported");
      metadata = sniffImage(bytes);
    } catch (error) {
      if (!(error instanceof PresentationAssetIngestError)) throw error;
      const status = error.code === "asset_too_large" ? 413
        : error.code === "asset_fetch_failed" ? 502 : 400;
      return context.json({ error: error.code },status);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const id = `ast_${randomUUID().replaceAll("-","")}`;
    let result = await db.query<any>(
      `INSERT INTO presentation_assets(
         asset_id,principal_id,sha256,media_type,byte_size,pixel_width,pixel_height,content
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING RETURNING *`,
      [id,auth.principalId,digest,metadata.mediaType,bytes.length,metadata.width,metadata.height,bytes],
    );
    let replayed = false;
    if (!result.rowCount) {
      result = await db.query<any>(
        `SELECT * FROM presentation_assets
         WHERE principal_id=$1 AND sha256=$2 AND deleted_at IS NULL`,
        [auth.principalId,digest],
      );
      replayed = true;
    }
    if (!result.rowCount) throw new Error("presentation asset persistence failed");
    return context.json({
      asset: assetResource(result.rows[0]),
      delivery: { kind: "authenticated_asset_reference",path: `/api/presentation-assets/${result.rows[0].asset_id}` },
      replayed,
    },replayed ? 200 : 201);
  });

  app.get("/api/presentation-assets/:assetId", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:read") && !auth.scopes.has("inbox:read")) {
      return context.json({ error: "forbidden" },403);
    }
    const result = await db.query<any>(
      `SELECT * FROM presentation_assets
       WHERE principal_id=$1 AND asset_id=$2
         AND (deleted_at IS NULL OR retain_until>now())`,
      [auth.principalId,context.req.param("assetId")],
    );
    if (!result.rowCount) return context.json({ error: "not_found" },404);
    const row = result.rows[0]!;
    context.header("content-type",row.media_type);
    context.header("content-length",String(row.byte_size));
    context.header("etag",`"sha256-${row.sha256}"`);
    context.header("cache-control","private, max-age=31536000, immutable");
    context.header("x-content-type-options","nosniff");
    return context.body(row.content);
  });

  app.delete("/api/presentation-assets/:assetId", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:write") || !auth.credentialId) {
      return context.json({ error: "forbidden" },403);
    }
    const active = await db.query(
      `SELECT 1 FROM live_activities
       WHERE principal_id=$1 AND state='active'
         AND presentation#>>'{visual,asset,assetId}'=$2 LIMIT 1`,
      [auth.principalId,context.req.param("assetId")],
    );
    if (active.rowCount) return context.json({ error: "asset_in_use" },409);
    const deleted = await db.query(
      `UPDATE presentation_assets SET deleted_at=now()
       WHERE principal_id=$1 AND asset_id=$2 AND deleted_at IS NULL RETURNING asset_id`,
      [auth.principalId,context.req.param("assetId")],
    );
    return deleted.rowCount
      ? context.json({ deleted: true })
      : context.json({ error: "not_found" },404);
  });
}

export const presentationAssetInternals = {
  publicAddress,
  safeAssetUrl,
  sniffImage,
};
