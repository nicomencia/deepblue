/**
 * Phase 2 outbound, stage 1: approval-gated seller outreach. The system only
 * ever DRAFTS messages (deterministic, from the verdict's open questions);
 * a human approves every send — by one-click email token or on the lead page.
 * Approval is what enqueues the send_message job for the runner.
 */

import { randomBytes } from "node:crypto";
import { canTransition, composeOpeningMessage, isPlatformActive, type JobPayload } from "@deepblue/core";
import { approvals, briefs, events, jobs, leads, listings, messages, users, type Db } from "@deepblue/db";
import { and, eq, inArray } from "drizzle-orm";
import { sendEmail } from "./email";
import { dashboardUrl, leadUrl } from "./links";

/** Lead states where talking to the seller makes sense. */
const CONTACTABLE_STATES = ["shortlisted", "contacted", "negotiating"] as const;

export interface OutreachResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}

/**
 * Draft an opening message for a lead and park it behind an approval.
 * One pending conversation step at a time: a lead with a draft awaiting
 * approval (or a send in flight) refuses a second draft.
 */
export async function draftOutreach(db: Db, leadId: string): Promise<OutreachResult> {
  const [row] = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!row) return { ok: false, error: "lead no encontrado" };
  const { lead, listing } = row;

  if (!(CONTACTABLE_STATES as readonly string[]).includes(lead.state)) {
    return { ok: false, error: `el lead está en estado ${lead.state}, no contactable` };
  }
  if (lead.autonomyMode === "paused") {
    return { ok: false, error: "la conversación de este lead está en pausa" };
  }
  if (listing.platform !== "wallapop" || !isPlatformActive(listing.platform)) {
    return { ok: false, error: `mensajería no disponible en ${listing.platform}` };
  }

  const [inFlight] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.leadId, leadId),
        eq(messages.direction, "outbound"),
        inArray(messages.status, ["pending_approval", "queued"]),
      ),
    )
    .limit(1);
  if (inFlight) return { ok: false, error: "ya hay un mensaje pendiente de aprobar o enviar" };

  const body = composeOpeningMessage({
    title: listing.title,
    sellerName: listing.sellerName ?? undefined,
    openQuestions: lead.verdict?.openQuestions ?? [],
  });

  const [message] = await db
    .insert(messages)
    .values({
      userId: lead.userId,
      leadId,
      direction: "outbound",
      channel: "wallapop_chat",
      status: "pending_approval",
      body,
    })
    .returning();
  if (!message) return { ok: false, error: "no se pudo crear el borrador" };

  // base64url: unguessable and safe inside a URL path.
  const actionToken = randomBytes(24).toString("base64url");
  await db.insert(approvals).values({
    userId: lead.userId,
    leadId,
    kind: "send_message",
    payload: { messageId: message.id },
    actionToken,
  });

  await db.insert(events).values({
    userId: lead.userId,
    leadId,
    type: "message_drafted",
    payload: { messageId: message.id, channel: "wallapop_chat" },
  });

  const [owner] = await db.select().from(users).where(eq(users.id, lead.userId)).limit(1);
  if (owner) {
    await sendEmail({
      to: owner.email,
      subject: `deepblue · aprobar mensaje para «${listing.title}»`,
      text:
        `Borrador listo para el vendedor de:\n${listing.title}\n${listing.url}\n\n` +
        `--- mensaje ---\n${body}\n---------------\n\n` +
        `Aprobar y enviar: ${dashboardUrl(`/api/approvals/${actionToken}?decision=approve`)}\n` +
        `Rechazar: ${dashboardUrl(`/api/approvals/${actionToken}?decision=reject`)}\n\n` +
        `Editar antes de enviar: ${leadUrl(leadId)}`,
    });
  }

  return { ok: true, messageId: message.id };
}

/** Edit a draft's text while it still awaits approval. */
export async function updateDraftBody(db: Db, messageId: string, body: string): Promise<OutreachResult> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "el mensaje no puede quedar vacío" };
  const [updated] = await db
    .update(messages)
    .set({ body: trimmed })
    .where(and(eq(messages.id, messageId), eq(messages.status, "pending_approval")))
    .returning({ id: messages.id });
  return updated
    ? { ok: true, messageId }
    : { ok: false, error: "el borrador ya no está pendiente de aprobación" };
}

export interface ApprovalDecision {
  ok: boolean;
  error?: string;
  leadId?: string;
  decision?: "approve" | "reject";
}

/**
 * Resolve a pending approval. Approving queues the send_message job with the
 * draft's CURRENT text (edits included); rejecting demotes it back to an
 * inert draft. Either way the token burns — decided approvals never re-fire.
 */
export async function decideApproval(
  db: Db,
  actionToken: string,
  decision: "approve" | "reject",
): Promise<ApprovalDecision> {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.actionToken, actionToken))
    .limit(1);
  if (!approval) return { ok: false, error: "aprobación no encontrada" };
  if (approval.status !== "pending") {
    return { ok: false, error: `esta aprobación ya se decidió (${approval.status})`, leadId: approval.leadId };
  }
  if (approval.kind !== "send_message") {
    return { ok: false, error: `tipo de aprobación no soportado (${approval.kind})` };
  }

  const messageId = String((approval.payload as { messageId?: string }).messageId ?? "");
  const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message || message.status !== "pending_approval") {
    return { ok: false, error: "el mensaje ya no está pendiente", leadId: approval.leadId };
  }

  if (decision === "reject") {
    await db.update(messages).set({ status: "draft" }).where(eq(messages.id, message.id));
    await db
      .update(approvals)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(approvals.id, approval.id));
    await db.insert(events).values({
      userId: approval.userId,
      leadId: approval.leadId,
      type: "message_rejected",
      payload: { messageId: message.id },
    });
    return { ok: true, leadId: approval.leadId, decision };
  }

  const [row] = await db
    .select({ lead: leads, listing: listings })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .where(eq(leads.id, approval.leadId))
    .limit(1);
  if (!row) return { ok: false, error: "lead no encontrado" };
  if (row.lead.state === "dead") {
    return { ok: false, error: "el lead está muerto — no se envía nada", leadId: approval.leadId };
  }

  const payload: JobPayload = {
    type: "send_message",
    platform: row.listing.platform,
    platformListingId: row.listing.platformListingId,
    url: row.listing.url,
    body: message.body,
    messageId: message.id,
  };
  await db.insert(jobs).values({ userId: approval.userId, type: payload.type, payload });
  await db.update(messages).set({ status: "queued" }).where(eq(messages.id, message.id));
  await db
    .update(approvals)
    .set({ status: "approved", decidedAt: new Date() })
    .where(eq(approvals.id, approval.id));
  await db.insert(events).values({
    userId: approval.userId,
    leadId: approval.leadId,
    type: "message_approved",
    payload: { messageId: message.id },
  });

  return { ok: true, leadId: approval.leadId, decision };
}

/** Dashboard path: resolve the lead's single pending approval and decide it. */
export async function decideLeadApproval(
  db: Db,
  leadId: string,
  decision: "approve" | "reject",
): Promise<ApprovalDecision> {
  const [approval] = await db
    .select({ actionToken: approvals.actionToken })
    .from(approvals)
    .where(
      and(
        eq(approvals.leadId, leadId),
        eq(approvals.kind, "send_message"),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  if (!approval) return { ok: false, error: "no hay aprobación pendiente para este lead" };
  return decideApproval(db, approval.actionToken, decision);
}

/**
 * The runner reported a send. Success moves the message to sent and the lead
 * to contacted; failure marks the message failed so the user can re-draft.
 */
export async function applySendResult(
  db: Db,
  messageId: string,
  outcome: { ok: true; externalId?: string; sentAt: string } | { ok: false; error: string },
): Promise<void> {
  const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message) return;

  if (!outcome.ok) {
    await db.update(messages).set({ status: "failed" }).where(eq(messages.id, messageId));
    await db.insert(events).values({
      userId: message.userId,
      leadId: message.leadId,
      type: "message_send_failed",
      payload: { messageId, error: outcome.error },
    });
    return;
  }

  await db
    .update(messages)
    .set({
      status: "sent",
      sentAt: new Date(outcome.sentAt),
      externalId: outcome.externalId,
    })
    .where(eq(messages.id, messageId));

  const [lead] = await db.select().from(leads).where(eq(leads.id, message.leadId)).limit(1);
  if (lead && canTransition(lead.state, "contacted")) {
    await db
      .update(leads)
      .set({ state: "contacted", updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
  }

  await db.insert(events).values({
    userId: message.userId,
    leadId: message.leadId,
    type: "message_sent",
    payload: { messageId, externalId: outcome.externalId },
  });
}
