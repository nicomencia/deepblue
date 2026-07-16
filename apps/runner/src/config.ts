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
    chatHeadless: process.env.CHAT_HEADLESS === "1",
  };
}
