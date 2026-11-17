/**
 * Claude API access for the Core. Vendor SDK stays out of packages/core
 * (ports and adapters); the key stays server-side. Without ANTHROPIC_API_KEY
 * every LLM feature degrades gracefully and says why instead of crashing.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * One model per lane, each the newest of its family (checked against
 * /v1/models 2026-11-17). Pinned on purpose, never a moving alias: each new
 * version has changed something the code relies on (Opus 5.5's effort default,
 * Haiku 4.5 rejecting `effort`), so a version bump is a measured change, not a
 * silent one.
 *
 *  - Research (dossier, discovery): Opus 5.5 — its claims ARE the product.
 *  - Reading (ad enrichment, chat readings): Sonnet 5.5. Measured against
 *    Opus 5.5 and Haiku 5.5 on 10 real leads (DEV-SETUP §5, cambio 39):
 *    same direction as Opus on almost every adjustment at a third of the
 *    cost; Haiku marked down exactly the ads with documented history.
 *  - Prose (DRAFT_MODEL, in draft-message.ts): Haiku 5.5 — writing is not
 *    judging, and code decides the content.
 *
 * All overridable by env, which is the way to try a model without touching
 * code. Every judgement lane sets its effort explicitly.
 */
export const DOSSIER_MODEL = process.env.DEEPBLUE_DOSSIER_MODEL ?? "claude-opus-5-5";
export const ENRICH_MODEL = process.env.DEEPBLUE_ENRICH_MODEL ?? "claude-sonnet-5-5";
/**
 * Conversation readings get their own dial: tiny volume, highest stakes
 * (issue rulings move repair exposure and therefore the euros we offer;
 * escalation detection is a safety net) — downgrade with care.
 */
export const READS_MODEL = process.env.DEEPBLUE_READS_MODEL ?? "claude-sonnet-5-5";
export const DISCOVERY_MODEL = process.env.DEEPBLUE_DISCOVERY_MODEL ?? "claude-opus-5-5";

/**
 * Server-side refusal fallback for the judgement lanes. A safety classifier
 * can decline a benign request (a 200 with `stop_reason: "refusal"`); with
 * this the API re-runs it on the previous model inside the same call instead
 * of losing that lead's reading. Which form is valid depends on the model, and
 * since every lane is env-configurable it is chosen from the model in effect:
 * Opus 5.5 takes an explicit list (its allowed targets, read from /v1/models:
 * claude-opus-5 and claude-opus-4-8 — Opus 5 is the shape these lanes ran on),
 * Sonnet 5.5 only the "default" routing form, and Haiku has no fallback at all
 * (a list there is a 400).
 */
export function refusalFallback(model: string): {
  betas: Anthropic.Beta.AnthropicBeta[];
  fallbacks?: Anthropic.Beta.Messages.BetaFallbackParam[];
} {
  if (model === "claude-opus-5-5") {
    return { betas: ["server-side-fallback-2026-06-01"], fallbacks: [{ model: "claude-opus-5" }] };
  }
  if (model === "claude-sonnet-5-5") {
    // SDK 0.110 only types the list form; the wire accepts the scalar.
    const fallbacks = "default" as unknown as Anthropic.Beta.Messages.BetaFallbackParam[];
    return { betas: ["server-side-fallback-2026-07-01"], fallbacks };
  }
  return { betas: [] };
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// One client per process (HMR-safe, same trick as lib/db.ts).
const g = globalThis as typeof globalThis & { __deepblueAnthropic?: Anthropic };

export function getAnthropic(): Anthropic {
  if (!isLlmConfigured()) {
    throw new Error(
      "ANTHROPIC_API_KEY no configurada — añádela a apps/web/.env.local para activar las funciones LLM",
    );
  }
  // Dossier research (web search + long output) can take several minutes.
  g.__deepblueAnthropic ??= new Anthropic({ timeout: 15 * 60 * 1000 });
  return g.__deepblueAnthropic;
}

/**
 * Concatenated text blocks of a response — with structured outputs, pure JSON.
 * A refusal (when the whole fallback chain declined) throws a clear error
 * instead of handing the caller an empty string to fail a JSON parse on.
 */
export function messageText(msg: Anthropic.Message | Anthropic.Beta.Messages.BetaMessage): string {
  if (msg.stop_reason === "refusal") {
    const category = msg.stop_details?.category ?? "sin categoría";
    throw new Error(`${msg.model} declinó la petición (${category})`);
  }
  return msg.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}
