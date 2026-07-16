"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "../../../lib/db";
import { applyIssueFinding, type FindingStatus } from "../../../lib/findings";

const STATUSES: FindingStatus[] = ["confirmed", "ruled_out", "unconfirmed"];

/** Record a seller-verified outcome for one issue and refresh the verdict. */
export async function setIssueFinding(formData: FormData): Promise<void> {
  const leadId = String(formData.get("leadId") ?? "");
  const title = String(formData.get("title") ?? "");
  const status = String(formData.get("status") ?? "") as FindingStatus;
  const note = String(formData.get("note") ?? "");
  if (!leadId || !title || !STATUSES.includes(status)) {
    throw new Error("finding inválido: faltan lead, issue o estado");
  }

  const db = await getDb();
  await applyIssueFinding(db, leadId, title, status, note);
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
}

import { applyImportFact, type ImportFactField, type ImportFactValue } from "../../../lib/findings";
import { decideLeadApproval, draftOutreach, sendUserMessage, updateDraftBody } from "../../../lib/outreach";

/** Mark a verified import fact (RHD / foreign plates) and refresh the verdict. */
export async function setImportFact(formData: FormData): Promise<void> {
  const leadId = String(formData.get("leadId") ?? "");
  const field = String(formData.get("field") ?? "") as ImportFactField;
  const value = String(formData.get("value") ?? "") as ImportFactValue;
  if (!leadId || !["rhd", "foreignPlates"].includes(field) || !["true", "false", "unknown"].includes(value)) {
    throw new Error("marca inválida: faltan lead, campo o valor");
  }

  const db = await getDb();
  await applyImportFact(db, leadId, field, value);
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
}

/** Draft the approval-gated opening message for this lead's seller. */
export async function draftSellerMessage(formData: FormData): Promise<void> {
  const leadId = String(formData.get("leadId") ?? "");
  if (!leadId) throw new Error("falta leadId");

  const db = await getDb();
  const result = await draftOutreach(db, leadId);
  if (!result.ok) throw new Error(result.error);
  revalidatePath(`/leads/${leadId}`);
}

/** Approve the pending draft: save the (possibly edited) text, then queue the send. */
export async function approveSellerMessage(formData: FormData): Promise<void> {
  const leadId = String(formData.get("leadId") ?? "");
  const messageId = String(formData.get("messageId") ?? "");
  const body = String(formData.get("body") ?? "");
  if (!leadId || !messageId) throw new Error("faltan leadId o messageId");

  const db = await getDb();
  const saved = await updateDraftBody(db, messageId, body);
  if (!saved.ok) throw new Error(saved.error);
  const result = await decideLeadApproval(db, leadId, "approve");
  if (!result.ok) throw new Error(result.error);
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
}

/** Send a user-written reply — typing it is the approval, it queues directly. */
export async function replySellerMessage(formData: FormData): Promise<void> {
  const leadId = String(formData.get("leadId") ?? "");
  const body = String(formData.get("body") ?? "");
  if (!leadId) throw new Error("falta leadId");

  const db = await getDb();
  const result = await sendUserMessage(db, leadId, body);
  if (!result.ok) throw new Error(result.error);
  revalidatePath(`/leads/${leadId}`);
}

/** Reject the pending draft — it stays in the timeline as an inert draft. */
export async function rejectSellerMessage(formData: FormData): Promise<void> {
  const leadId = String(formData.get("leadId") ?? "");
  if (!leadId) throw new Error("falta leadId");

  const db = await getDb();
  const result = await decideLeadApproval(db, leadId, "reject");
  if (!result.ok) throw new Error(result.error);
  revalidatePath(`/leads/${leadId}`);
}
