import type { AccountAuth } from "../account-auth.js";
import type { ApnsMode } from "../activities.js";
import type { Database } from "../db.js";
import type { NotificationContentCipher } from "../notification-content.js";
import type { OwnerAccount } from "./owner-account.js";

/** Everything a Dashboard/account route group closes over. */
export type WebRouteContext = {
  db: Database;
  accountAuth: AccountAuth;
  bootstrapOwnerHandle: string;
  appOrigin: string;
  appUrl: string;
  apnsMode: ApnsMode;
  releaseIdentity: string;
  notificationContentCipher: NotificationContentCipher;
  /** Signed-in owner with an exact same-origin request (Dashboard mutations). */
  dashboardMutationAccount(context: any): Promise<OwnerAccount | Response>;
  /** Signed-in owner; a cross-origin request is refused, a missing origin (the iPhone) is allowed. */
  accountMutationAccount(context: any): Promise<OwnerAccount | Response>;
  /** A Dashboard mutation by a user with the owner role. */
  ownerAdminAccount(context: any): Promise<OwnerAccount | Response>;
};
