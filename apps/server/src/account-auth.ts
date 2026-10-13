import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import type { Database } from "./db.js";

export function createAccountAuth(authDb: Database, baseURL: string, secret: string, clientIpHeader?: string) {
  return betterAuth({
    appName: "Relo Notifications",
    baseURL,
    basePath: "/api/auth",
    secret,
    database: authDb,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      modelName: "sessions",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
    },
    account: {
      modelName: "accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      // Session records keep the proxy's client address, not a client-supplied X-Forwarded-For.
      ...(clientIpHeader ? { ipAddress: { ipAddressHeaders: [clientIpHeader.toLowerCase()] } } : {}),
    },
    plugins: [bearer()],
  });
}

export type AccountAuth = ReturnType<typeof createAccountAuth>;

export type AccountSession = {
  session: { id: string; expiresAt: Date; userId: string };
  user: { id: string; name: string; email: string; image?: string | null };
};

export async function getAccountSession(accountAuth: AccountAuth, headers: Headers): Promise<AccountSession | null> {
  return await accountAuth.api.getSession({ headers }) as AccountSession | null;
}
