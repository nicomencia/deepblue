import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

/** Production path: Cloud SQL / Neon / any Postgres via DATABASE_URL. */
export function createPostgresDb(databaseUrl: string): Db {
  const client = postgres(databaseUrl, { prepare: false });
  return drizzle(client, { schema });
}

/**
 * Dev fallback: embedded Postgres (PGlite) persisted to a local directory —
 * zero setup, single process only. Same dialect and query API as the real
 * thing, so the cast below is safe for everything drizzle exposes.
 */
export async function createPgliteDb(
  dataDir: string,
  migrationsFolder: string,
): Promise<Db> {
  const { mkdir } = await import("node:fs/promises");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await mkdir(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema });
  await migrate(db, { migrationsFolder });
  return db as unknown as Db;
}
