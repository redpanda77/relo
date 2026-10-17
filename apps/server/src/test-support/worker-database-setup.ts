/** Vitest setup file: points TEST_DATABASE_URL at this worker's own database (worker-database.ts). */
import { perWorkerEligible, workerDatabase } from "./worker-database.js";

const value = process.env.TEST_DATABASE_URL;
if (value && !process.env.RELO_TEST_WORKER_DATABASE && perWorkerEligible(new URL(value))) {
  const clone = await workerDatabase(new URL(value), process.env.VITEST_POOL_ID ?? "1");
  process.env.TEST_DATABASE_URL = clone.toString();
  process.env.RELO_TEST_WORKER_DATABASE = clone.pathname.slice(1);
}
