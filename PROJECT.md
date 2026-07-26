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
LLM-drafted with web research, **source-cited, stored and versioned in the DB**. Review is
opt-out since 2026-07-14 (draft quality earned it): a dossier goes live on creation and
re-evaluates the model's leads immediately; /dossiers can disable any dossier, which pulls
it out of every verdict on the spot. When talking reliability, the agent is constrained to
the dossier — no free-styling from model memory. Unknown = "unverified", never invented.
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

**Two axes, never conflated (added 2026-07-07).** The verdict separates *attractiveness*
from *verification*. Score (0–100) = weighted subscores — price fairness 0.40, model
reliability 0.15, unit condition 0.30, seller 0.15 at medium risk tolerance (gamblers
shift weight from theoretical risk to price; conservative buyers the reverse). Model
weight is deliberately low: the user chose the model knowing its reputation, so this
factor only differentiates configurations, never re-punishes the model choice. Banded to
grades A≥85/B≥70/C≥55/D≥40/E. Model reliability subtracts likelihood-weighted *expected
repair cost relative to asking price*, so risk is priced, not binary. confidencePct
(0–100) tracks how much is verified (fields known, seller reputation fetched, dossier
issues resolved) and rises with seller answers. Vetoes remain code: scam pricing → E,
confirmed critical issue → D at best. Never `worstOf` — that pins every unverified unit
to the same grade and differentiates nothing.

**Theory never kills a lead.** Dossier issues are *verification work*, not verdicts. Each
applicable issue carries a per-unit status (unconfirmed → confirmed / ruled_out via seller
answers) and an estimated likelihood for this unit. Unconfirmed theory is *priced, not
capped* (amended 2026-07-15; supersedes the earlier "caps at C" rule): the model factor
subtracts likelihood-weighted expected repair cost relative to the asking price, and may
grade D/E when the unverified exposure rivals what the car costs (e.g. possible bore
scoring worth ~16.000 € on a 16.300 € Boxster S) — hiding that behind a C-floor would
sound more confident than we are. The lead still lives: model weight is 0.15, so a
well-priced unit stays shortlisted with its verification steps attached. The verdict
quantifies the gamble instead of forbidding it: summed repair exposure and a plain budget
note ("price + worst case still inside your budget"), because low-budget buyers knowingly
betting on an unverified unit is a valid strategy — the user always makes the final call.
Briefs carry a riskTolerance (low/medium/high) for ranking and phrasing.

**Markets are not comparable.** A Spanish Golf and a German Golf differ in price and
condition; price benchmarks are computed strictly within the listing's market
(countryCode), never across countries. Cross-market data may later inform *import*
analysis — explicitly framed as such, never mixed into fairness grades.

**Visit handoff pack.** At handoff the user gets a personalized inspection sheet for that
unit: what to look at, listen for, and test-drive, and which documents to demand — the
known weak points of that engine at that mileage, not a generic used-car checklist.

## Roadmap

- **Phase 0 — Recon & scaffold.** ✅ Done 2026-07-07. Monorepo scaffold (pnpm workspaces). Recon verified (docs/RECON.md): Wallapop search is plain HTTP with one magic header; AutoScout24 search is server-rendered JSON. Neither needs a browser for ingestion.
- **Phase 1 — Scout.** 🔨 In progress. Done (2026-07-07): Wallapop + AutoScout24 adapters, job queue (lease/report), ingestion → normalize/dedup → rule-based evaluation with confidence verdicts and open-questions lists, dossier-aware modelReliability (first reviewed dossier: Golf VII, 6 source-cited issues with fuel/gearbox/km/year applicability), PGlite zero-setup dev DB, dashboard. Verified live on both platforms: 63 listings, 28 shortlisted with dossier-informed verdicts. Scheduled sweeps (local scheduler + cron endpoints for Cloud Scheduler) and daily email digest + instant alerts (Resend, log-preview without key) added 2026-07-07. Brief management UI + lead detail view added 2026-07-07 (dashboard v2). LLM layer added 2026-07-08: automated dossier builder (Claude + web search, source-cited drafts reviewed/approved in /dossiers before use — approval re-evaluates affected leads) and LLM verdict enrichment (Claude reads each shortlisted ad's free text; bounded ±15 factor deltas, red/green flags, scam suspicion capping at D, extra seller questions; stored raw on the lead and re-merged deterministically on every rule re-evaluation; confidencePct untouched — reading an ad harder verifies nothing). Both degrade gracefully without ANTHROPIC_API_KEY. Enrichment-findings-become-rules (2026-07-08, from reading real Flexicar ads): cash-price extraction («precio al contado» beats the financing-bait headline everywhere: hard filters, fairness, benchmark medians, budget notes), REF-based duplicate detection (same physical car cross-posted by franchise accounts → born dead as duplicate_listing; 14 duplicates killed on first corpus pass), and sellerPreference (prefer_private penalizes ≥1000-sales compraventa chains −20, rewards particulares +5 — the user's stated stance). Trim/year-weighted benchmark added 2026-07-08: weighted median per unit (trim match ×4 dominates, year proximity decays gently, power proximity as trim proxy when versions are missing), Kish effective sample size gates it with graceful fallback to the coarse median — pure function in core, fully unit-tested. Listing lifecycle reaper added 2026-07-08: because Wallapop search returns only the newest page, "stopped appearing in sweeps" cannot mean "gone" (a live unit ages off the page). So stale shortlisted listings are *probed*, not assumed dead — a check_listing job has the Runner hit the item's own endpoint; only a real 404/sold flag reaps the lead (dead listing_gone), reserved → listing_reserved, and a live probe self-heals by bumping lastSeenAt. Runs via /api/cron/reap (scheduler) — Wallapop only for now (AS24 liveness ships with its detail enrichment).

**Wallapop-only focus (2026-07-08).** AutoScout24 is paused: `ACTIVE_PLATFORMS = ["wallapop"]` gates sweeps, lead generation and price benchmarks, and the maintenance pass retires existing AS24 leads to dead(platform_paused). Dead leads are never resurrected (a fresh sweep makes new ones). The AS24 adapter, schema enum and stored data all stay intact — re-enabling is a one-line change to ACTIVE_PLATFORMS. Remaining when AS24 resumes: its detail enrichment + liveness (checkListing).
- **Phase 2 — Copilot.** Agent drafts openers, follow-ups, counter-offers — seller questions generated from the unit checklist; user approves via dashboard (email deep-links). Wallapop chat send/read via Playwright. AutoScout24 contact forms + email threads. Seller answers feed back into the confidence verdict. Visit-slot proposals.
- **Phase 3 — Delegate.** Autonomous negotiation in delegated mode within hard guardrails, escalation rules live, handoff = agreed price + proposed visit slots + personalized inspection pack for user confirmation.
- **Phase 4 — Productize (out of scope for now).** Multi-user auth, billing, runner fleet, motorbikes vertical. The architecture already respects it; don't build it yet.

## Future bets (parked 2026-07-07, not scheduled)

**Autocontact (parked 2026-07-26, not scheduled).** The scarce good unit is won on
minutes, not on analysis. A well-priced 207 RC collects a dozen messages in its first
hour; the third buyer to write finds the seller already agreed a visit with someone
else. Today deepblue's edge is *knowing first* and then spending it waiting for a human
to open an email — the analysis advantage evaporates in the approval queue. Autocontact
converts it into a speed advantage: a freshly-ingested unit that clears a high bar gets
its opener sent immediately, before the user has read the alert.

This is the autonomy dial applied to **first contact only**, never to negotiation — the
seller's reply goes straight back to the normal draft-only approval queue, so the user
still owns every word that follows. Guardrails belong in code, not in the prompt: the
trigger below; strictly *inside* the user's real hard limits (a near miss never
qualifies — by definition it is not worth jumping the queue for); a freshness window
(first seen minutes ago, not a backfill of the corpus); per-brief and per-day ceilings;
one opener per seller, ever; no number in the text (it asks the unit's checklist
questions and requests a visit slot, never states or accepts a price); the existing
`CHAT_MAX_CHARS` and pacing hygiene unchanged. Per-brief kill switch, and the send is
an ordinary approval row auto-approved by rule, so the event log reads the same.

*Trigger: grade A, decided 2026-07-26, adjustable later.* Rare by construction is the
whole point — A starts at 85 and the live corpus tops out at 78 — but "rare" is not
"impossible", and an earlier reading of this file said it was. That reading measured 18
leads *after* the Golf brief's 143 were cascaded away, and generalised from the 207 RC,
where every unit inherits the same unconfirmed 1.6 THP issues and the 2026-07-15 pricing
amendment holds the model factor down on purpose. The mechanism that makes A reachable
without any seller input is issue **applicability** (`evaluate.ts`): a dossier issue that
does not apply to this unit's fuel/gearbox/km/year is ruled out, and ruled-out issues
cost zero exposure — so a Golf VII whose engine dodges most of its own dossier can clear
85 cold. Consequence to accept knowingly: on the 207 RC hunt autocontact will never fire.
For the highest-blast-radius action in the product, a gate that errs toward silence is
the right way to be wrong, and the bar is one constant to move. If it proves *too* silent
across every brief, the fallback is not a lower letter but the self-calibrating bar the
near-miss work already introduced — `bestShortlistedScore`, beat everything on that
brief's list by a margin — which says the truer thing: not "this is an A", but "this is
the best thing we have ever seen for you".

**Companion — message economy scales with doubt, not with politeness.** Same insight,
needs no autonomy at all, so it ships inside Phase 2: on a unit we are sure about every
extra question is a chance to lose it, so ask little and go for the visit slot; on a unit
we doubt, questions are cheap insurance against a wasted two-hour drive, so ask more and
take more rounds. Two halves, and the order matters.

*First, ranking — and this is a bug, not a preference.* `composeOpeningMessage` sends
`openQuestions.slice(0, 3)` under a comment saying "best first", but `buildVerdict`
assembles that array in construction order: `assessUnit` pushes the four generic
questions (libro de mantenimiento, propietarios, accidentes, ITV) before
`reliability.questions` is appended, so the **dossier-driven questions never reach the
opener**. Verified live 2026-07-26 on the shortlisted 207 RCs: positions 1–3 are the
generic four; "¿se ha cambiado la cadena de distribución y el tensor? ¿hay factura?" —
the question that separates a 6.000 € car from a 12.000 € one on a 1.6 THP — sits at
position 6 and is never asked. So `openQuestions` must carry a rank (live critical issue
with repair exposure > import/paperwork > missing hard fact > generic courtesy), and the
opener must take the top of that rank.

*Then the budget.* `MAX_OPENING_QUESTIONS = 3` ignores the verdict entirely; it should be
a function of it — `confidencePct` and live-issue count are already computed, and
distance (brief location vs listing lat/lon) belongs in it too, since a 200 km round trip
deserves pre-screening a 15 km one does not. Cutting the budget **before** fixing the
rank would make things strictly worse: the one surviving question would be "¿tiene libro
de mantenimiento?". Two floors stay in code: questions attached to a live critical issue
are never dropped however good the grade (an A-priced 1.6 THP is still a 1.6 THP), and
closing fast means asking for a slot, never naming a number — the existing
`warm && lastBatch` gate on `composeOfferClosing` already encodes that negotiating early
gives leverage away. Verification does not vanish on a great unit; it moves to the visit,
where the inspection pack already covers it.

Honest risk, and the reason autocontact is parked rather than scheduled: an autonomous
send from the user's real account is the highest-blast-radius action in the product. A
wrong opener is visible to a stranger and cannot be unsent, and it concentrates ban
exposure exactly on the busiest ads. It also presumes the runner and its logged-in
session are reliably up, so it depends on the always-on deployment. Natural slot: the
first delegated slice of Phase 3, only after Phase 2 conversations have been proven by
hand — and after the message-economy change has been watched working under approval.

**Model discovery agent (long shot — the mass-market front door).** Conversational
advisor for non-experts who arrive with needs ("familiar, fiable, ~12.000 €, ciudad +
escapadas"), not models. Differentiator vs generic LLM advice: grounded in our live
corpus — real local supply, real medians, real dossiers per candidate model. The
conversation's output is a Brief; recommended models feed the dossier builder as a side
effect. Architecturally: LLM + tool-use over existing tables, zero platform risk. Natural
slot: once the LLM layer exists, before/alongside Phase 3.

**Seller ad audit (scheduled 2026-07-22 — first slice of selling mode, queued
right after the laptop deployment).** Paste the URL of *your own* ad → deepblue
audits it through a buyer's eyes, reusing the whole intelligence stack: the
adoption lane fetches it (new `audit` intent, no lead created), the evaluator's
`openQuestions` + dossier `evidence` fields invert into "what buyers will ask —
preempt it in the ad", the enrichment reading flags free-text gaps, and the
weighted benchmark gives a price ladder (venta rápida = cheapest credible
comparable / mercado / sin prisa + margen de regateo) positioned against the
live corpus ("serías el 3º más barato de 14"). Honesty rules: asking prices are
not sold prices — frame as positioning, never "this will sell for X"; thin
corpus says so (Kish gate). Future upgrade already accruing data: reaper
`listing_gone` events give time-on-market for comparables. MVP ≈ core
`composeSellerAudit` (pure, tested) + `audit` intent + `/vender` page;
re-audit after editing the ad shows the delta. Commercially notable: a
shareable, zero-platform-risk freemium hook that monetizes the same
intelligence twice. Account-wide audit = loop over this later.

**Selling mode (very long shot — the symmetry play).** Reuses the stack with roles
flipped: price suggestion from the market-scoped benchmark (+ condition/trim
adjustments), LLM-generated listing from a one-time vehicle sheet, buyer conversations on
the Phase 2/3 conversational agent with the same autonomy dial and hard guardrails (price
floor in code, escalate payment/identity, seller-side scam filters). Killer detail: the
buy-side already generates the due-diligence questions buyers ask — the sell-side preempts
them in the listing, publishing announcements our own evaluator would grade A on unit
evidence. Endgame: deepblue buyers matching deepblue sellers. Strictly after buy-side
conversations are proven.

## Known risks

1. **Platform automation fragility** — Wallapop can change internals or flag the session at any time. Mitigations: adapter isolation, pacing hygiene, draft-only default, and the email-based AutoScout24 lane as a ban-proof fallback.
2. **Account ban on the real account** — accepted consciously; hygiene rules above exist to protect it.
3. **Agent negotiating badly or getting manipulated** — hard limits in code, escalation triggers, full event log for auditability, draft-only mode until trust is earned.
4. **Scam exposure** — due-diligence scoring before any contact; user prompted to verify documents before any visit.
