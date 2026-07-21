/**
 * Wallapop adapter — plain HTTP, no browser needed for search (verified
 * 2026-07-07, see docs/RECON.md). Chat (Phase 2) will need the Playwright
 * session; search must still run from a residential IP with gentle pacing.
 */

import { setTimeout as sleep } from "node:timers/promises";
import {
  extractFirstImageUrl,
  sanitizePowerCv,
  type ListingCheck,
  type ListingRef,
  type NormalizedListing,
  type PlatformAdapter,
  type SearchQuery,
} from "@deepblue/core";
import { assertNotBlocked } from "../blocked.js";

const API_BASE = "https://api.wallapop.com/api/v3";
const API = `${API_BASE}/search`;
const CARS_CATEGORY_ID = 100;
const ITEM_URL_PREFIX = "https://es.wallapop.com/item/";

/** Wallapop's engine param vocabulary (verified: gasoil → all-Diesel results). */
const WALLAPOP_ENGINE: Record<NonNullable<SearchQuery["fuel"]>, string> = {
  gasoline: "gasoline",
  diesel: "gasoil",
  hybrid: "hybrid",
  electric: "electric",
};

const HEADERS = {
  accept: "application/json",
  // 403 without X-DeviceOS — the one magic header (RECON.md).
  "x-deviceos": "0",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

/** Loose shape of a search item — everything optional, nothing trusted. */
interface RawItem {
  id?: string | number;
  title?: string;
  description?: string;
  category_id?: number;
  reserved?: boolean | { flag?: boolean };
  price?: { amount?: number; currency?: string };
  web_slug?: string;
  location?: {
    latitude?: number;
    longitude?: number;
    city?: string;
    region?: string;
  };
  type_attributes?: {
    brand?: string;
    model?: string;
    version?: string;
    year?: number;
    km?: number;
    engine?: string;
    gearbox?: string;
    horsepower?: number;
  };
}

export const wallapopAdapter: PlatformAdapter = {
  platform: "wallapop",

  async search(query: SearchQuery): Promise<NormalizedListing[]> {
    // All params below verified live 2026-07-07 (docs/RECON.md): car filters
    // only take effect with category_id (singular) set to the Coches category.
    const params = new URLSearchParams({
      source: "search_box",
      category_id: String(CARS_CATEGORY_ID),
      order_by: "newest",
    });
    if (query.keywords) params.set("keywords", query.keywords);
    const loc = query.location ?? { lat: 40.4168, lon: -3.7038, radiusKm: 100 };
    params.set("latitude", String(loc.lat));
    params.set("longitude", String(loc.lon));
    if (query.priceMaxEur !== undefined) params.set("max_sale_price", String(query.priceMaxEur));
    if (query.priceMinEur !== undefined) params.set("min_sale_price", String(query.priceMinEur));
    if (query.yearMin !== undefined) params.set("min_year", String(query.yearMin));
    if (query.yearMax !== undefined) params.set("max_year", String(query.yearMax));
    if (query.kmMax !== undefined) params.set("max_km", String(query.kmMax));
    if (query.fuel !== undefined) params.set("engine", WALLAPOP_ENGINE[query.fuel]);

    // Fallback: if the filtered request is ever rejected (param drift), retry
    // with the minimal verified set rather than failing the sweep. A 403/429
    // never reaches the fallback — fetchItems throws PlatformBlockedError
    // first, because retrying against a block is how accounts get banned.
    let items = await fetchItems(params);
    items ??= await fetchItems(
      new URLSearchParams({
        source: "search_box",
        category_id: String(CARS_CATEGORY_ID),
        keywords: query.keywords ?? "",
        latitude: String(loc.lat),
        longitude: String(loc.lon),
      }),
    );
    if (items === null) throw new Error("wallapop search request failed");

    return items
      .filter((item) => item.category_id === CARS_CATEGORY_ID && !isReserved(item))
      .map(normalize)
      .filter((l): l is NormalizedListing => l !== null);
  },

  async fetchListing(ref: ListingRef): Promise<NormalizedListing> {
    // Detail page carries what search omits: gearbox, power, doors, eco label,
    // full description — several of the agent's open questions answer themselves.
    let detail = await fetchJson<ItemDetail>(`${API_BASE}/items/${ref.platformListingId}`);
    if (!detail?.id && ref.url) {
      // Adoption path: a pasted web URL carries a legacy numeric id the API
      // rejects; the item page's __NEXT_DATA__ holds the canonical one.
      const canonical = await resolveItemIdFromPage(ref.url);
      if (canonical) {
        await sleep(500 + Math.random() * 1000);
        detail = await fetchJson<ItemDetail>(`${API_BASE}/items/${canonical}`);
      }
    }
    if (!detail?.id) throw new Error(`wallapop item ${ref.platformListingId} not found`);

    // Seller reputation for the sellerCredibility factor. Non-fatal if missing.
    let user: UserProfile | null = null;
    let stats: UserStats | null = null;
    const userId = detail.user?.id;
    if (userId) {
      await sleep(500 + Math.random() * 1000); // human pacing between calls
      user = await fetchJson<UserProfile>(`${API_BASE}/users/${userId}`);
      await sleep(500 + Math.random() * 1000);
      stats = await fetchJson<UserStats>(`${API_BASE}/users/${userId}/stats`);
    }

    return normalizeDetail(detail, user, stats);
  },

  async checkListing(ref: ListingRef): Promise<ListingCheck> {
    // The item's own endpoint is the ground truth: a 404 means genuinely
    // gone (sold/removed), which aging off the newest-first search page does
    // not. One request, no user/stats calls — deliberately lighter than
    // fetchListing so liveness sweeps stay within pacing hygiene.
    const res = await fetch(`${API_BASE}/items/${ref.platformListingId}`, { headers: HEADERS });
    assertNotBlocked("wallapop", res.status, "check_listing");
    if (res.status === 404 || res.status === 410) {
      return { platform: "wallapop", platformListingId: ref.platformListingId, status: "gone" };
    }
    if (!res.ok) throw new Error(`wallapop check failed: HTTP ${res.status}`);
    const detail = (await res.json()) as ItemDetail;
    const status = detailFlagsStatus(detail);
    // The probe already paid for the detail — carry the current price so the
    // Core can diff it against the stored one (price drops are signal).
    const priceEur =
      detail.price?.cash?.currency === undefined || detail.price?.cash?.currency === "EUR"
        ? detail.price?.cash?.amount
        : undefined;
    return {
      platform: "wallapop",
      platformListingId: ref.platformListingId,
      status,
      ...(status === "active" && priceEur ? { priceEur } : {}),
    };
  },

  async sendMessage(ref, body) {
    // The one browser-bound operation: rides the logged-in persistent
    // profile (pnpm runner:login). Config is read here, not injected —
    // the adapter object stays a plain const.
    const { loadConfig } = await import("../config.js");
    const { sendWallapopMessage } = await import("../wallapop-chat.js");
    const config = loadConfig();
    return sendWallapopMessage(config.browserProfileDir, config.chatHeadless, ref, body);
  },
  async fetchReplies(ref) {
    const { loadConfig } = await import("../config.js");
    const { fetchWallapopReplies } = await import("../wallapop-chat.js");
    const config = loadConfig();
    return fetchWallapopReplies(config.browserProfileDir, config.chatHeadless, ref);
  },
};

async function fetchItems(params: URLSearchParams): Promise<RawItem[] | null> {
  const res = await fetch(`${API}?${params}`, { headers: HEADERS });
  assertNotBlocked("wallapop", res.status, "search");
  if (!res.ok) return null;
  const data: unknown = await res.json();
  const items = (data as { data?: { section?: { payload?: { items?: unknown } } } })
    ?.data?.section?.payload?.items;
  return Array.isArray(items) ? (items as RawItem[]) : null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: HEADERS });
  assertNotBlocked("wallapop", res.status, "fetch");
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/** Canonical item id from an item web page ("pageProps":{"item":{"id":"…"}}). */
async function resolveItemIdFromPage(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: HEADERS });
  assertNotBlocked("wallapop", res.status, "resolve_id");
  if (!res.ok) return null;
  const html = await res.text();
  const match =
    html.match(/"pageProps":\{"item":\{"id":"([a-z0-9]+)"/) ??
    html.match(/"itemsFavoriteState":\{"([a-z0-9]+)":/);
  return match?.[1] ?? null;
}

// --- Item detail / user shapes (all optional, nothing trusted) --------------

/** Detail type_attributes wrap every field as { value, text }. */
type DetailAttr = { value?: string; text?: string };

interface ItemDetail {
  id?: string;
  title?: { original?: string };
  description?: { original?: string };
  slug?: string;
  price?: { cash?: { amount?: number; currency?: string } };
  location?: { latitude?: number; longitude?: number; city?: string; region?: string };
  type_attributes?: Record<string, DetailAttr | undefined>;
  counters?: { views?: number; favorites?: number; conversations?: number };
  /** Item state flags — best-effort; the reliable "gone" signal is the 404. */
  flags?: { reserved?: boolean; sold?: boolean; expired?: boolean; banned?: boolean };
  reserved?: boolean | { flag?: boolean };
  user?: { id?: string };
}

/** Reads item flags: sold/expired ⇒ gone, reserved ⇒ reserved, else active. */
function detailFlagsStatus(detail: ItemDetail): ListingCheck["status"] {
  const f = detail.flags ?? {};
  if (f.sold === true || f.expired === true || f.banned === true) return "gone";
  if (f.reserved === true) return "reserved";
  if (typeof detail.reserved === "boolean" ? detail.reserved : detail.reserved?.flag === true) {
    return "reserved";
  }
  return "active";
}

interface UserProfile {
  id?: string;
  micro_name?: string;
  type?: string;
  register_date?: number | string;
}

interface UserStats {
  rating_average?: number;
  ratings?: Array<{ type?: string; value?: number }>;
  counters?: Array<{ type?: string; value?: number }>;
}

function attrNum(attr: DetailAttr | undefined): number | undefined {
  const n = attr?.value !== undefined ? Number(attr.value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function counter(stats: UserStats | null, type: string): number | undefined {
  return stats?.counters?.find((c) => c.type === type)?.value;
}

function normalizeDetail(
  detail: ItemDetail,
  user: UserProfile | null,
  stats: UserStats | null,
): NormalizedListing {
  const ta = detail.type_attributes ?? {};
  const priceEur =
    detail.price?.cash?.currency === undefined || detail.price?.cash?.currency === "EUR"
      ? detail.price?.cash?.amount
      : undefined;

  return {
    platform: "wallapop",
    platformListingId: detail.id ?? "",
    url: detail.slug ? `${ITEM_URL_PREFIX}${detail.slug}` : `${ITEM_URL_PREFIX}${detail.id}`,
    title: detail.title?.original ?? "",
    description: detail.description?.original,
    imageUrl: extractFirstImageUrl(detail),
    priceEur,
    make: ta.brand?.value ?? ta.brand?.text,
    model: ta.model?.value ?? ta.model?.text,
    version: ta.version?.value ?? ta.version?.text,
    year: attrNum(ta.year),
    km: attrNum(ta.km),
    fuel: ta.engine?.text ?? ta.engine?.value,
    gearbox: ta.gear_box?.text ?? ta.gear_box?.value,
    powerCv: sanitizePowerCv(attrNum(ta.horsepower)),
    ecoLabel: ta.eco_label?.value,
    countryCode: "ES", // Wallapop is Spain-only
    sellerType: user?.type && user.type !== "normal" ? "dealer" : "private",
    sellerName: user?.micro_name,
    sellerRating: stats?.rating_average,
    sellerReviewCount:
      counter(stats, "reviews") ?? stats?.ratings?.find((r) => r.type === "reviews")?.value,
    sellerSoldCount: counter(stats, "sold") ?? counter(stats, "sells"),
    locationText: detail.location?.city
      ? [detail.location.city, detail.location.region].filter(Boolean).join(", ")
      : undefined,
    lat: detail.location?.latitude,
    lon: detail.location?.longitude,
    raw: { detail, user, stats },
  };
}

function isReserved(item: RawItem): boolean {
  if (typeof item.reserved === "boolean") return item.reserved;
  return item.reserved?.flag === true;
}

function normalize(item: RawItem): NormalizedListing | null {
  if (item.id === undefined || !item.title) return null;
  const ta = item.type_attributes ?? {};
  const priceEur =
    item.price?.amount !== undefined &&
    (item.price.currency === undefined || item.price.currency === "EUR")
      ? item.price.amount
      : undefined;

  return {
    platform: "wallapop",
    platformListingId: String(item.id),
    url: item.web_slug ? `${ITEM_URL_PREFIX}${item.web_slug}` : `${ITEM_URL_PREFIX}${item.id}`,
    title: item.title,
    description: item.description,
    imageUrl: extractFirstImageUrl(item),
    priceEur,
    make: ta.brand,
    model: ta.model,
    version: ta.version,
    year: ta.year,
    km: ta.km,
    fuel: ta.engine,
    gearbox: ta.gearbox,
    powerCv: sanitizePowerCv(typeof ta.horsepower === "number" ? ta.horsepower : undefined),
    countryCode: "ES", // Wallapop is Spain-only
    sellerType: "unknown",
    locationText: item.location?.city
      ? [item.location.city, item.location.region].filter(Boolean).join(", ")
      : undefined,
    lat: item.location?.latitude,
    lon: item.location?.longitude,
    raw: item,
  };
}
