/** Shared corpus lookups: price benchmark and reviewed model dossiers. */

import {
  ACTIVE_PLATFORMS,
  computeBenchmark,
  type BenchmarkTarget,
  type Comparable,
  pickDossierForYear,
  type ModelDossier,
  type PriceBenchmark,
} from "@deepblue/core";
import { listings, modelDossiers, type Db } from "@deepblue/db";
import { and, desc, inArray, isNotNull, isNull, sql } from "drizzle-orm";

/** One SQL fetch per make+model+market per batch; weighting runs per listing. */
export type ComparableCache = Map<string, Comparable[]>;

/** Freshest slice of the corpus that still gives the median room to be robust. */
const MAX_COMPARABLES = 500;

/**
 * Price benchmark for one specific unit: weighted median over the model's
 * corpus where trim dominates and year proximity refines (computeBenchmark).
 * Grows more meaningful with every sweep; evaluateListing ignores it below
 * its minimum effective sample size.
 */
export async function getBenchmark(
  db: Db,
  make: string | undefined,
  model: string | undefined,
  market: string | undefined,
  target: BenchmarkTarget,
  cache: ComparableCache,
): Promise<PriceBenchmark | undefined> {
  if (!make || !model) return undefined;
  // Markets aren't comparable (a Spanish Golf ≠ a German Golf in price and
  // condition); benchmark strictly within the listing's market. Legacy rows
  // without country_code are treated as ES (both current platforms are .es).
  const mkt = (market ?? "ES").toUpperCase();
  const key = `${make.toLowerCase()}|${model.toLowerCase()}|${mkt}`;

  let comparables = cache.get(key);
  if (!comparables) {
    // The comparable price is what a buyer would actually pay: the parsed
    // cash price when the ad buried one, else the headline (financing
    // headlines otherwise depress the whole median).
    const rows = await db
      .select({
        priceEur: sql<number>`coalesce(${listings.cashPriceEur}, ${listings.priceEur})`,
        year: listings.year,
        version: listings.version,
        powerCv: listings.powerCv,
        fuel: listings.fuel,
        gearbox: listings.gearbox,
      })
      .from(listings)
      .where(
        and(
          isNotNull(listings.priceEur),
          // Only active platforms: a paused platform's prices stop refreshing
          // and must not skew the benchmark while it's out of the loop.
          inArray(listings.platform, [...ACTIVE_PLATFORMS]),
          sql`lower(${listings.make}) = ${make.toLowerCase()}`,
          // Same family, both directions ("207" ↔ "207 rc") — seller free text
          // must not fragment the sample. SQL mirror of core sameModelFamily().
          sql`(lower(${listings.model}) = ${model.toLowerCase()}
            or lower(${listings.model}) like ${`${model.toLowerCase()} %`}
            or ${model.toLowerCase()} like lower(${listings.model}) || ' %')`,
          sql`upper(coalesce(${listings.countryCode}, 'ES')) = ${mkt}`,
        ),
      )
      .orderBy(desc(listings.lastSeenAt))
      .limit(MAX_COMPARABLES);

    comparables = rows.map((r) => ({
      priceEur: Number(r.priceEur),
      year: r.year ?? undefined,
      version: r.version ?? undefined,
      powerCv: r.powerCv ?? undefined,
      fuel: r.fuel ?? undefined,
      gearbox: r.gearbox ?? undefined,
    }));
    cache.set(key, comparables);
  }

  return computeBenchmark(target, comparables, mkt);
}

/**
 * The dossier to judge a listing of THIS brief by: the seller's own model text
 * first, then the names the brief knows the car under.
 *
 * The fallback exists because trade names and ad text disagree: Renault badged
 * it "Sport Spider" and every ad says "Renault Spider", so the listing's model
 * field finds no dossier at all and the unit is judged with zero knowledge —
 * which lands it on a neutral 55 and lets ignorance outrank research.
 *
 * Lives here, not at the call sites: ingest, reevaluate and adopt each looked
 * the dossier up on their own, and patching one of the three is precisely how
 * the same listing got a dossier on ingest and lost it on the next re-eval.
 */
export async function getDossierForBrief(
  db: Db,
  listing: { make?: string | null; model?: string | null; year?: number | null },
  vehicles: ReadonlyArray<{ make: string; model: string }>,
  cache: Map<string, ModelDossier | undefined>,
): Promise<ModelDossier | undefined> {
  const year = listing.year ?? undefined;
  let dossier = await getDossier(db, listing.make ?? undefined, listing.model ?? undefined, cache, year);
  for (const v of vehicles) {
    if (dossier) break;
    dossier = await getDossier(db, v.make, v.model, cache, year);
  }
  return dossier;
}

/** Latest live dossier for make+model. Disabled (or legacy unreviewed) rows never drive claims. */
export async function getDossier(
  db: Db,
  make: string | undefined,
  model: string | undefined,
  cache: Map<string, ModelDossier | undefined>,
  year?: number,
): Promise<ModelDossier | undefined> {
  if (!make || !model) return undefined;
  const key = `${make.toLowerCase()}|${model.toLowerCase()}|${year ?? ""}`;
  if (cache.has(key)) return cache.get(key);

  // Listing model fields carry seller free text ("207 rc", "Golf GTI"); a
  // dossier keyed on the base model must still match, so fall back to a
  // word-prefix match. Exact match wins over prefix, then latest version.
  const m = model.toLowerCase();
  const rows = await db
    .select({ content: modelDossiers.content })
    .from(modelDossiers)
    .where(
      and(
        sql`lower(${modelDossiers.make}) = ${make.toLowerCase()}`,
        sql`(lower(${modelDossiers.model}) = ${m} or ${m} like lower(${modelDossiers.model}) || ' %')`,
        isNotNull(modelDossiers.reviewedAt),
        isNull(modelDossiers.disabledAt),
      ),
    )
    .orderBy(desc(sql`lower(${modelDossiers.model}) = ${m}`), desc(modelDossiers.version));

  // Generation-aware pick: a dossier whose generation label carries a year
  // span only judges listings inside it (a gen-III issue list says nothing
  // about a gen-I van). Span covering the year > span-less > none.
  const dossier = pickDossierForYear(
    rows.map((r) => r.content),
    year,
  );
  cache.set(key, dossier);
  return dossier;
}
