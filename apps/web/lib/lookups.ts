/** Shared corpus lookups: price benchmark and reviewed model dossiers. */

import type { ModelDossier, PriceBenchmark } from "@deepblue/core";
import { listings, modelDossiers, type Db } from "@deepblue/db";
import { and, desc, isNotNull, sql } from "drizzle-orm";

/**
 * Price benchmark = median over the corpus for the same make+model.
 * Grows more meaningful with every sweep; evaluateListing ignores it
 * below its minimum sample size.
 */
export async function getBenchmark(
  db: Db,
  make: string | undefined,
  model: string | undefined,
  market: string | undefined,
  cache: Map<string, PriceBenchmark | undefined>,
): Promise<PriceBenchmark | undefined> {
  if (!make || !model) return undefined;
  // Markets aren't comparable (a Spanish Golf ≠ a German Golf in price and
  // condition); benchmark strictly within the listing's market. Legacy rows
  // without country_code are treated as ES (both current platforms are .es).
  const mkt = (market ?? "ES").toUpperCase();
  const key = `${make.toLowerCase()}|${model.toLowerCase()}|${mkt}`;
  if (cache.has(key)) return cache.get(key);

  // The comparable price is what a buyer would actually pay: the parsed cash
  // price when the ad buried one, else the headline (financing headlines
  // otherwise depress the whole median).
  const rows = await db
    .select({
      median: sql<number | null>`percentile_cont(0.5) within group (order by coalesce(${listings.cashPriceEur}, ${listings.priceEur}))`,
      count: sql<number>`count(*)::int`,
    })
    .from(listings)
    .where(
      and(
        isNotNull(listings.priceEur),
        sql`lower(${listings.make}) = ${make.toLowerCase()}`,
        sql`lower(${listings.model}) = ${model.toLowerCase()}`,
        sql`upper(coalesce(${listings.countryCode}, 'ES')) = ${mkt}`,
      ),
    );

  const row = rows[0];
  const benchmark =
    row && row.median !== null && row.count > 0
      ? { medianEur: Number(row.median), sampleSize: row.count, market: mkt }
      : undefined;
  cache.set(key, benchmark);
  return benchmark;
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
