/**
 * Wallapop adapter — plain HTTP, no browser needed for search (verified
 * 2026-07-07, see docs/RECON.md). Chat (Phase 2) will need the Playwright
 * session; search must still run from a residential IP with gentle pacing.
 */

import type { NormalizedListing, PlatformAdapter, SearchQuery } from "@deepblue/core";

const API = "https://api.wallapop.com/api/v3/search";
const CARS_CATEGORY_ID = 100;
const ITEM_URL_PREFIX = "https://es.wallapop.com/item/";

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
  };
}

export const wallapopAdapter: PlatformAdapter = {
  platform: "wallapop",

  async search(query: SearchQuery): Promise<NormalizedListing[]> {
    const params = new URLSearchParams({ source: "search_box" });
    if (query.keywords) params.set("keywords", query.keywords);
    const loc = query.location ?? { lat: 40.4168, lon: -3.7038, radiusKm: 100 };
    params.set("latitude", String(loc.lat));
    params.set("longitude", String(loc.lon));

    // order_by=newest is not recon-verified; retry without it if rejected.
    const withOrder = new URLSearchParams(params);
    withOrder.set("order_by", "newest");
    let items = await fetchItems(withOrder);
    items ??= await fetchItems(params);
    if (items === null) throw new Error("wallapop search request failed");

    return items
      .filter((item) => item.category_id === CARS_CATEGORY_ID && !isReserved(item))
      .map(normalize)
      .filter((l): l is NormalizedListing => l !== null);
  },

  async fetchListing() {
    throw new Error("wallapop fetchListing not implemented yet");
  },
  async sendMessage() {
    throw new Error("wallapop messaging arrives in Phase 2");
  },
  async fetchReplies() {
    throw new Error("wallapop messaging arrives in Phase 2");
  },
};

async function fetchItems(params: URLSearchParams): Promise<RawItem[] | null> {
  const res = await fetch(`${API}?${params}`, { headers: HEADERS });
  if (!res.ok) return null;
  const data: unknown = await res.json();
  const items = (data as { data?: { section?: { payload?: { items?: unknown } } } })
    ?.data?.section?.payload?.items;
  return Array.isArray(items) ? (items as RawItem[]) : null;
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
    priceEur,
    make: ta.brand,
    model: ta.model,
    version: ta.version,
    year: ta.year,
    km: ta.km,
    fuel: ta.engine,
    gearbox: ta.gearbox,
    sellerType: "unknown",
    locationText: item.location?.city
      ? [item.location.city, item.location.region].filter(Boolean).join(", ")
      : undefined,
    lat: item.location?.latitude,
    lon: item.location?.longitude,
    raw: item,
  };
}
