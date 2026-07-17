/**
 * Deterministic message composition for seller outreach. No LLM anywhere:
 * drafts are assembled from the verdict's own open questions, so every
 * sentence is traceable to a rule. Tone is Wallapop chat (user feedback,
 * 2026-07-17): informal — no inverted ¿¡ marks, no bullet lists, varied
 * greetings/closings so consecutive messages don't end in the same word.
 * Variety is seeded, never random: same input, same draft, testable.
 */

import type { ConfidenceVerdict } from "./domain.js";

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

  return [
    `${greeting} ${seedPick(INTEREST_LINES, `${seed}|interest`)}`,
    ...questions,
    "",
    seedPick(OPENER_CLOSINGS, `${seed}|opener-closing`),
  ].join("\n");
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
  // appears contingent on the number.
  const lastBatch = remainingAll.length <= MAX_OPENING_QUESTIONS;
  const offerPart =
    input.offer && warm && lastBatch ? composeOfferClosing(input.offer, seed) : null;
  if (offerPart) return [`${intro} ${link}`, ...remaining, "", offerPart].join("\n");

  // Visit-promising warm closings ("con esto ya me decido y me paso a
  // verlo") only when there is NOTHING to negotiate: with an offer pending,
  // announcing the visit first would concede the price.
  const closing = seedPick(
    warm && !input.offer ? FOLLOWUP_CLOSINGS_WARM : FOLLOWUP_CLOSINGS_EARLY,
    `${seed}|followup-closing`,
  );
  return [`${intro} ${link}`, ...remaining, "", closing].join("\n");
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

/** The justification for the number, from the data at hand. */
function offerWhy(input: Omit<OfferMessageInput, "seed">, compact: boolean): string {
  const risks = (input.pendingRisks ?? []).map(shortRisk).slice(0, 2);
  const exposure = input.repairExposureEur;
  const overBudget = input.askingPriceEur > input.maxBudgetEur;

  if (risks.length > 0 && exposure) {
    const list = risks.join(" y ");
    const band = `entre ${exposure.min.toLocaleString("es-ES")} y ${exposure.max.toLocaleString("es-ES")} €`;
    return compact
      ? `Eso sí, con lo que queda sin comprobar (${list}) me tocaría asumir ${band} de posibles arreglos.`
      : `Lo único que me frena es lo que queda sin comprobar (${list}): por lo que suele costar arreglarlo hablamos de ${band} que tendría que asumir yo.`;
  }
  if (overBudget) {
    const asking = input.askingPriceEur.toLocaleString("es-ES");
    return compact
      ? `Eso sí, ${asking} € se me va un poco de lo que tenía pensado.`
      : `Lo único es que ${asking} € se me va de lo que tenía pensado gastarme.`;
  }
  return compact ? "" : "Le he echado números con calma para dejarlo a punto.";
}

/**
 * Compact offer paragraph used as the CLOSING of a follow-up: justification
 * plus the number, visit only contingent on it. Null when there is nothing
 * to negotiate.
 */
function composeOfferClosing(input: Omit<OfferMessageInput, "seed">, seed: string): string | null {
  const offer = computeOfferEur(input);
  if (offer === null) return null;
  const why = offerWhy(input, true);
  const line = seedPick(OFFER_LINES, `${seed}|offer|${offer}`).replace(
    "{price}",
    offer.toLocaleString("es-ES"),
  );
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
  return [`${seedPick(OFFER_INTROS, `${seed}|intro`)} ${offerWhy(input, false)}`, "", offerLine].join(
    "\n",
  );
}
