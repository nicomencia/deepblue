import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RunnerConfig {
  coreApiUrl: string;
  runnerToken: string;
  /** Base poll interval; actual waits are jittered around it. */
  pollIntervalMs: number;
  /** Persistent browser profile dir — holds the logged-in Wallapop session. */
  browserProfileDir: string;
  /**
   * Chat sends default to a visible browser window: sends are rare,
   * user-approved, and a headed session is the least detectable. Set
   * CHAT_HEADLESS=1 to hide it.
   */
  chatHeadless: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The runner is plain tsx — no framework loads env files for it. Resolve its
 * own: the real environment always wins (loadEnvFile never overrides), then
 * the first file to define a var — runner-local, repo root, and finally the
 * web app's, so the single-file dev setup (apps/web/.env.local) just works.
 */
function loadEnvFiles(): void {
  const candidates = [
    path.resolve(here, "../.env.local"), // apps/runner/.env.local
    path.resolve(here, "../../../.env.local"), // repo root
    path.resolve(here, "../../web/.env.local"), // apps/web/.env.local
  ];
  for (const file of candidates) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function loadConfig(): RunnerConfig {
  loadEnvFiles();
  // Same-machine dev is the default; a split deployment sets CORE_API_URL.
  const coreApiUrl = process.env.CORE_API_URL ?? "http://localhost:3000";
  const runnerToken = process.env.RUNNER_TOKEN;
  if (!runnerToken) {
    throw new Error(
      "RUNNER_TOKEN must be set — in the environment or in apps/runner/.env.local, " +
        ".env.local (repo root) or apps/web/.env.local (see .env.example)",
    );
  }
  return {
    coreApiUrl,
    runnerToken,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15_000),
    browserProfileDir: process.env.BROWSER_PROFILE_DIR ?? ".browser-profile",
    chatHeadless: process.env.CHAT_HEADLESS === "1",
  };
}
