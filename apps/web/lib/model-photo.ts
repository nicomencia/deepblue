/**
 * One photo per model, so a search and a dossier are recognisable at a glance
 * the way a discovery recommendation already is.
 *
 * Three sources, best first:
 *  1. the dossier's own researched photo (`content.imageUrl`) — generation
 *     specific, the same Wikimedia rule discovery uses;
 *  2. the Wikipedia article's lead image — free, deterministic, encyclopedic,
 *     and available for every model, which is what makes the lists look like
 *     one thing instead of a mix of press art and dealer snapshots;
 *  3. an ad photo for that model from the corpus — last resort, because it is
 *     one specific unit (often with a dealer's watermark across it) rather
 *     than the model in the abstract.
 *
 * Nothing here triggers research: a missing photo is a missing photo, not a
 * reason to spend.
 */

import { generationYearSpan, normalizeImageUrl, sameModelFamily } from "@deepblue/core";
import { listings, modelDossiers, type Db } from "@deepblue/db";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { fetchWikipediaPhoto } from "./wikipedia-photo";

export interface ModelKey {
  make: string;
  model: string;
  /** Sharpens the Wikipedia lookup toward the right generation's article. */
  generation?: string;
  /**
   * The era being hunted. Every candidate photo is gated on it: a photo of
   * the wrong generation is worse than no photo — it shows the user a car
   * that is not the one being discussed.
   */
  yearMin?: number;
  yearMax?: number;
}

export const modelPhotoKey = (make: string, model: string): string =>
  `${make.trim().toLowerCase()}|${model.trim().toLowerCase()}`;

/**
 * Resolve photos for the given models in two queries, whatever the list size —
 * these pages render every brief and every dossier, so per-row lookups would
 * be a query storm on the single-writer dev database.
 */
export async function resolveModelPhotos(
  db: Db,
  keys: ModelKey[],
): Promise<Map<string, string>> {
  const photos = new Map<string, string>();
  if (keys.length === 0) return photos;

  const [dossierRows, listingRows] = await Promise.all([
    db
      .select({
        id: modelDossiers.id,
        make: modelDossiers.make,
        model: modelDossiers.model,
        content: modelDossiers.content,
      })
      .from(modelDossiers)
      .where(isNull(modelDossiers.disabledAt)),
    db
      .select({ make: listings.make, model: listings.model, year: listings.year, imageUrl: listings.imageUrl })
      .from(listings)
      .where(and(isNotNull(listings.imageUrl), isNotNull(listings.make)))
      .orderBy(desc(listings.lastSeenAt))
      .limit(500),
  ]);

  // Deduplicate first: two briefs on the same car must not fetch twice.
  const unique = new Map<string, ModelKey>();
  for (const key of keys) {
    const id = modelPhotoKey(key.make, key.model);
    if (!unique.has(id)) unique.set(id, key);
  }

  const needsWikipedia: Array<{ id: string; key: ModelKey; dossierId?: string }> = [];

  for (const [id, key] of unique) {
    // Family matching, not equality: a "Yaris" brief and a "Yaris XP90"
    // dossier are the same car, and that is the matcher the rest of the
    // system already uses for coverage.
    const dossier = dossierRows.find(
      (d) =>
        d.make.toLowerCase() === key.make.trim().toLowerCase() &&
        sameModelFamily(d.model, key.model),
    );
    const researched = normalizeImageUrl(dossier?.content.imageUrl);
    if (researched) {
      photos.set(id, researched);
      continue;
    }
    // When a dossier covers this car, resolve from ITS identity rather than
    // the caller's. A search for "207 RC" (no generation, open-ended years)
    // and the "207 · 207 RC / THP (2007-2012)" dossier are the same vehicle,
    // and asking two different questions got two different photos of it —
    // which reads as two different cars. The dossier is the model-level
    // authority everywhere else; it decides the photo too.
    const span = generationYearSpan(dossier?.content.generation);
    needsWikipedia.push({
      id,
      dossierId: dossier?.id,
      key: dossier
        ? {
            make: dossier.make,
            model: dossier.model,
            generation: dossier.content.generation,
            yearMin: span?.yearMin ?? key.yearMin,
            yearMax: span?.yearMax ?? key.yearMax,
          }
        : key,
    });
  }

  // In parallel and each with its own timeout, so the slowest lookup bounds
  // the page instead of the sum of them.
  const found = await Promise.all(
    needsWikipedia.map(({ key }) =>
      fetchWikipediaPhoto(key.make, key.model, key.generation, {
        yearMin: key.yearMin,
        yearMax: key.yearMax,
      }),
    ),
  );
  // Persist what was resolved onto the dossier that owns the model.
  //
  // Wikimedia rate-limits anonymous bursts, so a page that fires several
  // lookups at once gets a different rung of the ladder each render — which
  // is why the 207 search and the 207 dossier showed two different photos of
  // the same car. Storing the first answer makes it THE answer: every page
  // reads the same field afterwards, and the lookup never runs again.
  const persist = needsWikipedia
    .map(({ dossierId, key }, i) => ({ dossierId, key, url: found[i] }))
    .filter((p): p is { dossierId: string; key: ModelKey; url: string } => !!p.dossierId && !!p.url);
  for (const { dossierId, url } of persist) {
    const row = dossierRows.find((d) => d.id === dossierId);
    if (!row || row.content.imageUrl) continue;
    await db
      .update(modelDossiers)
      .set({ content: { ...row.content, imageUrl: url } })
      .where(eq(modelDossiers.id, dossierId));
  }

  needsWikipedia.forEach(({ id, key }, i) => {
    const url = found[i];
    if (url) {
      photos.set(id, url);
      return;
    }
    // Corpus fallback, era-checked on REAL data: the listing's own year. An
    // ad photo of an in-band car is by definition the right generation; one
    // of an out-of-band car is the exact lie this ladder exists to avoid.
    const listing = listingRows.find(
      (l) =>
        (l.make ?? "").toLowerCase() === key.make.trim().toLowerCase() &&
        !!l.model &&
        sameModelFamily(l.model, key.model) &&
        (l.year === null ||
          ((key.yearMin === undefined || l.year >= key.yearMin) &&
            (key.yearMax === undefined || l.year <= key.yearMax))),
    );
    if (listing?.imageUrl) photos.set(id, listing.imageUrl);
  });

  return photos;
}
