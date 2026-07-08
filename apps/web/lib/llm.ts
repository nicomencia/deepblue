/**
 * Claude API access for the Core. Vendor SDK stays out of packages/core
 * (ports and adapters); the key stays server-side. Without ANTHROPIC_API_KEY
 * every LLM feature degrades gracefully and says why instead of crashing.
 */

import Anthropic from "@anthropic-ai/sdk";

/** Dossier research wants the strongest model; both overridable per env. */
export const DOSSIER_MODEL = process.env.DEEPBLUE_DOSSIER_MODEL ?? "claude-opus-4-8";
export const ENRICH_MODEL = process.env.DEEPBLUE_ENRICH_MODEL ?? "claude-opus-4-8";

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
