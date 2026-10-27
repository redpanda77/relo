import { betterAuth } from "better-auth";
import { bearer, twoFactor } from "better-auth/plugins";
import type { Database } from "./db.js";

/** Sign in with Apple (apple-sign-in.ts): the web Services ID and the iPhone app's bundle ID, each optional. */
export type AppleSignInConfig = { servicesId?: string | undefined; bundleId?: string | undefined };

export function appleSignInEnabled(apple: AppleSignInConfig | undefined): apple is AppleSignInConfig {
  return Boolean(apple?.servicesId || apple?.bundleId);
}

export function createAccountAuth(authDb: Database, baseURL: string, secret: string, clientIpHeader?: string, apple?: AppleSignInConfig) {
  const appleAudiences = [apple?.servicesId,apple?.bundleId].filter((value): value is string => Boolean(value));
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
    // Only Apple ID tokens, verified against Apple's keys for these audiences; apple-sign-in.ts is the only caller
    // (the generic /api/auth/sign-in/social and callback routes are closed). The secret is never used: no code exchange.
    ...(appleAudiences.length ? { socialProviders: { apple: {
      clientId: appleAudiences[0]!, clientSecret: "unused", audience: appleAudiences,
    } } } : {}),
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
      // Sign in with Apple joins the account that already has its email (password accounts never verify theirs),
      // but only when Apple says it verified that email: Apple is not a trusted provider. The match is on the exact
      // address, so a private-relay address joins only an account created with that same relay address.
      accountLinking: { enabled: true, requireLocalEmailVerified: false, trustedProviders: [] },
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
    plugins: [
      bearer(),
      // Two-step sign-in (docs/HARDENING.md, gap 1): authenticator-app codes and one-time backup codes.
      twoFactor({
        issuer: "Relo",
        schema: {
          user: { fields: { twoFactorEnabled: "two_factor_enabled" } },
          twoFactor: {
            modelName: "two_factors",
            fields: {
              backupCodes: "backup_codes", userId: "user_id",
              failedVerificationCount: "failed_verification_count", lockedUntil: "locked_until",
            },
          },
        },
      }),
    ],
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
