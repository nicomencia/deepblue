/**
 * A free, deterministic model photo: the lead image of the Wikipedia article
 * for that car. No LLM call, no key, no cost.
 *
 * Why the article image and not a Commons file search: Commons search is
 * generation-accurate but wildly unreliable — tried live 2026-07-27, it
 * answered a *logo* for "Suzuki Swift", door-hinge and fuel-filler close-ups
 * for "Golf VII", and Toyota Yaris Cross photos for "Mazda2 DE". An article's
 * lead image is always a proper photo of the car.
 *
 * The trade-off, stated honestly: when Wikipedia covers every generation in
 * one article, its lead image is the CURRENT generation — hunting an XP90
 * Yaris can show a 2020 one. That is why this ranks below the dossier's
 * researched photo, which is generation-specific by construction; this is the
 * free fallback that gives every model a face today.
 */

import { splitModelAndGeneration } from "@deepblue/core";

const TTL_MS = 24 * 60 * 60 * 1000;
/** A page render must never hang on someone else's API. */
const TIMEOUT_MS = 2500;
/** Wikimedia asks for a descriptive agent; anonymous bulk traffic gets blocked. */
const USER_AGENT = "deepblue/0.1 (personal second-hand car assistant)";

interface Cached {
  url?: string;
  at: number;
}
// Misses are cached too: a model Wikipedia has never heard of must not cost a
// round trip on every render of the page.
const cache = new Map<string, Cached>();

async function lookup(lang: string, query: string, make: string): Promise<string | undefined> {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=3` +
    `&prop=pageimages&piprop=thumbnail&pithumbsize=640`;

  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return undefined;

  const data = (await res.json()) as {
    query?: { pages?: Record<string, { title?: string; index?: number; thumbnail?: { source?: string } }> };
  };
  const pages = Object.values(data.query?.pages ?? {}).sort(
    (a, b) => (a.index ?? 99) - (b.index ?? 99),
  );
  for (const page of pages) {
    // Guard against a confident wrong answer: search happily returns another
    // manufacturer's car when the model name is generic.
    if (!page.thumbnail?.source || !page.title) continue;
    if (!page.title.toLowerCase().includes(make.toLowerCase())) continue;
    return page.thumbnail.source;
  }
  return undefined;
}

/**
 * Spanish article first (it is the user's market and language), English as the
 * fallback — en.wikipedia covers generations as separate articles far more
 * often, which is exactly when the generation-specific photo shows up.
 * Never throws: a photo is a nicety, and no page should fail without one.
 */
export async function fetchWikipediaPhoto(
  make: string,
  model: string,
  generation?: string,
): Promise<string | undefined> {
  const cleanModel = splitModelAndGeneration(model).model;
  // "VII (2012–2019)" → "VII": the year range is noise in a search query.
  const cleanGen = generation?.replace(/\([^)]*\)/g, "").trim();
  const query = [make, cleanModel, cleanGen].filter(Boolean).join(" ").trim();
  if (!make.trim() || !cleanModel) return undefined;

  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.url;

  let url: string | undefined;
  try {
    url = (await lookup("es", query, make)) ?? (await lookup("en", query, make));
  } catch {
    // Timeout, offline, rate limit: cache the miss briefly and move on.
    url = undefined;
  }
  cache.set(query, { url, at: Date.now() });
  return url;
}
