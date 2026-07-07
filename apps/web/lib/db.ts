import path from "node:path";
import { createPgliteDb, createPostgresDb, type Db } from "@deepblue/db";

// Survives Next.js dev-server HMR: one DB handle per process, never per reload.
const g = globalThis as typeof globalThis & { __deepblueDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  // Never cache a rejection — a transient init failure must not poison the process.
  g.__deepblueDb ??= init().catch((err: unknown) => {
    g.__deepblueDb = undefined;
    throw err;
  });
  return g.__deepblueDb;
}

async function init(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) return createPostgresDb(url);
  // Zero-setup dev fallback: embedded Postgres persisted under apps/web/.data
  // PGlite mangles Windows backslash paths (treats them as escapes) — always
  // hand it forward slashes.
  return createPgliteDb(
    path.join(process.cwd(), ".data", "pglite").replaceAll("\\", "/"),
    path.join(process.cwd(), "..", "..", "packages", "db", "migrations"),
  );
}
