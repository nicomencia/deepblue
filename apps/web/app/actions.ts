"use server";

import { users } from "@deepblue/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "../lib/db";
import { adoptListing } from "../lib/adopt";

/** Adopt a hand-found ad: queue the fetch that turns it into a manual lead. */
export async function adoptAd(formData: FormData): Promise<void> {
  const db = await getDb();
  const [user] = await db.select().from(users).limit(1);
  if (!user) throw new Error("no user yet");

  const url = String(formData.get("url") ?? "").trim();
  const maxRaw = Number(String(formData.get("maxPriceEur") ?? "").replace(/[.\s]/g, ""));
  const briefId = String(formData.get("briefId") ?? "");
  const result = await adoptListing(db, user.id, {
    url,
    maxPriceEur: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : undefined,
    briefId: briefId && briefId !== "auto" ? briefId : undefined,
  });
  revalidatePath("/");
  revalidatePath("/briefs");
  revalidatePath("/activity");
  // Feedback banner on Búsquedas, where the form lives (redirect stays outside try/catch).
  redirect(result.ok ? "/briefs?adopted=queued" : "/briefs?adopted=invalid");
}
