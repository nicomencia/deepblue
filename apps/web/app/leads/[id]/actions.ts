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
