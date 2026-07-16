/**
 * Conversation reading: seller replies become lead data automatically.
 * An LLM reads the whole conversation against the verdict and proposes a
 * validated payload; CODE applies it — issue findings via the same path as
 * the manual buttons, import facts on the listing, bounded factor deltas
 * merged like the ad enrichment. Sending messages keeps its human gate;
 * reading them doesn't need one, because every applied outcome is evented,
 * quoted, and reversible from the lead page.
 */

import {
  conversationReadingPayloadSchema,
  type ConversationReading,
  type ConversationReadingPayload,
  type IssueFinding,
} from "@deepblue/core";
import { briefs, events, leads, listings, messages, users, type Db } from "@deepblue/db";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { sendEmail } from "./email";
import { leadUrl } from "./links";
import { ENRICH_MODEL, getAnthropic, isLlmConfigured, messageText } from "./llm";
import { newEvalCaches, reevaluateLead } from "./reevaluate";

type LeadRow = typeof leads.$inferSelect;
type ListingRow = typeof listings.$inferSelect;
type BriefRow = typeof briefs.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

/** A conversation awaiting interpretation, with everything the reader needs. */
export interface PendingConversation {
  lead: LeadRow;
  listing: ListingRow;
  brief: BriefRow;
  conversation: MessageRow[];
}

/** Leads with inbound messages newer than their last reading. */
export async function pendingConversations(db: Db, limit = 6): Promise<PendingConversation[]> {
  const rows = await db
    .selectDistinct({ lead: leads, listing: listings, brief: briefs })
    .from(messages)
    .innerJoin(leads, eq(messages.leadId, leads.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .where(
      and(
        eq(messages.direction, "inbound"),
        or(isNull(leads.chatReadAt), gt(messages.createdAt, leads.chatReadAt)),
      ),
    )
    .limit(limit);

  const out: PendingConversation[] = [];
  for (const row of rows) {
    const conversation = await db
      .select()
      .from(messages)
      .where(and(eq(messages.leadId, row.lead.id), inArray(messages.status, ["sent", "received"])))
      .orderBy(asc(messages.createdAt));
    out.push({ ...row, conversation });
  }
  return out;
}

export function conversationPrompt(p: PendingConversation): string {
  const v = p.lead.verdict;
  const issues = (v?.issues ?? [])
    .map(
      (i) =>
        `- "${i.title}" · estado ${i.status} · severidad ${i.severity}` +
        (i.typicalRepairCostEur
          ? ` · ~${i.typicalRepairCostEur.min}-${i.typicalRepairCostEur.max} €`
          : ""),
    )
    .join("\n");
  const transcript = p.conversation
    .map((m) => `${m.direction === "inbound" ? "VENDEDOR" : "COMPRADOR"}: ${m.body}`)
    .join("\n---\n");

  return `Eres el amigo mecánico que acompaña a comprar un coche de segunda mano en España.
El comprador está chateando con el vendedor de este anuncio. Lee la CONVERSACIÓN
completa y convierte lo que el vendedor ha dicho en datos. Refinas, no mandas:
cada cambio debe citar las palabras del vendedor.

ANUNCIO: ${p.listing.title} · ${p.listing.priceEur ?? "?"} € · ${p.listing.year ?? "?"} · ${p.listing.km ?? "?"} km

RIESGOS CONOCIDOS EN SEGUIMIENTO (títulos exactos):
${issues || "(ninguno)"}

CONVERSACIÓN (orden cronológico):
${transcript}

Instrucciones:
- issueUpdates: SOLO cuando el vendedor haya dicho algo que confirme o descarte
  uno de los riesgos listados, con su título EXACTO. basis "evidence_shared" si
  compartió documento/foto/factura; "seller_stated" si solo lo afirma. quote con
  sus palabras. Si no tocó ningún riesgo, lista vacía.
- importFacts: rhd/foreignPlates SOLO si la conversación lo establece
  (p.ej. menciona V5/matrícula UK ⇒ foreignPlates true), con quote.
- factorAdjustments: deltas donde la conversación aporte señal que el anuncio
  no daba (mantenimiento documentado prometido, respuestas evasivas, número de
  propietarios, transparencia del vendedor ⇒ sellerCredibility/unitEvidence).
  Una afirmación sin documento vale menos que una factura: deltas pequeños.
- redFlags/greenFlags: señales de la conversación, concretas, en español.
- scamSuspicion: true solo ante patrones claros (pagos por adelantado, envíos,
  salir de la plataforma, prisa artificial). Con scamReason.
- escalate: true si el vendedor pide algo que el comprador debe decidir en
  persona (señal/pago, documentos personales, salir de Wallapop, comportamiento
  raro) — escalateReason explicándolo.
- extraOpenQuestions: SOLO preguntas nuevas que la conversación pide a gritos.
- summary: 2-3 frases honestas: qué se ha averiguado del coche en esta
  conversación y qué queda pendiente.`;
}

/**
 * Validate and apply one conversation reading. Shared by both lanes (API
 * cron and Claude Code session import). Everything lands atomically enough:
 * findings + facts first, the reading stored, then ONE re-evaluation.
 */
export async function saveConversationReading(
  db: Db,
  p: PendingConversation,
  payload: ConversationReadingPayload,
  modelId: string,
): Promise<{ before?: string; after: string; applied: { findings: number; facts: number } }> {
  const reading: ConversationReading = { ...payload, model: modelId, at: new Date().toISOString() };
  const { lead, listing, brief } = p;
  const now = new Date();

  // Issue findings: same shape the manual buttons write, note carries the
  // seller's quoted words and the basis. Unknown titles are dropped.
  const validTitles = new Set((lead.verdict?.issues ?? []).map((i) => i.title));
  const updates = payload.issueUpdates.filter((u) => validTitles.has(u.title));
  let findings = lead.issueFindings ?? [];
  for (const u of updates) {
    const note = `${u.basis === "evidence_shared" ? "evidencia por chat" : "palabra del vendedor"}: «${u.quote}»`;
    findings = [
      ...findings.filter((f) => f.title !== u.title),
      { title: u.title, status: u.status, note, at: now.toISOString() } satisfies IssueFinding,
    ];
  }

  // Import facts: only ever SET from a conversation, never cleared.
  let factsApplied = 0;
  const factPatch: Partial<Pick<ListingRow, "rhd" | "foreignPlates">> = {};
  if (payload.importFacts?.rhd !== undefined && listing.rhd === null) {
    factPatch.rhd = payload.importFacts.rhd;
    factsApplied += 1;
  }
  if (payload.importFacts?.foreignPlates !== undefined && listing.foreignPlates === null) {
    factPatch.foreignPlates = payload.importFacts.foreignPlates;
    factsApplied += 1;
  }
  if (factsApplied > 0) {
    await db.update(listings).set(factPatch).where(eq(listings.id, listing.id));
  }

  await db
    .update(leads)
    .set({ issueFindings: findings, chatReading: reading, chatReadAt: now, updatedAt: now })
    .where(eq(leads.id, lead.id));

  const result = await reevaluateLead(
    db,
    { ...lead, issueFindings: findings, chatReading: reading },
    { ...listing, ...factPatch },
    brief,
    newEvalCaches(),
  );

  await db.insert(events).values({
    userId: lead.userId,
    leadId: lead.id,
    type: "conversation_read",
    payload: {
      before: lead.verdict?.overall,
      after: result.overall,
      findings: updates.map((u) => ({ title: u.title, status: u.status, basis: u.basis })),
      facts: factPatch,
      escalate: payload.escalate,
      model_id: modelId,
    },
  });

  // Escalation topics are never handled silently: the user hears about them
  // even though the raw reply email already went out.
  if (payload.escalate && payload.escalateReason) {
    const [owner] = await db.select().from(users).where(eq(users.id, lead.userId)).limit(1);
    if (owner) {
      await sendEmail({
        to: owner.email,
        subject: `deepblue · la conversación necesita tu decisión — «${listing.title}»`,
        text: `${payload.escalateReason}\n\nConversación: ${leadUrl(lead.id)}`,
      });
    }
  }

  return {
    before: lead.verdict?.overall,
    after: result.overall,
    applied: { findings: updates.length, facts: factsApplied },
  };
}

/** LLM lane: read one pending conversation with the API. */
export async function readConversation(
  db: Db,
  p: PendingConversation,
): Promise<{ before?: string; after: string }> {
  const client = getAnthropic();
  const msg = await client.messages.create({
    model: ENRICH_MODEL,
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(conversationReadingPayloadSchema) },
    messages: [{ role: "user", content: conversationPrompt(p) }],
  });
  // Trust boundary: validate before anything touches the DB.
  const payload = conversationReadingPayloadSchema.parse(JSON.parse(messageText(msg)));
  return saveConversationReading(db, p, payload, ENRICH_MODEL);
}

export interface ChatReadBatchStats {
  candidates: number;
  read: number;
  failed: number;
}

/** Drain pending conversations, bounded per call (scheduler ticks it). */
export async function readPendingConversations(db: Db, limit = 4): Promise<ChatReadBatchStats> {
  if (!isLlmConfigured()) return { candidates: 0, read: 0, failed: 0 };
  const pending = await pendingConversations(db, limit);
  const stats: ChatReadBatchStats = { candidates: pending.length, read: 0, failed: 0 };
  for (const p of pending) {
    try {
      await readConversation(db, p);
      stats.read += 1;
    } catch (err) {
      stats.failed += 1;
      console.error(
        `chat read failed for lead ${p.lead.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return stats;
}