export interface RunnerConfig {
  coreApiUrl: string;
  runnerToken: string;
  /** Base poll interval; actual waits are jittered around it. */
  pollIntervalMs: number;
  /** Persistent browser profile dir — holds the logged-in Wallapop session. */
  browserProfileDir: string;
}

export function loadConfig(): RunnerConfig {
  const coreApiUrl = process.env.CORE_API_URL;
  const runnerToken = process.env.RUNNER_TOKEN;
  if (!coreApiUrl || !runnerToken) {
    throw new Error("CORE_API_URL and RUNNER_TOKEN must be set (see .env.example)");
  }
  return {
    coreApiUrl,
    runnerToken,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15_000),
    browserProfileDir: process.env.BROWSER_PROFILE_DIR ?? ".browser-profile",
  };
}
