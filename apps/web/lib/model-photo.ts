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

import { normalizeImageUrl, sameModelFamily } from "@deepblue/core";
import { listings, modelDossiers, type Db } from "@deepblue/db";
import { and, desc, isNotNull, isNull } from "drizzle-orm";
import { fetchWikipediaPhoto } from "./wikipedia-photo";

export interface ModelKey {
  make: string;
  model: string;
  /** Sharpens the Wikipedia lookup toward the right generation's article. */
  generation?: string;
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
      .select({ make: modelDossiers.make, model: modelDossiers.model, content: modelDossiers.content })
      .from(modelDossiers)
      .where(isNull(modelDossiers.disabledAt)),
    db
      .select({ make: listings.make, model: listings.model, imageUrl: listings.imageUrl })
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

  const needsWikipedia: Array<{ id: string; key: ModelKey }> = [];

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
    needsWikipedia.push({
      id,
      key: { ...key, generation: key.generation ?? dossier?.content.generation },
    });
  }

  // In parallel and each with its own timeout, so the slowest lookup bounds
  // the page instead of the sum of them.
  const found = await Promise.all(
    needsWikipedia.map(({ key }) => fetchWikipediaPhoto(key.make, key.model, key.generation)),
  );
  needsWikipedia.forEach(({ id, key }, i) => {
    const url = found[i];
    if (url) {
      photos.set(id, url);
      return;
    }
    const listing = listingRows.find(
      (l) =>
        (l.make ?? "").toLowerCase() === key.make.trim().toLowerCase() &&
        !!l.model &&
        sameModelFamily(l.model, key.model),
    );
    if (listing?.imageUrl) photos.set(id, listing.imageUrl);
  });

  return photos;
}
