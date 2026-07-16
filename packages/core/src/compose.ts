/**
 * Deterministic message composition for seller outreach. No LLM anywhere:
 * the opener is assembled from the verdict's own open questions, so every
 * sentence is traceable to a rule. Drafts are Spanish, short and polite —
 * Wallapop chat culture punishes walls of text.
 */

/** Wallapop chat accepts long texts, but sellers don't read them. */
const MAX_OPENING_QUESTIONS = 3;

export interface OpeningMessageInput {
  /** Listing title, used to name the car naturally ("el Golf", fallback "el coche"). */
  title: string;
  /** Seller display name; only a leading alphabetic first name is used. */
  sellerName?: string;
  /** Verdict open questions, already phrased for the seller, best first. */
  openQuestions: string[];
}

/** First name if the display name starts with one ("Juan M." → "Juan"). */
function firstName(sellerName?: string): string | undefined {
  const token = sellerName?.trim().split(/\s+/)[0];
  return token && /^\p{L}{2,}$/u.test(token) ? token : undefined;
}

/** Ensure a question reads as one: trim, capitalize, wrap in ¿? if missing. */
function asQuestion(q: string): string {
  let s = q.trim().replace(/\s+/g, " ");
  if (!s) return s;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!s.endsWith("?")) s = `${s}?`;
  if (!s.startsWith("¿")) s = `¿${s}`;
  return s;
}

/**
 * The approval-gated opener: availability check plus the verdict's top open
 * questions. Deterministic on purpose — the user edits the draft if they want
 * color; the system never improvises on their behalf.
 */
export function composeOpeningMessage(input: OpeningMessageInput): string {
  const name = firstName(input.sellerName);
  const greeting = name ? `Hola, ${name}:` : "Hola:";

  const questions = input.openQuestions
    .map(asQuestion)
    .filter(Boolean)
    .slice(0, MAX_OPENING_QUESTIONS);

  const lines = [
    greeting,
    "",
    "Me interesa el coche y me gustaría hacerte alguna pregunta antes de verlo:",
    ...questions.map((q) => `- ${q}`),
  ];
  if (questions.length === 0) {
    // No open questions (fully verified unit): keep the opener meaningful.
    lines[2] = "Me interesa el coche. ¿Sigue disponible?";
  } else {
    // No "¿sigue disponible?" here: the questions already presuppose it,
    // and asking both reads redundant (user feedback, 2026-07-16).
    lines.push("", "¡Gracias!");
  }
  return lines.join("\n");
}

export interface FollowUpInput {
  /** Verdict open questions, best first. */
  openQuestions: string[];
  /** Bodies of outbound messages already sent/queued — never re-ask these. */
  alreadyAsked: string[];
}

/**
 * Mid-conversation follow-up: the open questions not yet put to the seller,
 * as a pre-filled suggestion the user edits before sending. Returns null
 * when everything has been asked — no button, no empty nag.
 */
export function composeFollowUpMessage(input: FollowUpInput): string | null {
  const asked = input.alreadyAsked.join("\n").toLowerCase();
  const remaining = input.openQuestions
    .map(asQuestion)
    .filter((q) => q && !asked.includes(q.toLowerCase()))
    .slice(0, MAX_OPENING_QUESTIONS);
  if (remaining.length === 0) return null;

  return [
    "Gracias por la respuesta. Aprovecho para preguntarte alguna cosa más:",
    ...remaining.map((q) => `- ${q}`),
    "",
    "¡Gracias!",
  ].join("\n");
}
