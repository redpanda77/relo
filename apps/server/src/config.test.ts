import { describe, expect, test } from "vitest";
import { loadConfig, secureOrPrivateOrigin } from "./config.js";

describe("APP_URL", () => {
  test("a public origin must be HTTPS; plain HTTP is accepted only on a private or local address", () => {
    for (const url of ["https://relo.example.com", "http://127.0.0.1:8180", "http://localhost:8180", "http://relo.local",
      "http://192.168.1.20:8180", "http://10.0.0.5", "http://172.20.0.2", "http://[::1]:8180", "http://[fd00::1]"]) {
      expect(secureOrPrivateOrigin(url), url).toBe(true);
    }
    for (const url of ["http://relo.example.com", "http://8.8.8.8:8180", "http://172.32.0.1", "ftp://relo.example.com"]) {
      expect(secureOrPrivateOrigin(url), url).toBe(false);
    }
  });

  test("the server refuses to start with a public plain-HTTP origin", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgresql://x", APP_URL: "http://relo.example.com" })).toThrow(/https/);
    expect(loadConfig({ DATABASE_URL: "postgresql://x" }).APP_URL).toBe("http://127.0.0.1:8180");
  });
});

describe.each(["RELO_LANDING_FILM_URL", "RELO_ONBOARDING_FILM_URL"] as const)("%s", (key) => {
  test("is an https folder or nothing: it lands in the page's CSP, so quotes and other schemes are refused", () => {
    const base = { DATABASE_URL: "postgresql://x" };
    expect(loadConfig(base)[key]).toBeUndefined();
    expect(loadConfig({ ...base, [key]: "https://media.example.test/relo/film/v3" })[key]).toBe("https://media.example.test/relo/film/v3");
    for (const bad of ["http://media.example.test/film", "https://media.example.test/a'; script-src *", "javascript:alert(1)"]) {
      expect(() => loadConfig({ ...base, [key]: bad }), bad).toThrow();
    }
  });
});
