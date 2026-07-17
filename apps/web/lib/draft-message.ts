/**
 * LLM prose lane for seller messages: a cheap model (Haiku) writes the words,
 * deterministic code decides the CONTENT — which questions, whether to
 * negotiate, and above all the exact number (respondToCounterEur/
 * computeOfferEur, hard-capped at the brief's budget). The draft is validated
 * in code: it must contain the exact price when one is mandated, fit
 * Wallapop's 300-char composer, and respect the informal-tone rules. Any
 * violation (or a missing API key) falls back to the deterministic composer,
 * so the system never depends on the model behaving.
 */

import { CHAT_MAX_CHARS } from "@deepblue/core";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { getAnthropic, isLlmConfigured, messageText } from "./llm";

export const DRAFT_MODEL = process.env.DEEPBLUE_DRAFT_MODEL ?? "claude-haiku-4-5-20251001";

const draftSchema = z.object({ message: z.string() });

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
    "Reglas ESTRICTAS:",
    `- Máximo ${CHAT_MAX_CHARS} caracteres (el chat corta el resto).`,
    "- Tono informal español de chat: nada de ¿ ni ¡, sin listas con guiones, sin párrafos largos.",
    req.mustContainPrice
      ? `- El precio "${req.mustContainPrice} €" debe aparecer EXACTAMENTE así — no lo cambies ni lo redondees.`
      : "- No menciones ningún precio nuevo que no esté en el borrador base.",
    "- No prometas visita incondicional si el objetivo es negociar: la visita solo condicionada al precio.",
    "- No inventes datos del coche que no estén en la conversación.",
    "- NUNCA afirmes disponibilidad ni planes del comprador (días, fines de semana, horarios): no los conoces. Para la visita, pide opciones al vendedor y ya confirmará el comprador.",
    "- Responde a lo último que dijo el vendedor de forma natural (que no parezca un robot).",
  ].join("\n");
}

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
  return true;
}

/**
 * Draft the message with the cheap model; on any failure — no key, API error,
 * invalid output — return the deterministic fallback unchanged. Callers never
 * need to care which path produced the text.
 */
export async function draftSellerProse(req: DraftRequest): Promise<{ text: string; model: string }> {
  if (!isLlmConfigured()) return { text: req.fallback, model: "deterministic" };
  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DRAFT_MODEL,
      max_tokens: 400,
      output_config: { format: zodOutputFormat(draftSchema) },
      messages: [{ role: "user", content: prompt(req) }],
    });
    const { message } = draftSchema.parse(JSON.parse(messageText(msg)));
    const text = message.trim();
    return isValidDraft(text, req)
      ? { text, model: DRAFT_MODEL }
      : { text: req.fallback, model: "deterministic" };
  } catch {
    return { text: req.fallback, model: "deterministic" };
  }
}
