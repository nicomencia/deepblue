# deepblue

An autonomous agent that hunts for second-hand cars, talks to sellers on your behalf, negotiates the price, and hands the purchase to you at the very last step — with a booked visit and an agreed price.

## Vision

You give deepblue a brief: what car you're looking for, your conditions, and the price you're willing to pay. It searches marketplaces continuously, evaluates every listing (including scam screening), contacts sellers as *you*, asks the due-diligence questions, negotiates within your limits, and proposes visit slots. You get regular digests and urgent alerts, and you step in only for the parts that must be human: confirming the visit, inspecting the car, paying.

## Decisions made (2026-07-07)

| Decision | Choice | Rationale |
|---|---|---|
| Vertical | Cars first (motorbikes later) | High ticket, slow-moving conversations, high payoff per purchase |
| Platforms | Wallapop (Spain) + AutoScout24 (Europe) | One private-seller chat platform, one dealer/email platform — two very different adapter profiles, both valuable |
| Agent identity | Passes as the user | Clarifies if directly asked; never volunteers it. Escalates anything touching identity, money, documents, or logistics |
| Stack | TypeScript on Node.js everywhere | Next.js dashboard, Node workers, Playwright, Claude API |
| Cloud | GCP | User's expertise area; Cloud Run + Cloud SQL + Scheduler + Secret Manager map cleanly onto the Core |
| Auth | Firebase Auth from day one | Multi-user and mobile-app auth nearly free later; trivial for single user now |
| Hosting | Home runner (Raspberry Pi / mini-PC) + cloud-hostable core | Residential IP minimizes Wallapop ban risk; core is built cloud-ready for future multi-user |
| Architecture stance | Modular monolith, built to be moved | Multi-user future is a first-class design constraint: containerized everything, GCP behind interfaces, tenancy from day one — but no microservices until scale demands it |
| Differentiator | Reliability intelligence | Spanish buyers' #1 anxiety is unit reliability. deepblue is a car expert with an opinion on every unit, honest about its confidence — not a listings alert tool |
| Notifications | Email alerts + dashboard | Email carries deep links / one-click action links into the dashboard; no Telegram |
| Wallapop account | User's real account | Coherent with "the agent is me"; human-like pacing and low volume to protect it |

## Architecture

The key structural idea — and what resolves "runs on a Pi at home" vs "scales to many users later" — is splitting the system into a **Core** (cloud-hostable) and a **Runner** (runs wherever the residential IP is):

```
┌─────────────────────────── CORE (cloud-ready) ───────────────────────────┐
│                                                                          │
│  apps/web        Next.js dashboard + API (auth, briefs, leads, approvals)│
│  packages/core   Domain logic: scoring, dedup, state machine, agent      │
│                  (Claude API w/ tool use), negotiation guardrails        │
│  packages/db     Postgres schema + client (Drizzle)                      │
│  email           Outbound alerts/digests (Resend/Postmark) +             │
│                  dedicated mailbox for AutoScout24 dealer threads        │
│                                                                          │
└───────────────────────────────▲──────────────────────────────────────────┘
                                │  outbound HTTPS only (job polling / push)
┌───────────────────────────────┴──────────────────────────────────────────┐
│                        RUNNER (home machine, residential IP)             │
│                                                                          │
│  apps/runner     Node worker + Playwright with persistent browser        │
│                  profile. Executes platform jobs: search, fetch listing, │
│                  send message, read replies. Human-like pacing.          │
│                                                                          │
│  Platform adapters behind ONE interface:                                 │
│    WallapopAdapter    — browser session (chat lives here)                │
│    AutoScoutAdapter   — search/scrape + contact forms → email threads    │
│    (later: Milanuncios, coches.net, Facebook Marketplace...)             │
└───────────────────────────────────────────────────────────────────────────┘
```

- The Runner connects **outbound only** (polls a job queue / holds a socket to the Core) — no port forwarding, no inbound exposure at home.
- Multi-user future: the same Runner becomes a deployable unit — one per user at home, or a cloud fleet behind residential proxies. Nothing in the Core assumes where runners live.
- AutoScout24 conversations happen over **email**, not browser automation — open protocol, zero ban risk. The agent reads/writes a dedicated mailbox.

### Deployment & scaling model

The dividing rule: **anything that touches a marketplace as the user needs the residential IP and browser session (Runner); everything else lives in the cloud (Core).**

Cloud (Core): dashboard + API (Vercel or similar), managed Postgres (Neon or similar — single
source of truth), all scoring/state-machine/agent logic and Claude API calls, the job queue,
and all email in both directions (alerts out, AutoScout24 dealer threads in/out — that whole
lane never touches the Runner).

Mini-PC (Runner): Playwright + persistent logged-in Chromium profile, executing queue jobs
(search, fetch, send message, read replies) with human-like pacing. Deliberately dumb: no DB,
no business logic, no decisions. Outbound connections only.

Scaling path, in order, all behind the same job-queue interface:
1. Today: one BYO runner (this mini-PC) for one user.
2. SaaS: containerized runner fleet in the cloud, one per user session, egressing through
   residential proxies (~10-30€/user/mo); mobile app = second client of the same API.
3. Endgame option: official marketplace API partnerships.

Cheap insurance bought now: `user_id` on every table, runner auth tokens bound to a user.

### GCP mapping & engineering principles

| Component | GCP service | Notes |
|---|---|---|
| Dashboard + API (Next.js) | Cloud Run | Scales to zero; container is the deploy unit |
| Database | Cloud SQL for Postgres (smallest tier) | Or Neon free tier to start, migrate later — schema identical |
| Job scheduling | Cloud Scheduler → Core endpoint | Enqueues search sweeps, digests |
| Job queue (Core ↔ Runner) | Postgres-backed jobs table | Deliberately boring; Pub/Sub only if volume ever demands it |
| Auth | Firebase Auth / Identity Platform | Single user now; multi-user + mobile later with no rework |
| AutoScout24 mailbox | Dedicated Gmail + Gmail API | `watch` + Pub/Sub push for inbound dealer replies — very GCP-native |
| Outbound email | Resend or Postmark | GCP has no first-party sender |
| Secrets | Secret Manager | Runner gets a scoped token, never raw secrets |
| CI / images | GitHub Actions → Artifact Registry | Same runner image runs on mini-PC and (later) cloud fleet |
| Future runner fleet | GKE Autopilot or MIGs + residential proxies | Phase 4 only — long-lived browser sessions don't fit Cloud Run |

Principles that make it movable and scalable without building for scale prematurely:
- **Modular monolith**: one Core service, one Runner service. Hard internal boundaries
  (packages), no microservices. Split along package seams later only if forced.
- **Ports and adapters**: `packages/core` (domain logic) imports zero GCP/vendor SDKs.
  Queue, email, storage, auth sit behind interfaces in an infra package.
- **Containers everywhere**: the Runner image is identical on the mini-PC and a future
  cloud fleet; the Core image runs on Cloud Run or anywhere else.
- **Tenancy in one place**: every query goes through a data-access layer that scopes by
  `user_id`; tenancy is never sprinkled across feature code.
- **12-factor config**: all environment differences (local / mini-PC / Cloud Run) are env
  vars, no environment-specific code paths.

## Domain model

Every lead is a state machine; this drives the dashboard, the digests, and the agent's orchestration.

```
Brief        what the user wants: model(s), year/km/price ranges, conditions,
             hard limits (max price, non-negotiables), search geography
Listing      normalized listing from any platform (deduped across platforms)
Lead         Listing × Brief, with state:
             discovered → evaluated → shortlisted → contacted → negotiating
             → agreement → visit_proposed → handed_off | dead(reason)
Conversation messages per lead (platform chat or email thread), incl. drafts
Approval     pending human decision (send this draft? accept this counter?)
Event        append-only log of everything the agent did and why
```

## Agent behavior & guardrails

- **Due diligence first-class**: before contact, score every listing — price vs. own market benchmark (built from the ingested corpus), stock-photo suspicion, seller pushing off-platform, "I'll ship the car" (classic scam), vague import history. Prompt the user to pull DGT informe / ITV history once a plate or VIN is known. Mechanical reliability is its own pillar — see "Reliability intelligence" below.
- **Hard limits are code, not prompt**: max price, non-negotiable conditions, and "never commit money, never share documents" are enforced by the orchestration layer, not just by LLM instructions.
- **Escalation triggers**: identity questions, payment/deposit requests, document requests, off-platform moves, anything the agent scores as unusual → alert the user, pause the conversation.
- **Autonomy is a dial**: every conversation runs in one of three modes — draft-only (human approves every send), delegated (autonomous within guardrails), paused. Start everything in draft-only.
- **Ban-risk hygiene**: persistent browser profile, human-like hours and pacing, low daily message volume, jittered scheduling. The real account is on the line.

## Reliability intelligence (core pillar)

Spanish second-hand buyers' #1 anxiety is the reliability of the specific unit. deepblue's
answer is to *be* the knowledgeable friend who comes along to buy the car: expert on the
model, forensic about the unit, and honest about what it doesn't know. This is the moat —
alert tools exist; a calibrated mechanical opinion per unit does not.

**Model dossiers — knowledge with receipts.** When a brief is created, the system builds
(or reuses) a structured dossier per model/engine/generation in scope: known failure modes
(e.g. belt-in-oil wear, DSG mechatronics, timing-chain stretch), at what age/mileage they
bite, typical repair cost, recalls, and what evidence rules each in or out. Dossiers are
LLM-drafted with web research, **source-cited, stored and versioned in the DB**, and
reviewed before first use. When talking reliability, the agent is constrained to the
dossier — no free-styling from model memory. Unknown = "unverified", never invented.
Briefs make this tractable: dossiers are only needed for models actually being shopped,
built once, reused across every matching listing.

**Per-unit assessment.** Dossier × listing (year, km, engine, claimed history) → a
unit-specific checklist: which known issues are live at this age/mileage, what evidence
confirms or denies each (invoices, maintenance book, ITV history), what to ask the seller,
what to inspect in person.

**Evidence-gathering conversations.** Seller questions are generated from the unit
checklist ("has the timing belt been done — is there an invoice?"). Every answer updates
the assessment; evasion or contradiction lowers confidence and is surfaced as such.

**Confidence verdict — honest precision.** Every lead carries a structured verdict, never
a naked score: an overall grade decomposed into (1) model-level reliability, (2) unit
evidence, (3) seller credibility, (4) price fairness — each stating what is known, what is
assumed, and what remains unverified, plus "what would raise this grade". Calibrated
uncertainty *is* the precision: the product never sounds more confident than it is.

**Theory never kills a lead.** Dossier issues are *verification work*, not verdicts. Each
applicable issue carries a per-unit status (unconfirmed → confirmed / ruled_out via seller
answers) and an estimated likelihood for this unit. Unconfirmed theory caps model
reliability at C — only confirmed issues (or hard data like scam pricing) grade worse. The
verdict quantifies the gamble instead of forbidding it: summed repair exposure and a plain
budget note ("price + worst case still inside your budget"), because low-budget buyers
knowingly betting on an unverified unit is a valid strategy — the user always makes the
final call. Briefs carry a riskTolerance (low/medium/high) for ranking and phrasing.

**Markets are not comparable.** A Spanish Golf and a German Golf differ in price and
condition; price benchmarks are computed strictly within the listing's market
(countryCode), never across countries. Cross-market data may later inform *import*
analysis — explicitly framed as such, never mixed into fairness grades.

**Visit handoff pack.** At handoff the user gets a personalized inspection sheet for that
unit: what to look at, listen for, and test-drive, and which documents to demand — the
known weak points of that engine at that mileage, not a generic used-car checklist.

## Roadmap

- **Phase 0 — Recon & scaffold.** ✅ Done 2026-07-07. Monorepo scaffold (pnpm workspaces). Recon verified (docs/RECON.md): Wallapop search is plain HTTP with one magic header; AutoScout24 search is server-rendered JSON. Neither needs a browser for ingestion.
- **Phase 1 — Scout.** 🔨 In progress. Done (2026-07-07): Wallapop + AutoScout24 adapters, job queue (lease/report), ingestion → normalize/dedup → rule-based evaluation with confidence verdicts and open-questions lists, dossier-aware modelReliability (first reviewed dossier: Golf VII, 6 source-cited issues with fuel/gearbox/km/year applicability), PGlite zero-setup dev DB, dashboard. Verified live on both platforms: 63 listings, 28 shortlisted with dossier-informed verdicts. Remaining: automated dossier builder (Claude + web research, human review before reviewedAt), LLM verdict enrichment, daily email digest, brief management UI, scheduled sweeps, trim/year-aware price benchmark.
- **Phase 2 — Copilot.** Agent drafts openers, follow-ups, counter-offers — seller questions generated from the unit checklist; user approves via dashboard (email deep-links). Wallapop chat send/read via Playwright. AutoScout24 contact forms + email threads. Seller answers feed back into the confidence verdict. Visit-slot proposals.
- **Phase 3 — Delegate.** Autonomous negotiation in delegated mode within hard guardrails, escalation rules live, handoff = agreed price + proposed visit slots + personalized inspection pack for user confirmation.
- **Phase 4 — Productize (out of scope for now).** Multi-user auth, billing, runner fleet, motorbikes vertical. The architecture already respects it; don't build it yet.

## Known risks

1. **Platform automation fragility** — Wallapop can change internals or flag the session at any time. Mitigations: adapter isolation, pacing hygiene, draft-only default, and the email-based AutoScout24 lane as a ban-proof fallback.
2. **Account ban on the real account** — accepted consciously; hygiene rules above exist to protect it.
3. **Agent negotiating badly or getting manipulated** — hard limits in code, escalation triggers, full event log for auditability, draft-only mode until trust is earned.
4. **Scam exposure** — due-diligence scoring before any contact; user prompted to verify documents before any visit.
