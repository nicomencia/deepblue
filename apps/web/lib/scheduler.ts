/**
 * Local scheduler for dev / self-hosted single-user mode. Deliberately
 * dependency-free (no DB imports — Next bundles instrumentation in a layer
 * where server externals don't apply): it triggers the same /api/cron/*
 * endpoints Cloud Scheduler uses in cloud deployments.
 *
 * Pacing hygiene lives here: active hours only (08–23 Madrid) and
 * jittered ticks — never a metronome against the platforms.
 */

const TICK_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MINUTES ?? 180) * 60 * 1000;

let lastSweepAt = 0;

function baseUrl(): string {
  return process.env.SCHEDULER_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
}

function cronHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET;
  return secret ? { authorization: `Bearer ${secret}` } : {};
}

function madridHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Madrid",
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
}

const jittered = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

async function trigger(path: string): Promise<string> {
  const res = await fetch(`${baseUrl()}${path}`, { method: "POST", headers: cronHeaders() });
  return `${path} → ${res.status} ${await res.text()}`;
}

export function startScheduler(): void {
  console.log(
    `[scheduler] on — sweeps every ~${Math.round(SWEEP_INTERVAL_MS / 60000)} min (08–23h Madrid), digest 08–10h`,
  );
  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      console.error("[scheduler] tick failed:", err instanceof Error ? err.message : err);
    }
    setTimeout(loop, jittered(TICK_MS));
  };
  setTimeout(loop, 15_000); // let the server finish booting first
}

async function tick(): Promise<void> {
  const hour = madridHour();
  if (hour < 8 || hour >= 23) return; // asleep at night, like a human

  if (Date.now() - lastSweepAt >= SWEEP_INTERVAL_MS) {
    lastSweepAt = Date.now();
    console.log("[scheduler]", await trigger("/api/cron/sweep"));
  }

  if (hour < 10) {
    // runDigest has its own durable once-per-day guard.
    console.log("[scheduler]", await trigger("/api/cron/digest"));
  }
}
