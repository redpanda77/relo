import type { Handler } from "hono";
import { z } from "zod";
import type { Database } from "../db.js";
import {
  ProjectLifecycleError,
  addProjectAlias,
  archiveProjectResource,
  mergeProjectResource,
  projectAliasInputSchema,
  projectAppearanceInputSchema,
  projectMergeInputSchema,
  projectRevisionInputSchema,
  projectSplitInputSchema,
  removeProjectAlias,
  restoreProjectResource,
  splitProjectConversations,
  updateProjectResource,
} from "../project-resource-lifecycle.js";

const projectPublicIdSchema = z.string().regex(/^prj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export type DashboardProject = {
  id: string;
  key: string;
  name: string;
  displayNameSource: "producer" | "owner" | "derived";
  isDirect: boolean;
  provenance: string;
  palette: { slot: number; generation: number };
  icon: string;
  revision: number;
  archivedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  counts: { conversations: number; notifications: number; activities: number };
};

export type ProjectsDashboardBootstrap = {
  version: 1;
  kind: "projects";
  route: { path: string; selectedProjectId: string | null };
  shell: {
    title: "Projects";
    description: string;
    active: "projects";
    releaseIdentity: string;
    account: { id: string; initial: string; name: string; email: string };
    counts: { pending: number; notifications: number; deliveries: number };
  };
  summary: { active: number; direct: number; archived: number; conversations: number };
  projects: DashboardProject[];
  selected: null | {
    project: DashboardProject;
    aliases: Array<{ id: string; name: string; provenance: string; createdAt: string }>;
    conversations: Array<{
      id: string;
      name: string;
      producerKind: string;
      assignmentSource: "producer" | "owner";
      lastSeenAt: string;
    }>;
    recent: Array<{
      id: string;
      kind: "notification" | "activity";
      title: string;
      state: string;
      occurredAt: string;
    }>;
  };
};

type DashboardProjectAccount = {
  principalId: string;
  accountId: string;
  user: { name: string; email: string };
};

type Dependencies = {
  db: Database;
  releaseIdentity: string;
  getAccount(headers: Headers): Promise<DashboardProjectAccount | null>;
  authorizeMutation(context: any): Promise<DashboardProjectAccount | Response>;
  renderDocument(bootstrap: ProjectsDashboardBootstrap): Promise<string>;
};

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function publicResourceId(prefix: "prj" | "cnv" | "als",id: unknown): string {
  return `${prefix}_${String(id)}`;
}

function projectFromRow(row: Record<string,any>): DashboardProject {
  const ordinal = Number(row.effective_palette_ordinal);
  return {
    id: publicResourceId("prj",row.id),
    key: String(row.project_key),
    name: String(row.display_name),
    displayNameSource: row.display_name_source,
    isDirect: Boolean(row.is_direct),
    provenance: String(row.provenance),
    palette: { slot: ordinal%12,generation: Math.floor(ordinal/12) },
    icon: String(row.icon),
    revision: Number(row.revision),
    archivedAt: row.deleted_at ? iso(row.deleted_at) : null,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    counts: {
      conversations: number(row.conversation_count),
      notifications: number(row.notification_count),
      activities: number(row.activity_count),
    },
  };
}

function secureHtml(context: any,html: string): Response {
  context.header("content-security-policy","default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  context.header("cache-control","private, no-store");
  context.header("x-content-type-options","nosniff");
  return context.html(html);
}

function mutationError(context: any,error: unknown): Response {
  if (error instanceof ProjectLifecycleError) {
    return context.json({ error:error.code,message:error.message },error.status);
  }
  throw error;
}

export function createDashboardProjectHandlers(dependencies: Dependencies): {
  index: Handler;
  detail: Handler;
  update: Handler;
  addAlias: Handler;
  removeAlias: Handler;
  merge: Handler;
  split: Handler;
  archive: Handler;
  restore: Handler;
} {
  const { db,getAccount,authorizeMutation,releaseIdentity,renderDocument } = dependencies;

  async function render(context: any,selectedProjectId: string | null): Promise<Response> {
    const account = await getAccount(context.req.raw.headers);
    if (!account) return context.redirect(`/?next=${encodeURIComponent(context.req.path)}`);
    const selectedInternalId = selectedProjectId?.slice(4) ?? null;
    const [projectsResult,summaryResult] = await Promise.all([
      db.query<any>(
        `SELECT project.*,project.palette_ordinal effective_palette_ordinal,
          (SELECT count(*)::int FROM activity_conversations conversation WHERE conversation.principal_id=$1 AND conversation.project_resource_id=project.id) conversation_count,
          (SELECT count(*)::int FROM notification_events event WHERE event.principal_id=$1 AND event.project_resource_id=project.id) notification_count,
          (SELECT count(*)::int FROM live_activities activity WHERE activity.principal_id=$1 AND activity.project_resource_id=project.id) activity_count
         FROM resource_projects project
         WHERE project.principal_id=$1 AND project.merged_into_project_id IS NULL
         ORDER BY (project.deleted_at IS NOT NULL),project.last_seen_at DESC,project.id DESC`,
        [account.principalId],
      ),
      db.query<any>(
        `SELECT
          count(*) FILTER (WHERE deleted_at IS NULL AND merged_into_project_id IS NULL)::int active,
          count(*) FILTER (WHERE deleted_at IS NULL AND merged_into_project_id IS NULL AND is_direct)::int direct,
          count(*) FILTER (WHERE deleted_at IS NOT NULL AND merged_into_project_id IS NULL)::int archived,
          (SELECT count(*)::int FROM activity_conversations WHERE principal_id=$1) conversations,
          (SELECT count(*)::int FROM interaction_requests WHERE principal_id=$1 AND state='pending' AND expires_at>now()) pending,
          (SELECT count(*)::int FROM notification_events WHERE principal_id=$1) notifications,
          (SELECT count(*)::int FROM delivery_jobs job JOIN notification_events event ON event.id=job.notification_event_id WHERE event.principal_id=$1) deliveries
         FROM resource_projects WHERE principal_id=$1`,
        [account.principalId],
      ),
    ]);
    const projects = projectsResult.rows.map(projectFromRow);
    const selectedProject = selectedProjectId
      ? projects.find((project) => project.id === selectedProjectId) ?? null
      : null;
    if (selectedProjectId && !selectedProject) return context.notFound();
    const [aliases,conversations,recent] = selectedInternalId
      ? await Promise.all([
        db.query<any>(
          `SELECT id,display_name,provenance,created_at FROM resource_project_aliases
           WHERE principal_id=$1 AND project_id=$2 AND deleted_at IS NULL ORDER BY created_at,id`,
          [account.principalId,selectedInternalId],
        ),
        db.query<any>(
          `SELECT id,COALESCE(NULLIF(display_name,''),NULLIF(provider_thread_id,''),'Untitled conversation') display_name,
            producer_kind,project_assignment_source,last_seen_at
           FROM activity_conversations WHERE principal_id=$1 AND project_resource_id=$2
           ORDER BY last_seen_at DESC,id DESC LIMIT 100`,
          [account.principalId,selectedInternalId],
        ),
        db.query<any>(
          `SELECT id,'notification'::text kind,title,state::text,created_at occurred_at FROM notification_events
           WHERE principal_id=$1 AND project_resource_id=$2
           UNION ALL
           SELECT id,'activity'::text kind,title,state::text,updated_at occurred_at FROM live_activities
           WHERE principal_id=$1 AND project_resource_id=$2
           ORDER BY occurred_at DESC LIMIT 12`,
          [account.principalId,selectedInternalId],
        ),
      ])
      : [{ rows:[] },{ rows:[] },{ rows:[] }];
    const summary = summaryResult.rows[0] ?? {};
    const bootstrap: ProjectsDashboardBootstrap = {
      version:1,
      kind:"projects",
      route:{ path:context.req.path,selectedProjectId },
      shell:{
        title:"Projects",
        description:"Stable identity, membership, and lifecycle controls for every notification project.",
        active:"projects",
        releaseIdentity,
        account:{
          id:account.accountId,
          initial:account.user.name.trim().charAt(0).toUpperCase() || "K",
          name:account.user.name,
          email:account.user.email,
        },
        counts:{ pending:number(summary.pending),notifications:number(summary.notifications),deliveries:number(summary.deliveries) },
      },
      summary:{ active:number(summary.active),direct:number(summary.direct),archived:number(summary.archived),conversations:number(summary.conversations) },
      projects,
      selected:selectedProject ? {
        project:selectedProject,
        aliases:aliases.rows.map((row) => ({ id:publicResourceId("als",row.id),name:String(row.display_name),provenance:String(row.provenance),createdAt:iso(row.created_at) })),
        conversations:conversations.rows.map((row) => ({
          id:publicResourceId("cnv",row.id),name:String(row.display_name),producerKind:String(row.producer_kind),
          assignmentSource:row.project_assignment_source,lastSeenAt:iso(row.last_seen_at),
        })),
        recent:recent.rows.map((row) => ({ id:String(row.id),kind:row.kind,title:String(row.title),state:String(row.state),occurredAt:iso(row.occurred_at) })),
      } : null,
    };
    return secureHtml(context,await renderDocument(bootstrap));
  }

  const index: Handler = (context) => render(context,null);
  const detail: Handler = (context) => {
    const parsed = projectPublicIdSchema.safeParse(context.req.param("projectId"));
    return parsed.success ? render(context,parsed.data) : context.notFound();
  };

  function mutation(
    schema: z.ZodType,
    operation: (account: DashboardProjectAccount,context: any,input: any) => Promise<unknown>,
  ): Handler {
    return async (context) => {
      const account = await authorizeMutation(context);
      if (account instanceof Response) return account;
      const payload = await context.req.json().catch(() => null);
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return context.json({ error:"invalid_project_mutation" },400);
      try {
        const result = await operation(account,context,parsed.data) as Record<string,unknown>;
        return context.json({ ok:true,...result });
      } catch (error) {
        return mutationError(context,error);
      }
    };
  }

  const update = mutation(projectAppearanceInputSchema,(account,context,input) =>
    updateProjectResource(db,account.principalId,context.req.param("projectId"),input));
  const addAlias = mutation(projectAliasInputSchema,(account,context,input) =>
    addProjectAlias(db,account.principalId,context.req.param("projectId"),input));
  const removeAlias = mutation(projectRevisionInputSchema,(account,context,input) =>
    removeProjectAlias(db,account.principalId,context.req.param("projectId"),context.req.param("aliasId"),input.expectedRevision));
  const merge = mutation(projectMergeInputSchema,(account,context,input) =>
    mergeProjectResource(db,account.principalId,context.req.param("projectId"),input));
  const split = mutation(projectSplitInputSchema,(account,context,input) =>
    splitProjectConversations(db,account.principalId,context.req.param("projectId"),input));
  const archive = mutation(projectRevisionInputSchema,(account,context,input) =>
    archiveProjectResource(db,account.principalId,context.req.param("projectId"),input.expectedRevision));
  const restore = mutation(projectRevisionInputSchema,(account,context,input) =>
    restoreProjectResource(db,account.principalId,context.req.param("projectId"),input.expectedRevision));

  return { index,detail,update,addAlias,removeAlias,merge,split,archive,restore };
}
