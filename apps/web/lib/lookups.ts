/** Shared corpus lookups: price benchmark and reviewed model dossiers. */

import {
  computeBenchmark,
  type BenchmarkTarget,
  type Comparable,
  type ModelDossier,
  type PriceBenchmark,
} from "@deepblue/core";
import { listings, modelDossiers, type Db } from "@deepblue/db";
import { and, desc, isNotNull, sql } from "drizzle-orm";

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
      })
      .from(listings)
      .where(
        and(
          isNotNull(listings.priceEur),
          sql`lower(${listings.make}) = ${make.toLowerCase()}`,
          sql`lower(${listings.model}) = ${model.toLowerCase()}`,
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
    }));
    cache.set(key, comparables);
  }

  return computeBenchmark(target, comparables, mkt);
}

/** Latest reviewed dossier for make+model. Unreviewed dossiers never drive claims. */
export async function getDossier(
  db: Db,
  make: string | undefined,
  model: string | undefined,
  cache: Map<string, ModelDossier | undefined>,
): Promise<ModelDossier | undefined> {
  if (!make || !model) return undefined;
  const key = `${make.toLowerCase()}|${model.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);

  const rows = await db
    .select({ content: modelDossiers.content })
    .from(modelDossiers)
    .where(
      and(
        sql`lower(${modelDossiers.make}) = ${make.toLowerCase()}`,
        sql`lower(${modelDossiers.model}) = ${model.toLowerCase()}`,
        isNotNull(modelDossiers.reviewedAt),
      ),
    )
    .orderBy(desc(modelDossiers.version))
    .limit(1);

  const dossier = rows[0]?.content;
  cache.set(key, dossier);
  return dossier;
}
