import { describe,expect,test } from "vitest";
import { Hono } from "hono";
import { presentationAssetInternals,registerPresentationRoutes } from "./presentation-assets.js";

describe("presentation immutable asset policy",() => {
  test("accepts only credential-free HTTPS on the standard port",() => {
    expect(presentationAssetInternals.safeAssetUrl("https://images.example.test/a.png").href)
      .toBe("https://images.example.test/a.png");
    for (const url of [
      "http://images.example.test/a.png",
      "https://user:secret@images.example.test/a.png",
      "https://images.example.test:8443/a.png",
    ]) expect(() => presentationAssetInternals.safeAssetUrl(url)).toThrowError("invalid_asset_url");
  });

  test("rejects private, loopback, documentation, multicast, and mapped addresses",() => {
    for (const address of ["10.0.0.1","127.0.0.1","169.254.1.1","192.168.1.1","203.0.113.5"]) {
      expect(presentationAssetInternals.publicAddress(address,4)).toBe(false);
    }
    for (const address of ["::1","fc00::1","fe80::1","2001:db8::1","::ffff:127.0.0.1"]) {
      expect(presentationAssetInternals.publicAddress(address,6)).toBe(false);
    }
    expect(presentationAssetInternals.publicAddress("8.8.8.8",4)).toBe(true);
    expect(presentationAssetInternals.publicAddress("2606:4700:4700::1111",6)).toBe(true);
  });

  test("sniffs PNG bytes and enforces pixel limits without trusting headers",() => {
    const png = Buffer.alloc(24);
    Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
    png.writeUInt32BE(640,16);
    png.writeUInt32BE(480,20);
    expect(presentationAssetInternals.sniffImage(png)).toEqual({
      mediaType: "image/png",width: 640,height: 480,
    });
    png.writeUInt32BE(4097,16);
    expect(() => presentationAssetInternals.sniffImage(png)).toThrowError("asset_dimensions_invalid");
    expect(() => presentationAssetInternals.sniffImage(Buffer.from("not an image")))
      .toThrowError("asset_media_type_unsupported");
  });

  test("ingest policy errors are bounded and do not echo the supplied URL",async () => {
    const app = new Hono();
    app.use("*",async (context,next) => {
      context.set("auth",{ principalId: "account-a",credentialId: "key-a",
        credentialKind: "principal",scopes: new Set(["activities:write"]) });
      await next();
    });
    registerPresentationRoutes(app,{ query: async () => ({ rows: [] }) } as any);
    const secretUrl = "http://user:secret@127.0.0.1/private.png";
    const response = await app.request("/api/presentation-assets",{
      method: "POST",headers: { "content-type": "application/json" },body: JSON.stringify({ url: secretUrl }),
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("invalid_asset_url");
    expect(body).not.toContain(secretUrl);
    expect(body).not.toContain("secret");
  });
});
