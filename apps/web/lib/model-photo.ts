/**
 * One photo per model, so a search and a dossier are recognisable at a glance
 * the way a discovery recommendation already is.
 *
 * Two sources, in order:
 *  1. the dossier's own researched photo (`content.imageUrl`) — model-level and
 *     press-quality, the same Wikimedia rule discovery uses;
 *  2. any ad photo for that model already in the corpus — free, instant, and
 *     available for every model the user actually hunts, including the ones
 *     whose dossier predates the photo field.
 *
 * A real ad photo is a specific unit rather than the model in the abstract, so
 * it is a fallback and never overrides researched art. Nothing here triggers
 * research: a missing photo is a missing photo, not a reason to spend.
 */

import { normalizeImageUrl, sameModelFamily } from "@deepblue/core";
import { listings, modelDossiers, type Db } from "@deepblue/db";
import { and, desc, isNotNull, isNull } from "drizzle-orm";

export interface ModelKey {
  make: string;
  model: string;
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

  for (const key of keys) {
    const id = modelPhotoKey(key.make, key.model);
    if (photos.has(id)) continue;

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

    const listing = listingRows.find(
      (l) =>
        (l.make ?? "").toLowerCase() === key.make.trim().toLowerCase() &&
        !!l.model &&
        sameModelFamily(l.model, key.model),
    );
    if (listing?.imageUrl) photos.set(id, listing.imageUrl);
  }

  return photos;
}
