/**
 * Deterministic message composition for seller outreach. No LLM anywhere:
 * drafts are assembled from the verdict's own open questions, so every
 * sentence is traceable to a rule. Tone is Wallapop chat (user feedback,
 * 2026-07-17): informal — no inverted ¿¡ marks, no bullet lists, varied
 * greetings/closings so consecutive messages don't end in the same word.
 * Variety is seeded, never random: same input, same draft, testable.
 */

/** Wallapop chat accepts long texts, but sellers don't read them. */
const MAX_OPENING_QUESTIONS = 3;

const GREETINGS = ["Hola", "Buenas"];
const OPENER_CLOSINGS = ["Gracias!", "Un saludo!", "Gracias de antemano!"];
const FOLLOWUP_INTROS = [
  "Gracias por responder!",
  "Genial, gracias por la info!",
  "Perfecto, gracias!",
];
const FOLLOWUP_CLOSINGS = ["Un saludo!", "Ya me dices, gracias!", "Mil gracias!"];

/** Stable pick from a pool: same seed, same choice — variety without RNG. */
function seedPick(options: string[], seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return options[h % options.length] as string;
}

/** First name if the display name starts with one ("Juan M." → "Juan"). */
function firstName(sellerName?: string): string | undefined {
  const token = sellerName?.trim().split(/\s+/)[0];
  return token && /^\p{L}{2,}$/u.test(token) ? token : undefined;
}

/** Informal question: no ¿¡, single spaces, capitalized, trailing ?. */
function asQuestion(q: string): string {
  let s = q.trim().replace(/[¿¡]/g, "").replace(/\s+/g, " ");
  if (!s) return s;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!s.endsWith("?")) s = `${s}?`;
  return s;
}

export interface OpeningMessageInput {
  /** Listing title — part of the variety seed so each lead reads different. */
  title: string;
  /** Seller display name; only a leading alphabetic first name is used. */
  sellerName?: string;
  /** Verdict open questions, already phrased for the seller, best first. */
  openQuestions: string[];
}

/**
 * The approval-gated opener: interest plus the verdict's top open questions,
 * one per line, no list markers. Deterministic on purpose — the user edits
 * the draft if they want color; the system never improvises on their behalf.
 */
export function composeOpeningMessage(input: OpeningMessageInput): string {
  const seed = `${input.title}|${input.sellerName ?? ""}`;
  const name = firstName(input.sellerName);
  const greeting = `${seedPick(GREETINGS, seed)}${name ? `, ${name}` : ""}!`;

  const questions = input.openQuestions
    .map(asQuestion)
    .filter(Boolean)
    .slice(0, MAX_OPENING_QUESTIONS);

  if (questions.length === 0) {
    // No open questions (fully verified unit): keep the opener meaningful.
    return `${greeting} Me interesa el coche, sigue disponible?`;
  }

  return [
    `${greeting} Me interesa el coche y quería preguntarte un par de cosas antes de verlo.`,
    ...questions,
    "",
    seedPick(OPENER_CLOSINGS, `${seed}|opener-closing`),
  ].join("\n");
}

const NUDGES = [
  "Buenas! Pudiste mirar lo que te pregunté?",
  "Hola! Le pudiste echar un ojo a lo que te comenté?",
  "Buenas! Sabes algo de lo del otro día?",
];

/**
 * Waiting on the seller: the only acceptable message is a gentle reminder —
 * never a new batch of questions on top of unanswered ones (user rule,
 * 2026-07-17). Seeded like everything else: same lead, same nudge.
 */
export function composeNudgeMessage(seed: string): string {
  return seedPick(NUDGES, `${seed}|nudge`);
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
 * when everything has been asked — no button, no empty nag. The seed shifts
 * with the conversation length so consecutive follow-ups vary.
 */
export function composeFollowUpMessage(input: FollowUpInput): string | null {
  // Strip ¿¡ on both sides: messages sent before the informal-tone change
  // carry the marks mid-sentence and must still count as asked.
  const asked = input.alreadyAsked.join("\n").toLowerCase().replace(/[¿¡]/g, "");
  const remaining = input.openQuestions
    .map(asQuestion)
    .filter((q) => q && !asked.includes(q.toLowerCase()))
    .slice(0, MAX_OPENING_QUESTIONS);
  if (remaining.length === 0) return null;

  const seed = `${asked.length}|${remaining[0] ?? ""}`;
  return [
    `${seedPick(FOLLOWUP_INTROS, seed)} Aprovecho y te pregunto alguna cosa más.`,
    ...remaining,
    "",
    seedPick(FOLLOWUP_CLOSINGS, `${seed}|followup-closing`),
  ].join("\n");
}
