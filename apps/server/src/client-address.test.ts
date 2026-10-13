import { afterEach, describe, expect, test } from "vitest";
import { clientAddress, isPrivatePeer, trustClientAddressHeader } from "./client-address.js";
import { authorizationRateLimitBuckets } from "./device-authorization.js";

function request(peer: string, headers: Record<string, string> = {}) {
  return {
    env: { incoming: { socket: { remoteAddress: peer, remotePort: 51_234, remoteFamily: peer.includes(":") ? "IPv6" : "IPv4" } } },
    req: { header: (name: string) => headers[name.toLowerCase()] },
  } as any;
}

describe("client address behind a reverse proxy", () => {
  afterEach(() => trustClientAddressHeader(undefined));

  test("uses the transport peer when no proxy header is configured", () => {
    expect(clientAddress(request("172.18.0.1", { "cf-connecting-ip": "198.51.100.7" }))).toBe("172.18.0.1");
  });

  test("believes the configured header only from a local proxy", () => {
    trustClientAddressHeader("CF-Connecting-IP");
    expect(clientAddress(request("172.18.0.1", { "cf-connecting-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientAddress(request("::ffff:127.0.0.1", { "cf-connecting-ip": "2001:db8::5" }))).toBe("2001:db8::5");
    expect(clientAddress(request("203.0.113.9", { "cf-connecting-ip": "198.51.100.7" }))).toBe("203.0.113.9");
  });

  test("ignores a missing or malformed header value", () => {
    trustClientAddressHeader("cf-connecting-ip");
    expect(clientAddress(request("127.0.0.1"))).toBe("127.0.0.1");
    expect(clientAddress(request("127.0.0.1", { "cf-connecting-ip": "not-an-ip" }))).toBe("127.0.0.1");
  });

  test("separates clients in the sign-in limits once the proxy is trusted", () => {
    trustClientAddressHeader("cf-connecting-ip");
    expect(authorizationRateLimitBuckets(request("172.18.0.1", { "cf-connecting-ip": "198.51.100.7" })))
      .toEqual(["global", "client:198.51.100.7"]);
  });

  test("classifies only loopback and private peers as local", () => {
    for (const local of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "::1", "fd7a::1", "::ffff:10.0.0.1"]) {
      expect(isPrivatePeer(local)).toBe(true);
    }
    for (const remote of ["8.8.8.8", "172.32.0.1", "100.100.1.1", "2001:db8::1", "::ffff:8.8.8.8"]) {
      expect(isPrivatePeer(remote)).toBe(false);
    }
  });
});
