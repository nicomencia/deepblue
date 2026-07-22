# deepblue

Autonomous agent that hunts second-hand cars, evaluates their reliability like an expert,
negotiates with sellers on your behalf, and hands you the purchase at the final step.

**Read [PROJECT.md](./PROJECT.md) first** — vision, decisions, architecture, and roadmap.
Building a feature? [docs/DEVELOPING.md](./docs/DEVELOPING.md) — the playbook:
invariants, where code goes, established patterns, workflow, gotchas.
Recon findings on platform internals live in [docs/RECON.md](./docs/RECON.md).
Moving to a new dev machine? [docs/DEV-SETUP.md](./docs/DEV-SETUP.md) — what to
copy by hand (.env.local, PGlite data), start order, dev endpoints, current state.
Deploying to the always-on home server? [docs/DEPLOY.md](./docs/DEPLOY.md) —
Arch laptop runbook: production mode, systemd units, backups, Tailscale.

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
pnpm test             # unit tests (packages/core: scoring rules, extraction, state machine)
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
digest on the first tick of each day — normally in the morning, or whenever the
machine boots (Resend; without `RESEND_API_KEY` emails print to the log).
Top-grade finds trigger instant alert emails at ingest. Keep `pnpm dev:runner`
running and deepblue scouts by itself.

In cloud deployments, leave the local scheduler off and point Cloud Scheduler at
`POST /api/cron/sweep`, `POST /api/cron/digest`, `POST /api/cron/enrich` and
`POST /api/cron/reap` with `Authorization: Bearer $CRON_SECRET`.

The reaper keeps the shortlist honest: stale listings are re-probed via the
runner (`check_listing` jobs), and only cars the platform confirms gone (404 /
sold) are killed — a listing merely aged off Wallapop's newest-first search
page is re-sighted, not reaped. Tune with `LISTING_RECHECK_HOURS` (default 36).

### LLM layer (dossier builder + verdict enrichment)

Set `ANTHROPIC_API_KEY` in `apps/web/.env.local` to enable:

- **Dossier builder** — from `/dossiers` (or `POST /api/dev/build-dossier`), Claude
  researches a model on the web and drafts a source-cited reliability dossier.
  Drafts never drive verdicts: you review and approve them in `/dossiers` first;
  approval re-evaluates every shortlisted lead on that model.
- **Verdict enrichment** — the scheduler (or `POST /api/cron/enrich`) has Claude read
  each shortlisted ad's free text and refine the rule-based verdict within hard
  bounds (±15 per factor, vetoes stay code). Runs once per lead, best-scored first.

Models default to `claude-opus-4-8`; override with `DEEPBLUE_DOSSIER_MODEL` /
`DEEPBLUE_ENRICH_MODEL`. Without the key both features stay off and say so.

**No API key? Subscription mode.** A Claude Code session can play the LLM role on
the flat subscription instead of per-token billing: ask it to research a dossier or
read the shortlisted ads, and it imports the results through the same zod trust
boundary via `POST /api/dev/import-dossier` (draft → approve in `/dossiers`) and
`POST /api/dev/import-enrichment` (`{leadId, source, enrichment}` — same clamps and
veto caps as the API path, safe to re-import). The API lane stays dormant until a
key appears; nothing else changes.

### Try the Scout loop end to end

```
curl -X POST http://localhost:3000/api/dev/seed          # dev user + sample brief (VW Golf, Madrid)
curl -X POST http://localhost:3000/api/dev/seed-dossier  # reviewed Golf VII reliability dossier
curl -X POST http://localhost:3000/api/dev/sweep         # enqueue search jobs (Wallapop + AutoScout24)
pnpm dev:runner                                          # leases jobs, searches, reports back
curl http://localhost:3000/api/dev/state                 # counts: jobs, listings, leads
curl -X POST http://localhost:3000/api/dev/reevaluate    # refresh verdicts (dossier + benchmark)
curl "http://localhost:3000/api/dev/leads?limit=5"       # top leads with full verdicts

# With ANTHROPIC_API_KEY set:
curl -X POST http://localhost:3000/api/dev/build-dossier \
  -H 'content-type: application/json' -d '{"make":"Seat","model":"Leon"}'
curl -X POST http://localhost:3000/api/cron/enrich       # LLM-refine pending verdicts
```

Then open http://localhost:3000 — shortlisted leads with confidence grades.
