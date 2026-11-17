/**
 * LLM prose lane for seller messages: a cheap model (Haiku) writes the words,
 * deterministic code decides the CONTENT — which questions, whether to
 * negotiate, and above all the exact number (respondToCounterEur/
 * computeOfferEur, hard-capped at the brief's budget). The draft is validated
 * in code: it must contain the exact price when one is mandated, fit
 * Wallapop's 300-char composer, and respect the informal-tone rules. Any
 * violation (or a missing API key) falls back to the deterministic composer,
 * so the system never depends on the model behaving.
 *
 * Questions are not the model's to write. When the base draft carries verdict
 * questions, the model only writes the opening line and the closing; code
 * puts the questions between them exactly as ranked and budgeted. Before
 * this, the model rewrote the whole message and nothing checked the
 * questions: it could reword the timing-chain question into something vaguer,
 * drop it for length, or add one of its own (2026-11-17).
 */

import { CHAT_MAX_CHARS } from "@deepblue/core";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { getAnthropic, isLlmConfigured, messageText } from "./llm";

export const DRAFT_MODEL = process.env.DEEPBLUE_DRAFT_MODEL ?? "claude-haiku-5-5";
/**
 * `effort` only where the model takes it. Haiku 4.5 answers it with a 400
 * ("does not support the effort parameter"), and with DEEPBLUE_DRAFT_MODEL
 * pinned to it in .env.local every draft fell back to the template, silently,
 * from the day effort was added (cambio 24) until 2026-11-17. Haiku 5.5
 * thinks by default; there `low` keeps the thinking short.
 */
const effort = (model: string): { effort?: "low" } =>
  /haiku-4/.test(model) ? {} : { effort: "low" };

/** A fallback that nobody sees is how this lane stayed broken for months. */
function logFallback(why: unknown): void {
  console.warn(
    `[draft] ${DRAFT_MODEL} no usado, va el borrador determinista: ${why instanceof Error ? why.message : String(why)}`,
  );
}

const draftSchema = z.object({ message: z.string() });
/** Framing only: the questions are inserted by code between the two. */
const framingSchema = z.object({ intro: z.string(), closing: z.string() });

export interface DraftRequest {
  /** Listing headline for context. */
  title: string;
  /** Chronological transcript, "COMPRADOR:"/"VENDEDOR:" prefixed. */
  transcript: string;
  /** What the message must accomplish, in Spanish (from the suggestion cascade). */
  intent: string;
  /** The deterministic fallback — also shown to the model as a base draft. */
  fallback: string;
  /** Exact price that MUST appear (es-ES formatted), when negotiating. */
  mustContainPrice?: string;
  /**
   * The verdict questions inside `fallback`, verbatim (questionLinesOf). When
   * present, the model writes only the framing and these go in untouched.
   */
  questions?: string[];
}

/** Shared rules for both modes; `scope` says what the model is writing. */
function rules(req: DraftRequest, scope: string): string[] {
  return [
    "Reglas ESTRICTAS:",
    `- ${scope}`,
    "- Tono informal español de chat: nada de ¿ ni ¡, sin listas con guiones, sin párrafos largos.",
    req.mustContainPrice
      ? `- El precio "${req.mustContainPrice} €" debe aparecer EXACTAMENTE así — no lo cambies ni lo redondees.`
      : "- No menciones ningún precio nuevo que no esté en el borrador base.",
    "- No prometas visita incondicional si el objetivo es negociar: la visita solo condicionada al precio.",
    "- No inventes datos del coche que no estén en la conversación.",
    "- NUNCA afirmes disponibilidad ni planes del comprador (días, fines de semana, horarios): no los conoces. Para la visita, pide opciones al vendedor y ya confirmará el comprador.",
    "- Responde a lo último que dijo el vendedor de forma natural (que no parezca un robot).",
  ];
}

/** Framing mode: the model writes the line before the questions and the one after. */
function framingPrompt(req: DraftRequest, questions: string[]): string {
  return [
    "Eres el comprador en un chat de Wallapop interesado en un coche de segunda mano.",
    `Anuncio: ${req.title}`,
    "",
    "CONVERSACIÓN hasta ahora:",
    req.transcript || "(ninguna: es el primer mensaje)",
    "",
    `OBJETIVO del siguiente mensaje: ${req.intent}`,
    "",
    "El mensaje tendrá esta forma, y las PREGUNTAS ya están escritas y no se tocan:",
    "[intro]",
    ...questions,
    "",
    "[closing]",
    "",
    "BORRADOR BASE completo, como referencia del tono y de lo que dice el cierre:",
    req.fallback,
    "",
    "Escribe SOLO `intro` (saludo y una frase que lleve a las preguntas) y `closing`",
    "(despedida; si el borrador base pide visita o propone un precio, el cierre",
    "también). No repitas ni reformules las preguntas, y no añadas preguntas nuevas.",
    "",
    ...rules(
      req,
      `El mensaje entero, con las preguntas, no puede pasar de ${CHAT_MAX_CHARS} caracteres: intro y cierre cortos.`,
    ),
  ].join("\n");
}

function prompt(req: DraftRequest): string {
  return [
    "Eres el comprador en un chat de Wallapop negociando un coche de segunda mano.",
    `Anuncio: ${req.title}`,
    "",
    "CONVERSACIÓN hasta ahora:",
    req.transcript,
    "",
    `OBJETIVO del siguiente mensaje: ${req.intent}`,
    "",
    "BORRADOR BASE (puedes mejorarlo, no cambiar lo que dice):",
    req.fallback,
    "",
    ...rules(req, `Máximo ${CHAT_MAX_CHARS} caracteres (el chat corta el resto). No añadas preguntas que no estén en el borrador base.`),
  ].join("\n");
}

const questionMarks = (s: string): number => (s.match(/\?/g) ?? []).length;

/**
 * The buyer's schedule is unknown to the model — a draft asserting it
 * ("tengo disponibilidad el fin de semana") invents a personal fact. Any of
 * these appearing in the draft without being in the deterministic base
 * invalidates it.
 */
const AVAILABILITY_CLAIMS =
  /disponibilidad|fin de semana|lunes|martes|miércoles|jueves|viernes|sábado|domingo|esta (semana|tarde|mañana)|hoy mismo|por la (mañana|tarde|noche)/i;

/** Code-side validation — the model is helpful, never trusted. */
function isValidDraft(text: string, req: DraftRequest): boolean {
  if (!text.trim() || text.length > CHAT_MAX_CHARS) return false;
  if (/[¿¡]/.test(text)) return false;
  if (/^- /m.test(text)) return false;
  if (req.mustContainPrice && !text.includes(req.mustContainPrice)) return false;
  if (AVAILABILITY_CLAIMS.test(text) && !AVAILABILITY_CLAIMS.test(req.fallback)) return false;
  // No stray euro amounts beyond what the base draft mentions: the model
  // must not introduce numbers code didn't decide.
  const allowed = new Set([...req.fallback.matchAll(/([\d.]+)\s*€/g)].map((m) => m[1]));
  for (const m of text.matchAll(/([\d.]+)\s*€/g)) {
    if (!allowed.has(m[1] ?? "")) return false;
  }
  // No questions code didn't decide: never more question marks than the base.
  if (questionMarks(text) > questionMarks(req.fallback)) return false;
  return true;
}

/**
 * Framing mode's own check, on top of isValidDraft for the assembled text:
 * the intro and closing must not smuggle in questions. The closing may ask
 * only if the base draft's closing did (a visit slot: "cuándo podría ir?").
 */
function isValidFraming(intro: string, closing: string, req: DraftRequest, questions: string[]): boolean {
  if (!intro.trim() || !closing.trim()) return false;
  if (/\n/.test(intro) || /\n\s*\n/.test(closing)) return false;
  const baseFraming = req.fallback
    .split("\n")
    .filter((l) => !questions.includes(l))
    .join("\n");
  return questionMarks(intro) + questionMarks(closing) <= questionMarks(baseFraming);
}

/**
 * Draft the message with the cheap model; on any failure — no key, API error,
 * invalid output — return the deterministic fallback unchanged. Callers never
 * need to care which path produced the text.
 */
export async function draftSellerProse(req: DraftRequest): Promise<{ text: string; model: string }> {
  if (!isLlmConfigured()) return { text: req.fallback, model: "deterministic" };
  if (req.questions?.length) return draftFraming(req, req.questions);
  try {
    const client = getAnthropic();
    // Haiku 5.5 thinks by default and the thinking counts against the cap:
    // `low` keeps it short, the cap leaves room for it plus a ≤300-char reply.
    const msg = await client.messages.create({
      model: DRAFT_MODEL,
      max_tokens: 2_000,
      output_config: { ...effort(DRAFT_MODEL), format: zodOutputFormat(draftSchema) },
      messages: [{ role: "user", content: prompt(req) }],
    });
    const { message } = draftSchema.parse(JSON.parse(messageText(msg)));
    const text = message.trim();
    if (isValidDraft(text, req)) return { text, model: DRAFT_MODEL };
    logFallback(`borrador rechazado por las validaciones: ${JSON.stringify(text).slice(0, 200)}`);
    return { text: req.fallback, model: "deterministic" };
  } catch (err) {
    logFallback(err);
    return { text: req.fallback, model: "deterministic" };
  }
}

/**
 * Framing mode: the model writes intro + closing, code assembles the message
 * with the questions verbatim in between. Same fallback contract: any
 * failure or violation returns the deterministic draft unchanged.
 */
async function draftFraming(
  req: DraftRequest,
  questions: string[],
): Promise<{ text: string; model: string }> {
  try {
    const msg = await getAnthropic().messages.create({
      model: DRAFT_MODEL,
      max_tokens: 2_000,
      output_config: { ...effort(DRAFT_MODEL), format: zodOutputFormat(framingSchema) },
      messages: [{ role: "user", content: framingPrompt(req, questions) }],
    });
    const { intro, closing } = framingSchema.parse(JSON.parse(messageText(msg)));
    const text = [intro.trim(), ...questions, "", closing.trim()].join("\n");
    if (isValidFraming(intro, closing, req, questions) && isValidDraft(text, req)) return { text, model: DRAFT_MODEL };
    logFallback(`borrador rechazado por las validaciones: ${JSON.stringify(text).slice(0, 200)}`);
    return { text: req.fallback, model: "deterministic" };
  } catch (err) {
    logFallback(err);
    return { text: req.fallback, model: "deterministic" };
  }
}
