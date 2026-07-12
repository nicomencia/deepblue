"use server";

import { users } from "@deepblue/db";
import { revalidatePath } from "next/cache";
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
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/");
  revalidatePath("/activity");
}
