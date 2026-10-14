import type { Hono } from "hono";
import type { ApiRouteContext } from "../api/route-context.js";
import { registerOwnerWorkRoutes } from "./owner-routes.js";
import { registerSessionWorkRoutes } from "./session-routes.js";

/** Works (STATE-SPEC v2 slice 2): agent-session producer routes and owner reads. */
export function registerWorkRoutes(app: Hono,shared: ApiRouteContext): void {
  registerSessionWorkRoutes(app,shared);
  registerOwnerWorkRoutes(app,shared);
}
