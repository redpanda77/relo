export const accountLifecycleAdvisoryLock = "relo-owner-account-lifecycle";

export async function lockAccountLifecycle(
  client: { query: (sql: string,values?: unknown[]) => Promise<unknown> },
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[accountLifecycleAdvisoryLock]);
}
