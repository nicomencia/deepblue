/**
 * Next.js instrumentation hook — runs once per server start.
 * Opt-in local scheduler: set ENABLE_LOCAL_SCHEDULER=1 (dev / self-hosted).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ENABLE_LOCAL_SCHEDULER !== "1") return;

  const g = globalThis as typeof globalThis & { __deepblueSchedulerStarted?: boolean };
  if (g.__deepblueSchedulerStarted) return;
  g.__deepblueSchedulerStarted = true;

  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
