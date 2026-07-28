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
/**
 * A miss expires far sooner than a hit, because the two are not the same kind
 * of fact. "This car's photo is at X" stays true all day; "nothing matched" is
 * often circumstantial — a throttled rung answering empty rather than
 * throwing, a category read mid-rate-limit. Caching both for 24 h left the
 * Mazda2 photoless for a whole day when a fresh process found it instantly
 * (live, 2026-07-28).
 */
const MISS_TTL_MS = 30 * 60 * 1000;
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

/**
 * Wikimedia throttles anonymous bursts hard, and resolving a whole report's
 * photos IS a burst. Giving up on the first 429 was silently expensive: the
 * rung was abandoned, a weaker one answered instead, and its worse photo got
 * stored as if it were the best we could do — which is how one report showed a
 * sedan and another the previous generation (live, 2026-07-28).
 *
 * So a 429 is waited out once, honouring `Retry-After` when it is sane. Only
 * if it persists does it become transient trouble — never cached, so the next
 * attempt starts clean.
 */
const RETRY_AFTER_CAP_MS = 10_000;

async function apiJson(url: string, retryOn429 = true): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new TransientLookupError("network/timeout");
  }
  if (res.status === 429 && retryOn429) {
    const header = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, RETRY_AFTER_CAP_MS) : 2_000;
    await new Promise((r) => setTimeout(r, wait));
    return apiJson(url, false);
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
  /**
   * Only accept an article that is genuinely about ONE generation. Searching
   * "Peugeot 207 RC" happily returns the plain "Peugeot 207" article, whose
   * lead photo carries no year and therefore passes the era gate — so the RC
   * search showed the generic 207 while its dossier showed something else.
   */
  requireGeneration?: string,
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
    if (requireGeneration) {
      const t = normalizeVehicleText(page.title);
      const named = t.includes(normalizeVehicleText(requireGeneration));
      if (!named && !/generation|generacion|series|serie/.test(t)) continue;
    }
    if (!photoMatchesEra(page.thumbnail.source, band)) continue;
    return page.thumbnail.source;
  }
  return undefined;
}

/**
 * Commons keeps a curated CATEGORY per car generation — "Toyota Yaris (XP90)",
 * "Mazda2 (DE)", "Lotus Elise (Series 2)", "Honda Fit (2nd generation)",
 * "Volkswagen Golf VII", "Suzuki Swift (2004)". Naming is inconsistent, but the
 * category itself is the identity guarantee that every filename heuristic
 * lacked: a Honda motorcycle, a Mazda CX-3 or SWIFT the Belgian bank simply
 * cannot be inside it. That leaves the era gate with only one job — pick the
 * generation among that car's photos — which is what it is good at.
 */
/**
 * Which generation code to actually search for, out of the free text research
 * puts in `generation`.
 *
 * Taking the first code was fine while research named one generation. Opus 5
 * names two — "GD (2006-2008) y GE (2009-2015)" — and first-wins picked GD, the
 * OLDER car, for a 2006-2013 hunt: the Jazz came back with a photo of the
 * previous generation (live, 2026-07-28). When several are offered, the one
 * that overlaps the hunt window most is the one being recommended.
 *
 * Tokens that merely repeat the model are still skipped: "207 RC / THP
 * (2007-2012)" must yield "RC", never "207", or the search degenerates to
 * "Peugeot 207 207" and lands on the model's generic article.
 */
export function pickGenerationCode(
  generation: string | undefined,
  cleanModel: string,
  band?: YearBand,
): string | undefined {
  if (!generation) return undefined;
  const codeOf = (segment: string): string | undefined =>
    segment
      .replace(/\([^)]*\)/g, "")
      .split(/[\s/]+/)
      .map((t) => t.replace(/[^A-Za-z0-9]/g, ""))
      .find(
        (t) =>
          t.length > 0 &&
          normalizeVehicleText(t) !== normalizeVehicleText(cleanModel) &&
          !/^\d+$/.test(t),
      );

  // "A (…) y B (…)" — each half is a candidate generation with its own years.
  const segments = generation.split(/\s+y\s+|\s+and\s+|[;,]/i).filter((s) => s.trim());
  if (segments.length < 2) return codeOf(generation);

  let best: { code: string; overlap: number } | undefined;
  for (const segment of segments) {
    const code = codeOf(segment);
    if (!code) continue;
    const years = [...segment.matchAll(/(?:19|20)\d{2}/g)].map((m) => Number(m[0]));
    // No years to compare on: keep the first usable code, as before.
    const overlap =
      years.length && band
        ? Math.max(
            0,
            Math.min(Math.max(...years), band.yearMax ?? Infinity) -
              Math.max(Math.min(...years), band.yearMin ?? -Infinity),
          )
        : 0;
    if (!best || overlap > best.overlap) best = { code, overlap };
  }
  return best?.code;
}

const BAD_CATEGORY =
  /competition|concept|racing|rally|motorcycle|taxi|police|interior|engine|wreck|crash|museum|replica/i;
const NOT_A_CAR_FILE =
  /logo|icon|\bmap\b|flag|emblem|badge|engine|interior|dashboard|wheel|seat|symbol|\.svg$/i;
const NOT_A_FRONT_SHOT = /rear|back|trasera|posterior|boot|trunk/i;
/** Body words Commons filenames actually use, in the languages they use them. */
const BODY_STYLE =
  /hatchback|liftback|sedan|saloon|berlina|limousine|estate|wagon|touring|kombi|coupe|coupé|cabriolet|convertible|roadster|targa|pickup|van|minivan|mpv|suv/i;

async function commonsCategoryPhoto(
  make: string,
  model: string,
  genCode: string | undefined,
  band?: YearBand,
  body?: string,
): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const q of [
    genCode && body ? `${make} ${model} ${genCode} ${body}` : "",
    genCode ? `${make} ${model} ${genCode}` : "",
    `${make} ${model}`,
  ].filter(Boolean)) {
    const s = (await apiJson(
      "https://commons.wikimedia.org/w/api.php?format=json&origin=*&action=query" +
        `&list=search&srnamespace=14&srlimit=10&srsearch=${encodeURIComponent(q)}`,
    )) as { query?: { search?: Array<{ title?: string }> } } | undefined;
    for (const r of s?.query?.search ?? []) {
      if (r.title) seen.add(r.title.replace(/^Category:/, ""));
    }
  }
  if (!seen.size) return undefined;

  const m = normalizeVehicleText(model);
  const g = genCode ? normalizeVehicleText(genCode) : "";
  const yearsOf = (s: string) => [...s.matchAll(/(?:19|20)\d{2}/g)].map((x) => Number(x[0]));
  const inBand = (y: number) =>
    y >= (band?.yearMin ?? -Infinity) - SLACK_BEFORE && y <= (band?.yearMax ?? Infinity) + SLACK_AFTER;

  const ranked = [...seen]
    .map((cat) => {
      const n = normalizeVehicleText(cat);
      // The MODEL must be named, not just the make: "Toyota Vios (XP90)" is a
      // different car on the same platform code and outranked the Yaris.
      if (!n.includes(m) || BAD_CATEGORY.test(cat)) return { cat, score: -1 };
      // Commons splits a generation's bodies into sibling subcategories, and
      // the parent mixes them. When we know which body Spain got, the matching
      // subcategory is the single best thing we can pick — and a sibling
      // naming a DIFFERENT body is disqualified outright, not merely
      // outranked: that is the Yaris sedan, and it is the wrong car.
      const catBody = cat.match(BODY_STYLE)?.[0].toLowerCase();
      if (body) {
        const wanted = body.toLowerCase();
        if (catBody && catBody !== wanted) return { cat, score: -1 };
      }
      let score = 0;
      if (body && catBody === body.toLowerCase()) score += 150;
      if (g && n.includes(g)) score += 100;
      const ys = yearsOf(cat);
      if (ys.length) {
        // A year in a CATEGORY name is when the generation STARTED
        // ("Suzuki Swift (2004)" ran to 2010), not one car's model year. Only
        // a start after the hunt window ends can be ruled out.
        if (ys.some(inBand)) score += 60;
        else if (ys.every((y) => y > (band?.yearMax ?? Infinity) + SLACK_AFTER)) score -= 80;
        else score += 20;
      }
      // The bare family category is usually an empty container — everything
      // lives in its per-generation subcategories ("Category:Suzuki Swift"
      // holds 0 files, "Suzuki Swift (2004)" holds 50). Worth trying last,
      // never worth preferring.
      if (n === normalizeVehicleText(`${make} ${model}`) || n === m) score += 5;
      if (/generation|series/i.test(cat)) score += 10;
      return { cat, score };
    })
    .filter((x) => x.score > -1)
    .sort((a, b) => b.score - a.score);

  for (const { cat } of ranked.slice(0, 3)) {
    // The chosen category IS the generation, so its start year extends the
    // window: a 2004 photo inside "Suzuki Swift (2004)" is the same car a
    // 2006 hunt is looking for, even though 2004 sits outside that band.
    const catStart = Math.min(...yearsOf(cat), Infinity);
    const catBand: YearBand | undefined = band
      ? { yearMin: Number.isFinite(catStart) ? Math.min(band.yearMin ?? catStart, catStart) : band.yearMin, yearMax: band.yearMax }
      : band;
    // Per candidate, not per function: one rate-limited call must not throw
    // away the categories we have not tried yet — that is how the Swift ended
    // up with no photo while its 50-file category sat one rung below.
    let d:
      | { query?: { pages?: Record<string, { title?: string; imageinfo?: Array<{ thumburl?: string; mime?: string }> }> } }
      | undefined;
    try {
      d = (await apiJson(
        "https://commons.wikimedia.org/w/api.php?format=json&origin=*&action=query" +
          `&generator=categorymembers&gcmtitle=Category:${encodeURIComponent(cat)}` +
          "&gcmtype=file&gcmlimit=50&prop=imageinfo&iiprop=url|mime&iiurlwidth=640",
      )) as typeof d;
    } catch {
      continue;
    }

    const files = Object.values(d?.query?.pages ?? {})
      .map((p) => ({
        name: decodeURIComponent(p.title ?? "").replace(/^File:/, ""),
        url: p.imageinfo?.[0]?.thumburl,
        mime: p.imageinfo?.[0]?.mime ?? "",
      }))
      .filter((f) => f.url && /^image\/jpe?g$/.test(f.mime) && !NOT_A_CAR_FILE.test(f.name));

    // A filename that names an in-band year is the surest pick; one with no
    // year at all is still inside the right category, so it is acceptable.
    const dated = files.filter((f) => photoMatchesEra(f.url!, catBand) && /(?:19|20)\d{2}/.test(f.name));
    const undated = files.filter((f) => !/(?:19|20)\d{2}/.test(f.name));
    const pool = dated.length ? dated : undated;

    // Body style decides which of the right car's photos we show. Taking the
    // first non-rear file gave the Yaris XP90 a SEDAN — a body barely sold in
    // Spain — purely because it sorted first (live, 2026-07-28).
    //
    // An unqualified filename is the canonical shot: nobody writes the body
    // into "Toyota Yaris II Facelift front.JPG" because it IS the Yaris. A
    // filename that spells out a body is describing a variant, so it only wins
    // when that body dominates the category — which is how an MX-5 still gets
    // its convertible and a Jazz its hatchback, without hard-coding either.
    const bodyCount = new Map<string, number>();
    for (const f of pool) {
      const fileBody = f.name.match(BODY_STYLE)?.[0].toLowerCase();
      if (fileBody) bodyCount.set(fileBody, (bodyCount.get(fileBody) ?? 0) + 1);
    }
    const wanted = body?.toLowerCase();
    const score = (name: string): number => {
      const fileBody = name.match(BODY_STYLE)?.[0].toLowerCase();
      let s: number;
      if (wanted && fileBody) s = fileBody === wanted ? 120 : -200;
      else if (fileBody) s = Math.min(4 * (bodyCount.get(fileBody) ?? 0), 40);
      else s = 50;
      if (NOT_A_FRONT_SHOT.test(name)) s -= 100;
      return s;
    };
    const best = [...pool].sort((a, b) => score(b.name) - score(a.name))[0];
    if (best?.url) return best.url;
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
  /**
   * Body sold here, in Commons' vocabulary ("hatchback", "convertible"). When
   * known it decides which of a generation's sibling categories we read, which
   * is the only reliable way to avoid showing a body this market never got.
   */
  body?: string,
): Promise<string | undefined> {
  const cleanModel = splitModelAndGeneration(model).model;
  if (!make.trim() || !cleanModel) return undefined;
  const genCode = pickGenerationCode(generation, cleanModel, band);

  const bandKey = `${band?.yearMin ?? ""}-${band?.yearMax ?? ""}`;
  const attempts: Array<[string, () => Promise<string | undefined>]> = [];

  if (genCode) {
    const q = `${make} ${cleanModel} ${genCode}`;
    attempts.push([
      `wp:${q}`,
      async () =>
        (await wikipediaLead("es", q, make, cleanModel, band, genCode)) ??
        wikipediaLead("en", q, make, cleanModel, band, genCode),
    ]);
  }
  // Before the loose fallbacks: a curated per-generation category is the only
  // source that guarantees the CAR, leaving the era gate to pick the year.
  attempts.push([
    `cc:${make} ${cleanModel} ${genCode ?? ""} ${body ?? ""}`,
    () => commonsCategoryPhoto(make, cleanModel, genCode, band, body),
  ]);
  if (genCode) {
    attempts.push([`wd:${make} ${cleanModel} ${genCode}`, () => wikidataGenerationImage(make, cleanModel, genCode, band)]);
  }
  const plain = `${make} ${cleanModel}`;
  attempts.push([`wp:${plain}`, async () => (await wikipediaLead("es", plain, make, cleanModel, band)) ?? wikipediaLead("en", plain, make, cleanModel, band)]);

  for (const [key, run] of attempts) {
    const cacheKey = `${key}|${bandKey}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < (hit.url ? TTL_MS : MISS_TTL_MS)) {
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
