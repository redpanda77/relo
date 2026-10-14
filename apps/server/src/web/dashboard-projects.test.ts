import { Hono } from "hono";
import { describe,expect,test,vi } from "vitest";
import { createDashboardProjectHandlers,type ProjectsDashboardBootstrap } from "./dashboard-projects.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-13T12:00:00.000Z";

function rows(values: Record<string,unknown>[]) {
  return { rows:values,rowCount:values.length };
}

function fixture(authenticated = true) {
  const query = vi.fn(async (sql:string,params:unknown[] = []) => {
    if (params.length) expect(params[0]).toBe(principalId);
    if (sql.includes("SELECT project.*")) return rows([{
      id:projectId,project_key:"named:relo",display_name:"Relo",display_name_source:"owner",
      is_direct:false,provenance:"explicit",effective_palette_ordinal:14,icon:"folder",revision:3,
      deleted_at:null,first_seen_at:now,last_seen_at:now,conversation_count:1,notification_count:7,activity_count:2,
    }]);
    if (sql.includes("count(*) FILTER")) return rows([{ active:1,direct:0,archived:0,conversations:1,pending:0,notifications:7,deliveries:7 }]);
    if (sql.includes("FROM resource_project_aliases")) return rows([{ id:"44444444-4444-4444-8444-444444444444",display_name:"Relo notifications",provenance:"owner",created_at:now }]);
    if (sql.includes("FROM activity_conversations WHERE")) return rows([{ id:conversationId,display_name:"D03",producer_kind:"agent",project_assignment_source:"owner",last_seen_at:now }]);
    if (sql.includes("UNION ALL")) return rows([{ id:"55555555-5555-4555-8555-555555555555",kind:"notification",title:"Lifecycle ready",state:"recorded",occurred_at:now }]);
    return rows([]);
  });
  const handlers = createDashboardProjectHandlers({
    db:{ query } as any,
    releaseIdentity:"0.7.13-test",
    getAccount:async () => authenticated ? {
      principalId,accountId:`acc_${principalId}`,user:{ name:"Relo Owner",email:"owner@example.test" },
    } : null,
    authorizeMutation:async () => new Response(JSON.stringify({ error:"forbidden" }),{ status:403,headers:{ "content-type":"application/json" } }),
    renderDocument:async (bootstrap) => JSON.stringify(bootstrap),
  });
  const app = new Hono();
  app.get("/dashboard/projects",handlers.index);
  app.get("/dashboard/projects/:projectId",handlers.detail);
  app.patch("/api/dashboard/resources/projects/:projectId",handlers.update);
  return { app,query };
}

describe("dashboard Projects handlers",() => {
  test("redirects anonymous readers to sign in",async () => {
    const response = await fixture(false).app.request("/dashboard/projects");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in?next=%2Fdashboard%2Fprojects");
  });

  test("renders account-scoped Project Atlas list and detail bootstrap",async () => {
    const { app } = fixture();
    const response = await app.request(`/dashboard/projects/prj_${projectId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const bootstrap = await response.json() as ProjectsDashboardBootstrap;
    expect(bootstrap).toMatchObject({
      kind:"projects",
      shell:{ active:"projects",releaseIdentity:"0.7.13-test" },
      summary:{ active:1,direct:0,archived:0,conversations:1 },
      selected:{ project:{ id:`prj_${projectId}`,name:"Relo",palette:{ slot:2,generation:1 },revision:3 } },
    });
    expect(bootstrap.selected?.aliases[0]?.name).toBe("Relo notifications");
    expect(bootstrap.selected?.conversations[0]).toMatchObject({ id:`cnv_${conversationId}`,assignmentSource:"owner" });
    expect(JSON.stringify(bootstrap)).not.toMatch(/token|secret|payload/i);
  });

  test("fails closed before parsing a cross-origin mutation",async () => {
    const response = await fixture().app.request(`/api/dashboard/resources/projects/prj_${projectId}`,{
      method:"PATCH",headers:{ "content-type":"application/json" },body:JSON.stringify({ expectedRevision:3,displayName:"Changed" }),
    });
    expect(response.status).toBe(403);
  });
});
