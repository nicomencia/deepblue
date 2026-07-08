/**
 * The Runner: hands, never brain. Leases jobs from the Core over outbound
 * HTTPS only, executes them against marketplace platforms with human-like
 * pacing, and reports raw results back. No DB, no LLM, no decisions.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { LeasedJob } from "@deepblue/core";
import { adapters } from "./adapters/index.js";
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
    case "fetch_replies":
      throw new Error(`'${job.payload.type}' arrives in Phase 2`);
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
  while (running) {
    try {
      const job = await leaseJob(config);
      if (job) {
        console.log(`executing job ${job.id} (${job.payload.type})`);
        try {
          const result = await executeJob(job);
          await reportJob(config, job.id, { status: "succeeded", result });
        } catch (err) {
          await reportJob(config, job.id, {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
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
