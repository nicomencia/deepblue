/**
 * Claude API access for the Core. Vendor SDK stays out of packages/core
 * (ports and adapters); the key stays server-side. Without ANTHROPIC_API_KEY
 * every LLM feature degrades gracefully and says why instead of crashing.
 */

import Anthropic from "@anthropic-ai/sdk";

/** Dossier research wants the strongest model; all overridable per env. */
export const DOSSIER_MODEL = process.env.DEEPBLUE_DOSSIER_MODEL ?? "claude-opus-4-8";
export const ENRICH_MODEL = process.env.DEEPBLUE_ENRICH_MODEL ?? "claude-opus-4-8";
/**
 * Conversation readings get their own dial: tiny volume, highest stakes
 * (issue rulings move repair exposure and therefore the euros we offer;
 * escalation detection is a safety net) — downgrade with care.
 */
export const READS_MODEL = process.env.DEEPBLUE_READS_MODEL ?? "claude-opus-4-8";
export const DISCOVERY_MODEL = process.env.DEEPBLUE_DISCOVERY_MODEL ?? "claude-opus-4-8";

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

/** Concatenated text blocks of a response — with structured outputs, pure JSON. */
export function messageText(msg: Anthropic.Message): string {
  return msg.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
