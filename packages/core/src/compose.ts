/**
 * Deterministic message composition for seller outreach. No LLM anywhere:
 * drafts are assembled from the verdict's own open questions, so every
 * sentence is traceable to a rule. Tone is Wallapop chat (user feedback,
 * 2026-07-17): informal — no inverted ¿¡ marks, no bullet lists, varied
 * greetings/closings so consecutive messages don't end in the same word.
 * Variety is seeded, never random: same input, same draft, testable.
 */

import type { ConfidenceVerdict } from "./domain.js";

/**
 * Wallapop's chat composer is a <textarea maxlength="300"> (measured live,
 * 2026-07-17): anything longer gets silently cut — our first price proposal
 * lost its price line to this. Every composed message MUST fit, and the send
 * path refuses anything longer instead of truncating a human conversation.
 */
export const CHAT_MAX_CHARS = 300;

/** Wallapop chat accepts long texts, but sellers don't read them. */
const MAX_OPENING_QUESTIONS = 3;

const GREETINGS = ["Hola", "Buenas", "Qué tal"];
const INTEREST_LINES = [
  "Me interesa el coche y quería preguntarte un par de cosas antes de verlo.",
  "Me ha gustado bastante el anuncio y tengo un par de dudas.",
  "Estoy buscando uno así y el tuyo me encaja, te pregunto un par de cosas.",
  "Le tengo echado el ojo al coche, te importa que te pregunte un par de cosas?",
];
const AVAILABILITY_LINES = [
  "Me interesa el coche, sigue disponible?",
  "Me interesa el coche, lo tienes todavía?",
  "Me interesa, lo sigues vendiendo?",
];
const OPENER_CLOSINGS = [
  "Gracias!",
  "Un saludo!",
  "Gracias de antemano!",
  "Ya me cuentas, gracias!",
  "Cuando puedas me dices, gracias!",
];

// Follow-ups give feedback before asking more — a seller who only receives
// questions and zero reaction stops answering (user rule, 2026-07-17). The
// intro always thanks them; past the second reply the tone warms up and the
// closing points toward a visit, so the questions read as leading somewhere.
const FOLLOWUP_INTROS_EARLY = [
  "Gracias por responder, pinta bien!",
  "Genial, gracias por la info!",
  "Perfecto, gracias! Buena pinta.",
];
const FOLLOWUP_INTROS_WARM = [
  "Gracias! La verdad es que el coche me está convenciendo.",
  "Genial, me cuadra todo lo que me vas contando.",
  "Gracias por las respuestas, cada vez me interesa más.",
];
const FOLLOWUP_LINKS_ONE = [
  "Aprovecho y te pregunto una cosa más.",
  "Solo me queda una duda.",
  "Una última cosa.",
];
const FOLLOWUP_LINKS_MANY = [
  "Aprovecho y te pregunto un par de cosas más.",
  "Me quedan un par de dudas.",
  "Te pregunto un par de cosas más y no te doy más la lata.",
];
const FOLLOWUP_CLOSINGS_EARLY = ["Un saludo!", "Ya me dices, gracias!", "Mil gracias!"];
const FOLLOWUP_CLOSINGS_WARM = [
  "Si me encaja esto me animo a ir a verlo. Gracias!",
  "Con esto ya me decido y vemos cuándo puedo pasarme a verlo. Gracias!",
  "En cuanto me confirmes esto hablamos de verlo. Un saludo!",
];

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
    return `${greeting} ${seedPick(AVAILABILITY_LINES, `${seed}|availability`)}`;
  }

  // Fit the chat limit by dropping the LAST questions (they arrive best
  // first); the rest wait for the follow-up.
  const build = (qs: string[]): string =>
    [
      `${greeting} ${seedPick(INTEREST_LINES, `${seed}|interest`)}`,
      ...qs,
      "",
      seedPick(OPENER_CLOSINGS, `${seed}|opener-closing`),
    ].join("\n");
  let kept = questions;
  let msg = build(kept);
  while (msg.length > CHAT_MAX_CHARS && kept.length > 1) {
    kept = kept.slice(0, -1);
    msg = build(kept);
  }
  return msg;
}

/**
 * One-phrase triage for emails: with many candidates arriving, the reader
 * needs an instant "pursue this or wait for the next one". Deterministic
 * from the verdict — grade decides the posture, worst-case-over-budget
 * softens a C into a conditional.
 */
export function composeTriageLine(verdict: ConfidenceVerdict): string {
  if (verdict.vetoes?.length) {
    return "Descártalo: hay vetos activos (posible estafa o fallo crítico confirmado).";
  }
  const exposure = verdict.repairExposureEur;
  const exposureTxt = exposure
    ? ` (~${exposure.min.toLocaleString("es-ES")}–${exposure.max.toLocaleString("es-ES")} € en juego)`
    : "";
  switch (verdict.overall) {
    case "A":
      return "Candidato excelente: contacta hoy mismo — así salen muy pocos.";
    case "B":
      return "Buen candidato: merece escribir al vendedor ya y empezar a verificar.";
    case "C":
      // The worst-case-over-budget phrasing is set in evaluate.ts; its
      // presence marks the leads where the gamble outgrows the wallet.
      return verdict.budgetNote?.includes("por encima de tu presupuesto")
        ? `Solo sigue si el vendedor va descartando riesgos${exposureTxt}; si no responde claro, espera otro.`
        : "Candidato razonable: un par de preguntas al vendedor lo confirman o lo descartan.";
    case "D":
      return "Flojo: no inviertas tiempo salvo bajada fuerte de precio.";
    case "E":
      return "Malo: pasa de este y espera al siguiente.";
  }
}

const NUDGES = [
  "Buenas! Pudiste mirar lo que te pregunté?",
  "Hola! Le pudiste echar un ojo a lo que te comenté?",
  "Buenas! Sabes algo de lo del otro día?",
  "Hola! Sigo interesado en el coche, cuando puedas me cuentas.",
  "Buenas! Qué tal, pudiste ver lo que te comentaba?",
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
  /** Seller replies received so far — interest warms up as they answer. */
  sellerReplies?: number;
  /**
   * When a price offer is justified, it merges into the follow-up: the
   * closing becomes the proposal, so we never promise a visit or a decision
   * BEFORE negotiating — the visit is offered contingent on the number.
   */
  offer?: Omit<OfferMessageInput, "seed">;
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
  const remainingAll = input.openQuestions
    .map(asQuestion)
    .filter((q) => q && !asked.includes(q.toLowerCase()));
  const remaining = remainingAll.slice(0, MAX_OPENING_QUESTIONS);
  if (remaining.length === 0) return null;

  const replies = input.sellerReplies ?? 0;
  const warm = replies >= 2;
  const seed = `${asked.length}|${replies}|${remaining[0] ?? ""}`;
  const intro = seedPick(warm ? FOLLOWUP_INTROS_WARM : FOLLOWUP_INTROS_EARLY, seed);
  const link = seedPick(remaining.length === 1 ? FOLLOWUP_LINKS_ONE : FOLLOWUP_LINKS_MANY, `${seed}|link`);

  // A justified offer replaces the closing — but only once the conversation
  // is warm AND this batch asks the LAST remaining questions: anchoring a
  // price mid-interrogation is premature, and promising a visit before
  // negotiating gives the leverage away. "Me acerco a verlo" only ever
  // appears contingent on the number. The compact→minimal→bare ladder keeps
  // the PRICE inside the chat limit — the number is the one part that must
  // never be the part that gets cut.
  const lastBatch = remainingAll.length <= MAX_OPENING_QUESTIONS;
  if (input.offer && warm && lastBatch) {
    for (const level of ["compact", "minimal", "bare"] as const) {
      const offerPart = composeOfferClosing(input.offer, seed, level);
      if (!offerPart) break; // nothing to negotiate after all
      const msg = [`${intro} ${link}`, ...remaining, "", offerPart].join("\n");
      if (msg.length <= CHAT_MAX_CHARS) return msg;
    }
    // Even bare doesn't fit (many long questions): ask now, offer next turn.
  }

  // Visit-promising warm closings ("con esto ya me decido y me paso a
  // verlo") only when there is NOTHING to negotiate: with an offer pending,
  // announcing the visit first would concede the price.
  const closing = seedPick(
    warm && !input.offer ? FOLLOWUP_CLOSINGS_WARM : FOLLOWUP_CLOSINGS_EARLY,
    `${seed}|followup-closing`,
  );
  const build = (qs: string[]): string => {
    const l = seedPick(qs.length === 1 ? FOLLOWUP_LINKS_ONE : FOLLOWUP_LINKS_MANY, `${seed}|link`);
    return [`${intro} ${l}`, ...qs, "", closing].join("\n");
  };
  let kept = remaining;
  let msg = build(kept);
  while (msg.length > CHAT_MAX_CHARS && kept.length > 1) {
    kept = kept.slice(0, -1);
    msg = build(kept);
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Price proposal — negotiate when the data says so
// ---------------------------------------------------------------------------

export interface OfferInput {
  /** What the seller asks (cash price when it differs from the listed one). */
  askingPriceEur: number;
  /** The user's hard cap — the offer NEVER exceeds it (hard limit, not vibes). */
  maxBudgetEur: number;
  /** Un-ruled-out repair exposure from the verdict, if any. */
  repairExposureEur?: { min: number; max: number };
}

/**
 * The number we put on the table, or null when there is nothing to negotiate
 * (asking already at or under what the data supports). Deterministic: start
 * from the asking price, ask the seller to absorb half the EXPECTED repairs
 * (midpoint of the exposure band), cap at the user's budget, round down to
 * hundreds, and never go under 80% of asking — lowballs end conversations.
 */
export function computeOfferEur(input: OfferInput): number | null {
  const mid = input.repairExposureEur
    ? (input.repairExposureEur.min + input.repairExposureEur.max) / 2
    : 0;
  let offer = Math.min(input.askingPriceEur - Math.round(mid / 2), input.maxBudgetEur);
  offer = Math.floor(offer / 100) * 100;
  const floor = Math.ceil((input.askingPriceEur * 0.8) / 100) * 100;
  if (offer < floor) offer = Math.min(floor, input.maxBudgetEur);
  return offer >= input.askingPriceEur ? null : offer;
}

export interface CounterInput {
  /** The last number we put on the table. */
  ourLastOfferEur: number;
  /** The seller's counter. */
  sellerCounterEur: number;
  /** The user's hard cap — accept/counter NEVER exceeds it. */
  maxBudgetEur: number;
}

export type CounterDecision =
  | { action: "accept"; priceEur: number }
  | { action: "counter"; priceEur: number }
  | { action: "stand"; priceEur: number };

/**
 * Answer a seller's counter-offer, deterministically. Accept when they came
 * down to (or under) something we can call a win: at/below our number, or
 * within one small step (≤300 €) of it while under budget. Otherwise split
 * the difference, rounded to hundreds and hard-capped at the budget; if the
 * split can't improve on our last number (their counter above budget with no
 * room left), stand on what we already offered. The model never chooses
 * these numbers — a charming seller cannot talk code up.
 */
export function respondToCounterEur(input: CounterInput): CounterDecision {
  const { ourLastOfferEur: ours, sellerCounterEur: theirs, maxBudgetEur: cap } = input;
  if (theirs <= ours) return { action: "accept", priceEur: theirs };
  if (theirs <= cap && theirs - ours <= 300) return { action: "accept", priceEur: theirs };

  const split = Math.min(Math.round((ours + theirs) / 2 / 100) * 100, cap);
  if (split <= ours) return { action: "stand", priceEur: ours };
  return { action: "counter", priceEur: Math.min(split, theirs) };
}

const ACCEPT_LINES = [
  "Venga, hecho: {price} € y nos lo quedamos. Cuándo te viene bien que me pase a verlo?",
  "Trato hecho en {price} €. Dime cuándo puedo pasarme a verlo y lo cerramos.",
  "Vale, {price} € me cuadra. Cuándo podría ir a verlo?",
];
const COUNTER_LINES = [
  "Te entiendo, pero con lo pendiente aún me queda margen que cubrir. Nos vemos en {price} € y voy a verlo con la factura delante. Te va?",
  "Uf, es que ahí no me salen los números con lo que hay que repasar. Lo dejamos en {price} € y me acerco a verlo. Cómo lo ves?",
  "Casi! Por lo que tendría que meterle, {price} € es donde puedo llegar. Si te vale, me paso a verlo cuando digas.",
];
const STAND_LINES = [
  "Lo siento pero no me salen los números por encima de lo que te dije: {price} € es mi tope de verdad. Si te encaja, me acerco a verlo cuando quieras.",
  "Te entiendo, pero mi máximo real son los {price} € que te decía. Ahí lo dejo por si te cuadra, y voy a verlo cuando te venga bien.",
];

/**
 * Deterministic reply to a counter-offer — the fallback when no LLM drafts
 * the prose (and the guarantee that the NUMBER always comes from code).
 * Accepting may finally promise the visit: the deal is done.
 */
export function composeCounterReply(input: CounterInput & { seed: string }): string {
  const decision = respondToCounterEur(input);
  const pool =
    decision.action === "accept" ? ACCEPT_LINES : decision.action === "counter" ? COUNTER_LINES : STAND_LINES;
  return seedPick(pool, `${input.seed}|counter|${decision.priceEur}`).replace(
    "{price}",
    decision.priceEur.toLocaleString("es-ES"),
  );
}

const OFFER_INTROS = [
  "Gracias por contestar a todo! La verdad es que el coche me encaja.",
  "Pues con todo lo que me has contado el coche me convence.",
  "Oye, gracias por las respuestas. El coche me gusta y me lo pienso en serio.",
];
const OFFER_LINES = [
  "Yo te podría ofrecer {price} €. Lo ves posible?",
  "Si nos cuadra en {price} € me acerco a verlo y lo cerramos. Qué te parece?",
  "Te propongo {price} € y por mi parte trato hecho. Cómo lo ves?",
];

/** "Marca: defecto → consecuencia" risk titles read badly in chat — keep the defect. */
function shortRisk(title: string): string {
  const afterColon = title.includes(":") ? (title.split(":")[1] ?? title) : title;
  const beforeArrow = afterColon.split("→")[0] ?? afterColon;
  const s = beforeArrow.trim();
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export interface OfferMessageInput extends OfferInput {
  /** Titles of still-unconfirmed tracked risks — they justify the number. */
  pendingRisks?: string[];
  /** Variety seed (lead id). */
  seed: string;
}

/**
 * The justification for the number, at three lengths: "full" spells out the
 * risks and who pays, "compact" keeps the risk list, "minimal" keeps only
 * the cost band — the ladder the composers descend to fit CHAT_MAX_CHARS.
 */
function offerWhy(
  input: Omit<OfferMessageInput, "seed">,
  level: "full" | "compact" | "minimal",
): string {
  const risks = (input.pendingRisks ?? []).map(shortRisk).slice(0, 2);
  const exposure = input.repairExposureEur;
  const overBudget = input.askingPriceEur > input.maxBudgetEur;

  if (risks.length > 0 && exposure) {
    const list = risks.join(" y ");
    const band = `entre ${exposure.min.toLocaleString("es-ES")} y ${exposure.max.toLocaleString("es-ES")} €`;
    if (level === "full")
      return `Lo único que me frena es lo que queda sin comprobar (${list}): por lo que suele costar arreglarlo hablamos de ${band} que tendría que asumir yo.`;
    if (level === "compact")
      return `Eso sí, con lo que queda sin comprobar (${list}) me tocaría asumir ${band} de posibles arreglos.`;
    return `Eso sí, con lo pendiente de comprobar tendría que asumir ${band} en arreglos.`;
  }
  if (overBudget) {
    const asking = input.askingPriceEur.toLocaleString("es-ES");
    if (level === "full") return `Lo único es que ${asking} € se me va de lo que tenía pensado gastarme.`;
    if (level === "compact") return `Eso sí, ${asking} € se me va un poco de lo que tenía pensado.`;
    return "Eso sí, se me va un poco de presupuesto.";
  }
  return level === "full" ? "Le he echado números con calma para dejarlo a punto." : "";
}

/**
 * Offer paragraph used as the CLOSING of a follow-up: justification plus the
 * number, visit only contingent on it. "bare" drops the justification — the
 * price line is the one part that must NEVER be cut. Null when there is
 * nothing to negotiate.
 */
function composeOfferClosing(
  input: Omit<OfferMessageInput, "seed">,
  seed: string,
  level: "compact" | "minimal" | "bare",
): string | null {
  const offer = computeOfferEur(input);
  if (offer === null) return null;
  const line = seedPick(OFFER_LINES, `${seed}|offer|${offer}`).replace(
    "{price}",
    offer.toLocaleString("es-ES"),
  );
  const why = level === "bare" ? "" : offerWhy(input, level);
  return why ? `${why} ${line}` : line;
}

/**
 * A data-justified price proposal for when every question has been asked and
 * the conversation is warm: state what the car has going for it, name what is
 * still unverified and what it costs to fix, and put a number on the table —
 * always inside the user's budget. Null when there is nothing to negotiate.
 */
export function composeOfferMessage(input: OfferMessageInput): string | null {
  const offer = computeOfferEur(input);
  if (offer === null) return null;

  const seed = `${input.seed}|offer|${offer}`;
  const offerLine = seedPick(OFFER_LINES, seed).replace(
    "{price}",
    offer.toLocaleString("es-ES"),
  );
  const intro = seedPick(OFFER_INTROS, `${seed}|intro`);
  // Longest justification that still fits the chat limit; the price line is
  // sacred, the "why" is what shrinks.
  for (const level of ["full", "compact", "minimal"] as const) {
    const why = offerWhy(input, level);
    const msg = [why ? `${intro} ${why}` : intro, "", offerLine].join("\n");
    if (msg.length <= CHAT_MAX_CHARS) return msg;
  }
  return [intro, "", offerLine].join("\n");
}
