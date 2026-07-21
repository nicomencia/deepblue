# Developing features for deepblue

The playbook for adding a feature without breaking what makes this codebase work.
[PROJECT.md](../PROJECT.md) says *what* deepblue is and *why*; this doc says *how*
to build on it. If the two ever disagree, PROJECT.md wins.

## 1. The mental model (30 seconds)

```
packages/core    pure domain logic — no I/O, no vendor SDKs, fully unit-tested
packages/db      Drizzle schema + client (PGlite in dev, Postgres in prod)
apps/web         the BRAIN: dashboard, API, scheduler, LLM lanes, all decisions
apps/runner      the HANDS: Playwright + HTTP against marketplaces, residential IP
```

The runner **leases jobs** from the web API (`/api/runner/jobs/lease`) and
**reports results** back (`/api/runner/jobs/[id]/report`). It never decides
anything: payloads carry exact instructions (the literal message text, the exact
query), results cross a zod trust boundary before touching the DB. This split is
what lets brain and hands live on different machines — never blur it.

## 2. Invariants you cannot break

Check every design against these. They are earned, not aesthetic:

1. **Runner = hands, never brain.** No DB access, no business logic, no LLM
   calls in `apps/runner`. New platform work = new job type in
   [packages/core/src/jobs.ts](../packages/core/src/jobs.ts) + adapter method.
2. **Hard limits and vetoes are code, not prompt.** Budget caps, scam vetoes,
   "never promise a visit before price" — enforced in `packages/core`
   (`respondToCounterEur`, `hardFilterReason`), never delegated to an LLM.
3. **LLMs observe and phrase; code decides.** The negotiation pattern is
   Observe → Decide → Write: a reading extracts numbers, `respondToCounterEur`
   decides, Haiku writes prose — and the prose is validated (exact price
   present, ≤ CHAT_MAX_CHARS, no invented facts) with deterministic fallback
   ([apps/web/lib/draft-message.ts](../apps/web/lib/draft-message.ts)).
4. **Every boundary is parsed, never trusted.** Runner→Core results and every
   LLM output go through zod schemas (`normalizedListingSchema`,
   `llmEnrichmentPayloadSchema`, …). New boundary = new schema + `.parse()`.
5. **Dead stays dead.** Leads never resurrect; a fresh sweep makes new ones.
   Manual (adopted) leads never die on hard filters — reasons become warnings.
6. **Dossiers are knowledge with receipts.** Source-cited, versioned, in use on
   creation, disable-to-revoke. The agent never free-styles reliability claims
   from model memory. Generation labels carry their year span ("I (1980–1997)")
   because verdict routing selects dossiers by it.
7. **Wallapop hygiene.** Low volume, jittered pacing, 403/429 →
   `PlatformBlockedError` → stop leasing; never retry harder. The user's real
   account is on the line.
8. **Spend little on LLM.** Cheap model per lane via env
   (`DEEPBLUE_*_MODEL`), bounded batches, once-per-lead guards (`enrichedAt`),
   in-flight flags, cooldowns + daily ceilings on retries.
9. **Single-writer PGlite.** Never two web servers at once; kill port 3000
   before restarting. Migrations apply on web boot (`db:generate`, never run
   `db:migrate` against PGlite yourself).

## 3. Where does my feature go?

| The feature is… | It goes in… | With… |
|---|---|---|
| A rule, score, composer, parser — anything pure | `packages/core/src` | vitest tests in the sibling `*.test.ts`, behavior-named |
| A new persisted field/table | `packages/db/src/schema.ts` | `pnpm db:generate`; web boot applies it |
| Orchestration, a page, an email, an LLM lane | `apps/web` (`lib/` for logic, `app/` for UI/API) | events for audit, dev route if it needs manual triggering |
| Talking to a marketplace | `apps/runner/src/adapters` | a job contract in `core/jobs.ts`; RECON discipline (below) |

When in doubt: if it can be a pure function, put it in core and test it. The
web layer should be thin wiring around tested logic (`pickDossierForYear` in
core + 4 lines in `lookups.ts` is the shape to imitate).

## 4. The workflow, step by step

### a. Read before you write
Find the sibling of your feature — this codebase has one established pattern
per problem shape, and the fastest correct implementation is copying the
nearest one (grep for it; the comment at the top of each file says what it is).
Key exemplars:

- **Slow background work**: `void buildDossier(...).catch(→ failure event)` +
  module-level in-flight guard (`building` Set, `enrichInFlight` flag). Never
  block a request on minutes-long work.
- **Self-healing lanes**: recompute need from *current state*, don't track
  intent ([apps/web/lib/brief-hunt.ts](../apps/web/lib/brief-hunt.ts)
  `retryPendingDossiers`): failures, lost builds and later disables all
  resurface for free. Bound each pass; add cooldown + ceiling if it costs money.
- **Scheduler lanes**: a `/api/cron/*` route (auth via `isAuthorizedCron`),
  triggered by `lib/scheduler.ts` ticks — bounded per call, no-op when idle,
  so Cloud Scheduler can replace the local loop unchanged.
- **User actions**: server components + server actions; every form submit
  button is `SubmitButton` (pending feedback + anti-double-submit); slow
  navigations use `GenerateLink`. No client state unless unavoidable.
- **Manual/repair levers**: `/api/dev/*` routes, gated
  `NODE_ENV === "production" → 404`. Add one whenever you build something the
  scheduler triggers — you will want to trigger it by hand while testing.
- **Audit**: any action that changes meaningful state inserts into `events`
  with a payload that would let you reconstruct *why*.

### b. Design against the invariants
One minute with §2. The most common design mistakes here: putting a decision
in the runner or a prompt, trusting an LLM/runner payload without a schema,
and forgetting cost guards on anything that calls the API per-lead.

### c. Build core-first
Pure logic lands in `packages/core` with tests **in the same sitting** — the
tests are the spec (`respondToCounterEur`, `computeBenchmark`,
`generationYearSpan` all read as behavior tables). Gotchas that have bitten:

- es-ES number formatting groups only 5+ digits: `2150` renders "2150",
  `21500` renders "21.500". Test against reality, not intuition.
- `num()`-style parsers strip `.` as thousands separator — coordinates need
  their own parser (`coord()` in briefs actions). Empty form fields are `""`,
  not null: `?? default` does NOT fire on them.
- Missing data never condemns: filters kill on facts, unknown passes with the
  open question attached.

### d. Wire and verify live
`pnpm typecheck && pnpm test` after the LAST file touched, always. Then verify
against the running system — this project treats live verification as part of
the feature: hit the dev route, `curl` the pages you changed for 200s, check
the actual behavior (`/api/dev/state`, `/api/dev/leads?id=`, the dashboard).
A feature that only passed unit tests is half-verified.

### e. Platform work: RECON discipline
Before relying on any marketplace parameter or behavior, verify it live with a
**single, jittered, adapter-headers probe** (scratchpad script, one request per
question) and record the finding — positive or negative — in
[docs/RECON.md](./RECON.md) with the date. Negative findings are as valuable:
"`distance` NOT respected → radius enforced in Core" saved the next person a
wasted afternoon. Never loop probes; never probe from a datacenter IP.

### f. Document and ship
1. Add a dated change note (Spanish, why-first) at the top of the change list
   in [docs/DEV-SETUP.md §5](./DEV-SETUP.md) — what was broken/missing, the
   root cause, what changed, how it was verified, test count.
2. One commit per feature; the message explains the *why* (root cause →
   change → verification). Multi-line messages via bash heredoc
   (`git commit -F - <<'MSG'`), never PowerShell (it mangles them).
3. Push. Typecheck + tests must already be green — never commit red.

## 5. Testing philosophy

- Core logic: exhaustive unit tests, named for behavior
  ("prices a diesel against diesels, not the gasoline half of the pool").
- Web lib: pure helpers get the vitest lane in `apps/web` (emails, composers).
- No integration-test harness — its place is taken by live verification
  against the dev stack (dev routes + real runner + PGlite). Cheap and honest.
- LLM outputs are never asserted in tests; the *validators and clamps* around
  them are (bounded deltas, veto caps, banned-content regexes).

## 6. Quick reference

```bash
pnpm typecheck && pnpm test        # the gate before any commit
pnpm dev:web                       # brain (backs up DB, applies migrations)
pnpm dev:runner                    # hands (loads env itself since 2026-07-21)
start-deepblue.bat                 # both + browser, one double-click (Windows)

curl -X POST localhost:3000/api/dev/sweep      # manual sweep
curl -X POST localhost:3000/api/cron/enrich    # drain enrichment batch
curl -X POST localhost:3000/api/cron/dossiers  # retry uncovered dossiers
curl localhost:3000/api/dev/state              # counts at a glance
```

Env lives in `apps/web/.env.local` (web reads it natively; the runner resolves
it as fallback). Models per lane: `DEEPBLUE_ENRICH_MODEL` (Haiku),
`DEEPBLUE_READS_MODEL`, `DEEPBLUE_DRAFT_MODEL` (Haiku), `DEEPBLUE_DOSSIER_MODEL`,
`DEEPBLUE_DISCOVERY_MODEL`.
