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
