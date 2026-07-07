# deepblue

Autonomous agent that hunts second-hand cars, evaluates their reliability like an expert,
negotiates with sellers on your behalf, and hands you the purchase at the final step.

**Read [PROJECT.md](./PROJECT.md) first** — vision, decisions, architecture, and roadmap.
Recon findings on platform internals live in [docs/RECON.md](./docs/RECON.md).

## Layout

```
apps/web        Next.js dashboard + API (the cloud Core's surface)
apps/runner     Playwright worker (runs on the home mini-PC, residential IP)
packages/core   Domain logic: types, lead state machine, adapter interfaces, jobs
packages/db     Drizzle ORM schema + Postgres client
```

## Development

```
pnpm install
pnpm typecheck        # typecheck all workspaces
pnpm dev:web          # dashboard on http://localhost:3000
pnpm dev:runner       # job-polling worker (needs CORE_API_URL + RUNNER_TOKEN)
```

Without `DATABASE_URL`, the web app falls back to an embedded Postgres (PGlite)
under `apps/web/.data` — zero setup. Set `DATABASE_URL` to use real Postgres.

The web server needs `RUNNER_TOKEN` set (any string in dev); the runner needs the
same token plus `CORE_API_URL=http://localhost:3000`.

### Autonomous mode

With `ENABLE_LOCAL_SCHEDULER=1`, the web server sweeps every brief every
`SWEEP_INTERVAL_MINUTES` (jittered, only 08–23h Madrid) and sends a daily email
digest each morning (Resend; without `RESEND_API_KEY` emails print to the log).
Top-grade finds trigger instant alert emails at ingest. Keep `pnpm dev:runner`
running and deepblue scouts by itself.

In cloud deployments, leave the local scheduler off and point Cloud Scheduler at
`POST /api/cron/sweep` and `POST /api/cron/digest` with `Authorization: Bearer $CRON_SECRET`.

### Try the Scout loop end to end

```
curl -X POST http://localhost:3000/api/dev/seed          # dev user + sample brief (VW Golf, Madrid)
curl -X POST http://localhost:3000/api/dev/seed-dossier  # reviewed Golf VII reliability dossier
curl -X POST http://localhost:3000/api/dev/sweep         # enqueue search jobs (Wallapop + AutoScout24)
pnpm dev:runner                                          # leases jobs, searches, reports back
curl http://localhost:3000/api/dev/state                 # counts: jobs, listings, leads
curl -X POST http://localhost:3000/api/dev/reevaluate    # refresh verdicts (dossier + benchmark)
curl "http://localhost:3000/api/dev/leads?limit=5"       # top leads with full verdicts
```

Then open http://localhost:3000 — shortlisted leads with confidence grades.
