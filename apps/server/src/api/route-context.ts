import type { AppDependencies, AppOptions } from "../app.js";
import type { ApnsMode } from "../activities.js";
import type { Database } from "../db.js";
import type { NotificationContentCipher } from "../notification-content.js";
import type { createTransportTokenEncryption, TransportTokenPurpose } from "../token-encryption.js";

/** Everything a machine/phone API route group closes over. */
export type ApiRouteContext = {
  db: Database;
  apnsMode: ApnsMode;
  dependencies: AppOptions | undefined;
  /** Set when the account/web stack is running (production and integrated tests). */
  integratedDependencies: AppDependencies | null;
  notificationContentCipher: NotificationContentCipher | null;
  encryptedTransportToken(token: string | null, purpose: TransportTokenPurpose): string | null;
  callbackEncryption(): ReturnType<typeof createTransportTokenEncryption>;
};
