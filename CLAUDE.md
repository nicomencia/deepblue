# deepblue — Claude session orientation

Personal autonomous agent hunting second-hand cars on Wallapop: source-cited
reliability dossiers, per-unit verdicts, seller messaging with human approval.
Personal tool today; built to scale commercial later.

## Read first, by task

- **Deploying on the always-on home server (Arch laptop)?** Follow
  [docs/DEPLOY.md](docs/DEPLOY.md) top to bottom — the "Traspaso" section is
  the checklist written for exactly this session.
- **Building or changing a feature?** [docs/DEVELOPING.md](docs/DEVELOPING.md)
  is the playbook (invariants, where code goes, patterns, workflow).
  [PROJECT.md](PROJECT.md) is the authority on vision and design decisions.
- **New dev machine?** [docs/DEV-SETUP.md](docs/DEV-SETUP.md) — what to copy
  by hand, golden rules, dev toolbox, dated change log (current state lives
  at the top of §5).
- **Touching a marketplace?** [docs/RECON.md](docs/RECON.md) — every param
  verified live before use; negative findings recorded too.

## Non-negotiables (digest — full list in docs/DEVELOPING.md §2)

- Runner = hands, never brain. Hard limits and vetoes in code, never prompt.
- zod at every trust boundary (runner results, LLM output). Parse, don't trust.
- Dead leads stay dead. PGlite is single-writer — kill port 3000 before
  starting a second server, ever.
- Wallapop hygiene: low volume, jittered pacing, stop on 403/429, never retry
  harder. The user's real account is on the line.
- LLM cost guards everywhere: bounded batches, once-per-lead marks, in-flight
  flags, cooldowns + daily ceilings.

## Working habits expected of every session

- `pnpm typecheck && pnpm test` after the LAST file touched — then verify
  LIVE against the running stack (dev routes, curl the pages). Never commit red.
- Every feature gets a dated why-first change note (Spanish) at the top of
  docs/DEV-SETUP.md §5.
- One commit per feature, message explains the why; multi-line messages via
  bash heredoc (`git commit -F - <<'MSG'`), never PowerShell. Push without
  being asked.
