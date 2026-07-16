/**
 * The Runner: hands, never brain. Leases jobs from the Core over outbound
 * HTTPS only, executes them against marketplace platforms with human-like
 * pacing, and reports raw results back. No DB, no LLM, no decisions.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { LeasedJob } from "@deepblue/core";
import { adapters } from "./adapters/index.js";
import { blockedCooldownMs, PlatformBlockedError } from "./blocked.js";
import { loadConfig, type RunnerConfig } from "./config.js";

/** Human pacing: never operate on a metronome. */
function jittered(baseMs: number): number {
  return Math.round(baseMs * (0.6 + Math.random() * 0.8));
}

async function leaseJob(config: RunnerConfig): Promise<LeasedJob | null> {
  const res = await fetch(`${config.coreApiUrl}/api/runner/jobs/lease`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.runnerToken}` },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`lease failed: HTTP ${res.status}`);
  return (await res.json()) as LeasedJob;
}

async function reportJob(
  config: RunnerConfig,
  jobId: string,
  outcome: { status: "succeeded" | "failed"; result?: unknown; error?: string },
): Promise<void> {
  const res = await fetch(`${config.coreApiUrl}/api/runner/jobs/${jobId}/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.runnerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(outcome),
  });
  if (!res.ok) throw new Error(`report failed: HTTP ${res.status}`);
}

async function executeJob(job: LeasedJob): Promise<unknown> {
  const adapter = adapters[job.payload.platform];
  if (!adapter) throw new Error(`no adapter for platform '${job.payload.platform}'`);

  switch (job.payload.type) {
    case "search_sweep":
      return adapter.search(job.payload.query);
    case "fetch_listing":
      return adapter.fetchListing({
        platform: job.payload.platform,
        platformListingId: job.payload.platformListingId,
        url: job.payload.url,
      });
    case "check_listing":
      return adapter.checkListing({
        platform: job.payload.platform,
        platformListingId: job.payload.platformListingId,
        url: job.payload.url,
      });
    case "send_message":
      return adapter.sendMessage(
        {
          platform: job.payload.platform,
          platformListingId: job.payload.platformListingId,
          url: job.payload.url,
          platformConversationId: job.payload.platformConversationId,
        },
        job.payload.body,
      );
    case "fetch_replies":
      return adapter.fetchReplies(
        {
          platform: job.payload.platform,
          platformListingId: job.payload.platformListingId,
          platformConversationId: job.payload.platformConversationId,
        },
        job.payload.sinceExternalId,
      );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  let running = true;
  process.on("SIGINT", () => {
    running = false;
    console.log("shutting down after current job...");
  });

  console.log(`runner started, polling ${config.coreApiUrl}`);
  // Circuit breaker: after a 403/429 the runner leases nothing until the
  // cooldown passes. Retrying against a block is how the real account dies.
  let pausedUntil = 0;
  while (running) {
    try {
      if (Date.now() < pausedUntil) {
        await sleep(jittered(config.pollIntervalMs));
        continue;
      }
      const job = await leaseJob(config);
      if (job) {
        console.log(`executing job ${job.id} (${job.payload.type})`);
        try {
          const result = await executeJob(job);
          await reportJob(config, job.id, { status: "succeeded", result });
        } catch (err) {
          if (err instanceof PlatformBlockedError) {
            pausedUntil = Date.now() + blockedCooldownMs();
            const until = new Date(pausedUntil).toISOString();
            console.error(`${err.message} — pausing all jobs until ${until}`);
            await reportJob(config, job.id, {
              status: "failed",
              error: `${err.message} — runner paused until ${until}`,
            });
          } else {
            await reportJob(config, job.id, {
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      console.error("poll error:", err instanceof Error ? err.message : err);
    }
    await sleep(jittered(config.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
