/**
 * A free, deterministic model photo — of the RIGHT generation, or nothing.
 *
 * "No photo beats a broken one" (normalizeImageUrl) extends here: no photo
 * beats a WRONG one. A 2024 Swift illustrating a 2005-2017 hunt is selling the
 * user a car that does not exist; the fallback that produced exactly that
 * (2026-07-27, Swift and Mazda2 cards) is why every candidate now passes an
 * era gate before being shown.
 *
 * Sources, in order — all free, no LLM:
 *  1. Wikipedia article lead image, generation-qualified search first. When a
 *     generation has its own article ("Honda Fit (second generation)",
 *     "Volkswagen Golf VII") this is the best free photo there is.
 *  2. Wikidata: most car generations are their own item with a curated image
 *     (P18) even when no per-generation article exists — verified live:
 *     "Toyota Yaris XP90" → Q106612215, a real 2011 NCP91 photo. Rate-limited
 *     for anonymous bursts, so it is one search + one claims call, cached.
 *  3. Wikipedia again without the generation — still era-gated, so a
 *     model-family article whose lead is the current generation is REJECTED
 *     for an old hunt rather than shown.
 *
 * The era gate: Commons car filenames conventionally carry the car's model
 * year ("2008-2010_Honda_Jazz_(GE)_…", "2024_Toyota_Yaris_…"). If any year in
 * the filename falls inside the hunt band (with slack for facelift/photo
 * dates) the candidate passes; years present but all outside → reject; no
 * years at all → pass, because absence of data is not evidence of mismatch
 * (same rule the evaluator applies to missing coordinates).
 */

import { normalizeVehicleText, splitModelAndGeneration } from "@deepblue/core";

const TTL_MS = 24 * 60 * 60 * 1000;
/** A page render must never hang on someone else's API. */
const TIMEOUT_MS = 2500;
/** Wikimedia asks for a descriptive agent; anonymous bulk traffic gets blocked. */
const USER_AGENT = "deepblue/0.1 (personal second-hand car assistant)";

export interface YearBand {
  yearMin?: number;
  yearMax?: number;
}

/**
 * Slack: a generation photographed after its run ended (press photo of a
 * late facelift) or a model-year filename one year early. Asymmetric — a
 * filename year BEFORE the generation started cannot be this generation.
 */
const SLACK_BEFORE = 1;
const SLACK_AFTER = 2;

/** Does this image filename plausibly show a car of the band's era? */
export function photoMatchesEra(url: string, band?: YearBand): boolean {
  if (!band || (band.yearMin === undefined && band.yearMax === undefined)) return true;
  // The whole path, not the last segment: Wikipedia thumb URLs repeat the
  // original filename one directory up (/thumb/…/File.jpg/960px-File.jpg),
  // and a derived segment may abbreviate away the year the original carries.
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname);
  } catch {
    return false;
  }
  const years = [...name.matchAll(/(?:19|20)\d{2}/g)].map((m) => Number(m[0]));
  if (years.length === 0) return true; // no data ≠ mismatch
  const lo = (band.yearMin ?? -Infinity) - SLACK_BEFORE;
  const hi = (band.yearMax ?? Infinity) + SLACK_AFTER;
  return years.some((y) => y >= lo && y <= hi);
}

interface Cached {
  url?: string;
  at: number;
}
// Misses are cached too: a model Wikipedia has never heard of must not cost a
// round trip on every render of the page.
const cache = new Map<string, Cached>();

/**
 * "The API failed" and "the API answered: nothing" are different facts.
 * Collapsing them poisoned the cache live (2026-07-27): a burst of parallel
 * lookups tripped Wikimedia's rate limit, the failures were cached as misses
 * for 24 h, and cards that HAD a legitimate photo rendered without one until
 * the next server restart. Transient trouble propagates as this error and is
 * never cached; only a genuine "searched, found nothing" is.
 */
class TransientLookupError extends Error {}

async function apiJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new TransientLookupError("network/timeout");
  }
  if (!res.ok) throw new TransientLookupError(`http ${res.status}`);
  // Wikimedia rate limits can answer 200 with a plain-text scolding.
  try {
    return await res.json();
  } catch {
    throw new TransientLookupError("non-json body");
  }
}

/**
 * Is this article about the car we asked for? Make alone is not enough —
 * "Mazda Mazda2 DE" ranked the article "Mazda CX-3" (make matches, car does
 * not) and "Suzuki Swift MZ" ranked "Suzuki" the company, whose lead image
 * has no year and so sails through the era gate (both live, 2026-07-27).
 * The model must appear in the title — except for generation articles, which
 * may use the car's other market name ("Honda Fit (second generation)" IS the
 * Jazz GE, and rejecting it would throw away the best hit we get).
 */
function titleMatches(title: string, make: string, model: string): boolean {
  const t = normalizeVehicleText(title);
  if (!t.includes(normalizeVehicleText(make))) return false;
  return t.includes(normalizeVehicleText(model)) || /generation|generacion/.test(t);
}

async function wikipediaLead(
  lang: string,
  query: string,
  make: string,
  model: string,
  band?: YearBand,
): Promise<string | undefined> {
  const data = (await apiJson(
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
      `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=3` +
      `&prop=pageimages&piprop=thumbnail&pithumbsize=640`,
  )) as
    | { query?: { pages?: Record<string, { title?: string; index?: number; thumbnail?: { source?: string } }> } }
    | undefined;
  const pages = Object.values(data?.query?.pages ?? {}).sort(
    (a, b) => (a.index ?? 99) - (b.index ?? 99),
  );
  for (const page of pages) {
    if (!page.thumbnail?.source || !page.title) continue;
    if (!titleMatches(page.title, make, model)) continue;
    if (!photoMatchesEra(page.thumbnail.source, band)) continue;
    return page.thumbnail.source;
  }
  return undefined;
}

/** One search + one claims call: the generation's own Wikidata item, if any. */
async function wikidataGenerationImage(
  make: string,
  model: string,
  genCode: string,
  band?: YearBand,
): Promise<string | undefined> {
  const search = (await apiJson(
    "https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*" +
      `&language=en&uselang=en&type=item&limit=5&search=${encodeURIComponent(`${make} ${model} ${genCode}`)}`,
  )) as { search?: Array<{ id: string; label?: string; description?: string }> } | undefined;

  const item = search?.search?.find((e) => {
    const label = (e.label ?? "").toLowerCase();
    const desc = (e.description ?? "").toLowerCase();
    return (
      label.includes(model.toLowerCase()) &&
      (label.includes(genCode.toLowerCase()) || /generation/.test(desc))
    );
  });
  if (!item) return undefined;

  const claims = (await apiJson(
    `https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&origin=*&entity=${item.id}&property=P18`,
  )) as { claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> } } | undefined;
  const file = claims?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (!file) return undefined;

  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=640`;
  return photoMatchesEra(url, band) ? url : undefined;
}

/**
 * Spanish article first (the user's market and language), English as the
 * fallback — en.wikipedia has generation articles far more often. Never
 * throws: a photo is a nicety, and no page should fail without one.
 */
export async function fetchWikipediaPhoto(
  make: string,
  model: string,
  generation?: string,
  band?: YearBand,
): Promise<string | undefined> {
  const cleanModel = splitModelAndGeneration(model).model;
  if (!make.trim() || !cleanModel) return undefined;
  // "VII (2012–2019)" → "VII"; "MZ/EZ y FZ/NZ" → "MZ" — free text from
  // research, so only the first code is worth putting in a search box.
  const genCode = generation
    ?.replace(/\([^)]*\)/g, "")
    .trim()
    .split(/[\s/]/)[0]
    ?.replace(/[^A-Za-z0-9]/g, "");

  const bandKey = `${band?.yearMin ?? ""}-${band?.yearMax ?? ""}`;
  const attempts: Array<[string, () => Promise<string | undefined>]> = [];

  if (genCode) {
    const q = `${make} ${cleanModel} ${genCode}`;
    attempts.push([`wp:${q}`, async () => (await wikipediaLead("es", q, make, cleanModel, band)) ?? wikipediaLead("en", q, make, cleanModel, band)]);
    attempts.push([`wd:${q}`, () => wikidataGenerationImage(make, cleanModel, genCode, band)]);
  }
  const plain = `${make} ${cleanModel}`;
  attempts.push([`wp:${plain}`, async () => (await wikipediaLead("es", plain, make, cleanModel, band)) ?? wikipediaLead("en", plain, make, cleanModel, band)]);

  for (const [key, run] of attempts) {
    const cacheKey = `${key}|${bandKey}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < TTL_MS) {
      if (hit.url) return hit.url;
      continue;
    }
    try {
      const url = await run();
      // Definitive answers only — a hit, or "searched and nothing matched".
      cache.set(cacheKey, { url, at: Date.now() });
      if (url) return url;
    } catch {
      // Rate limit, offline, timeout: leave the cache alone so the next
      // render retries, and try the next rung now — it may be a different
      // host, and even the same one may have cooled down.
    }
  }
  return undefined;
}
