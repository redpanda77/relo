import { readFileSync,writeFileSync } from "node:fs";
import { expect,test } from "vitest";
import { buildOpenApi } from "./openapi.js";

/** docs/api/openapi.json is generated: UPDATE_OPENAPI=1 npx vitest run src/openapi.test.ts rewrites it. */
const file = new URL("../../../docs/api/openapi.json",import.meta.url);
const version = (JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")) as { version: string }).version;

test("the published API description matches the schemas the server parses", () => {
  const generated = `${JSON.stringify(buildOpenApi(version),null,2)}\n`;
  if (process.env.UPDATE_OPENAPI === "1") writeFileSync(file,generated);
  expect(readFileSync(file,"utf8"),"docs/api/openapi.json is stale: UPDATE_OPENAPI=1 npx vitest run src/openapi.test.ts")
    .toBe(generated);
});

test("question bodies carry the limits integrators need", () => {
  const spec = buildOpenApi(version) as any;
  const ask = spec.paths["/api/interactions"].post.requestBody.content["application/json"].schema;
  expect(ask.properties.detail.maxLength).toBe(4000);
  expect(ask.properties.options.maxItems).toBe(4);
  expect(ask.properties.type.enum).not.toContain("text");
  expect(spec.paths["/api/interactions/answers"].get.parameters.map((p: any) => p.name)).toEqual(["after","since","timeoutSeconds"]);
});

test("every /api and /hooks route is either described or listed as private, and no route takes a secret in its path", async () => {
  const { listRoutes } = await import("./test-support/routes.js");
  const { INTERNAL_ROUTES } = await import("./openapi.js");
  const spec = buildOpenApi(version) as { paths: Record<string,Record<string,unknown>> };
  const described = new Set(Object.entries(spec.paths).flatMap(([path,methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)));
  const routes = listRoutes().map((route) => route.replace(/:(\w+)/gu,"{$1}"));
  const internal = (route: string) => {
    const [method,path] = route.split(" ") as [string,string];
    return INTERNAL_ROUTES.some(({ match }) => match.endsWith(")") ? match === `${path} (${method})` : path.startsWith(match));
  };
  expect(routes.filter((route) => !described.has(route) && !internal(route)),"describe it in openapi.ts or list it in INTERNAL_ROUTES").toEqual([]);
  expect([...described].filter((route) => !routes.includes(route)),"described but not registered").toEqual([]);
  expect(routes.filter((route) => /\{secret\}/u.test(route))).toEqual([]);
});

test("webhook routes name their secret scheme, and signing in needs no credential", () => {
  const spec = buildOpenApi(version) as any;
  expect(spec.paths["/hooks"].post.security).toEqual([{ webhookSecret: [] }]);
  expect(spec.paths["/hooks/works/{workId}"].patch.security).toEqual([{ webhookSecret: [] }]);
  expect(spec.paths["/api/device-authorizations/start"].post.security).toEqual([]);
  expect(spec.components.securitySchemes.webhookSecret.description).toContain("Never in the URL");
});

/**
 * `METHOD /path field` for every top-level request field without a description. Nested shapes (a card's full
 * presentation, a sealed envelope) are built by the CLI or the phone and are described once, as a whole, by their
 * top-level field.
 */
export function undescribedRequestFields(spec: any): string[] {
  const found: string[] = [];
  const fields = (schema: any): Array<[string,any]> => !schema || typeof schema !== "object" ? []
    : [...Object.entries<any>(schema.properties ?? {}),...["anyOf","oneOf","allOf"].flatMap((key) => (schema[key] ?? []).flatMap(fields))];
  for (const [path,methods] of Object.entries<any>(spec.paths)) {
    for (const [method,operation] of Object.entries<any>(methods)) {
      for (const [name,property] of fields(operation.requestBody?.content?.["application/json"]?.schema)) {
        if (!property.description) found.push(`${method.toUpperCase()} ${path} ${name}`);
      }
    }
  }
  return [...new Set(found)].sort();
}

test("every top-level request field says what it means", () => {
  expect(undescribedRequestFields(buildOpenApi(version)),"add .describe(\"…\") where the schema lives").toEqual([]);
});
