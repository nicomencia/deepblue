/**
 * PGlite backup: dated .tgz snapshots of apps/web/.data/pglite.
 *
 * Safety model: PGlite is single-writer, so a copy is only consistent when
 * the web server is NOT running. This script refuses to copy while anything
 * listens on the web port — which makes "before every `pnpm dev:web`" the
 * natural (and automated) moment to run it. Manual runs: `pnpm backup:db`.
 *
 * Destination: DEEPBLUE_BACKUP_DIR, or ~/deepblue-backups. Deliberately NOT
 * a cloud-synced folder by default — point DEEPBLUE_BACKUP_DIR at a PERSONAL
 * synced dir if you want off-machine copies (never a work OneDrive).
 *
 * Always exits 0 unless the backup itself fails: it must never block a boot.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, cpSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEEP = 14;
const PORT = Number(process.env.PORT ?? 3000);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(repoRoot, "apps", "web", ".data");
const dbDir = path.join(dataDir, "pglite");
const backupDir = process.env.DEEPBLUE_BACKUP_DIR ?? path.join(os.homedir(), "deepblue-backups");

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.setTimeout(1500, () => { sock.destroy(); resolve(false); });
  });
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function prune() {
  const old = readdirSync(backupDir)
    .filter((f) => f.startsWith("pglite-") && (f.endsWith(".tgz") || statSync(path.join(backupDir, f)).isDirectory()))
    .sort() // timestamped names sort chronologically
    .slice(0, -KEEP);
  for (const f of old) {
    rmSync(path.join(backupDir, f), { recursive: true, force: true });
    console.log(`[backup-db] pruned ${f}`);
  }
}

if (!existsSync(dbDir)) {
  console.log("[backup-db] no database yet (apps/web/.data/pglite missing) — nothing to back up");
  process.exit(0);
}
if (await portInUse(PORT)) {
  console.log(
    `[backup-db] port ${PORT} is busy — a running server means the copy would not be consistent; skipping ` +
      "(backups happen automatically on the next server start)",
  );
  process.exit(0);
}

mkdirSync(backupDir, { recursive: true });
const name = `pglite-${timestamp()}`;
const tgz = path.join(backupDir, `${name}.tgz`);

// tar ships with Windows 10+, macOS and Linux; fall back to a plain copy.
const tar = spawnSync("tar", ["-czf", tgz, "-C", dataDir, "pglite"], { stdio: "inherit" });
if (tar.status === 0) {
  const mb = (statSync(tgz).size / 1024 / 1024).toFixed(1);
  console.log(`[backup-db] ${tgz} (${mb} MB)`);
} else {
  rmSync(tgz, { force: true });
  const dest = path.join(backupDir, name);
  cpSync(dbDir, dest, { recursive: true });
  console.log(`[backup-db] tar unavailable — plain copy at ${dest}`);
}
prune();
