/**
 * AutoScout24 (Spain) adapter — the search page is server-rendered Next.js
 * with the full result set embedded as JSON in __NEXT_DATA__ (verified
 * 2026-07-07, see docs/RECON.md). Plain HTTP, no browser. Sellers are
 * mostly dealers; contact flows via email in Phase 2 (the Core's lane).
 */

import type { NormalizedListing, PlatformAdapter, SearchQuery } from "@deepblue/core";

const BASE = "https://www.autoscout24.es";

const HEADERS = {
  accept: "text/html",
  "accept-language": "es-ES,es;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

/** Loose shape of an embedded listing — everything optional, nothing trusted. */
interface RawListing {
  id?: string;
  url?: string;
  price?: { priceRaw?: number; priceEvaluation?: number };
  vehicle?: {
    make?: string;
    model?: string;
    modelVersionInput?: string;
    transmission?: string;
    fuel?: string;
    mileageInKm?: string;
  };
  vehicleDetails?: Array<{ data?: string; iconName?: string }>;
  seller?: { type?: string; companyName?: string };
  location?: { zip?: string; city?: string; countryCode?: string };
}

export const autoscout24Adapter: PlatformAdapter = {
  platform: "autoscout24",

  async search(query: SearchQuery): Promise<NormalizedListing[]> {
    if (!query.make || !query.model) {
      throw new Error("autoscout24 search needs make and model");
    }
    const params = new URLSearchParams();
    if (query.yearMin !== undefined) params.set("fregfrom", String(query.yearMin));
    if (query.priceMaxEur !== undefined) params.set("priceto", String(query.priceMaxEur));

    const url = `${BASE}/lst/${slugify(query.make)}/${slugify(query.model)}?${params}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`autoscout24 search failed: HTTP ${res.status}`);

    const html = await res.text();
    const match = html.match(
      /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!match?.[1]) throw new Error("autoscout24: __NEXT_DATA__ not found (layout changed?)");

    const data: unknown = JSON.parse(match[1]);
    const listings = (
      data as { props?: { pageProps?: { listings?: unknown } } }
    )?.props?.pageProps?.listings;
    if (!Array.isArray(listings)) {
      throw new Error("autoscout24: listings array not found (payload changed?)");
    }

    return (listings as RawListing[])
      .map(normalize)
      .filter((l): l is NormalizedListing => l !== null);
  },

  async fetchListing() {
    throw new Error("autoscout24 fetchListing not implemented yet");
  },
  async sendMessage() {
    throw new Error("autoscout24 contact arrives in Phase 2 (email lane)");
  },
  async fetchReplies() {
    throw new Error("autoscout24 contact arrives in Phase 2 (email lane)");
  },
};

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, "-");
}

/** "158.860 km" (es-ES thousands dots) → 158860 */
function parseKm(mileage: string | undefined): number | undefined {
  if (!mileage) return undefined;
  const digits = mileage.replace(/\D/g, "");
  return digits ? Number(digits) : undefined;
}

/** vehicleDetails calendar entry "07/2017" → 2017 */
function parseYear(details: RawListing["vehicleDetails"]): number | undefined {
  const calendar = details?.find((d) => d.iconName === "calendar")?.data;
  const year = calendar?.match(/(\d{4})/)?.[1];
  return year ? Number(year) : undefined;
}

/** vehicleDetails speedometer entry "85 kW (116 CV)" → 116 */
function parsePowerCv(details: RawListing["vehicleDetails"]): number | undefined {
  const power = details?.find((d) => d.iconName === "speedometer")?.data;
  const cv = power?.match(/\((\d+)\s*CV\)/i)?.[1];
  return cv ? Number(cv) : undefined;
}

function normalize(item: RawListing): NormalizedListing | null {
  const v = item.vehicle ?? {};
  if (!item.id || !v.make || !v.model) return null;

  return {
    platform: "autoscout24",
    platformListingId: item.id,
    url: item.url ? `${BASE}${item.url}` : `${BASE}/`,
    title: [v.make, v.model, v.modelVersionInput].filter(Boolean).join(" "),
    priceEur: item.price?.priceRaw,
    make: v.make,
    model: v.model,
    version: v.modelVersionInput,
    year: parseYear(item.vehicleDetails),
    km: parseKm(v.mileageInKm),
    fuel: v.fuel,
    gearbox: v.transmission,
    powerCv: parsePowerCv(item.vehicleDetails),
    sellerType: item.seller?.type?.toLowerCase() === "dealer" ? "dealer" : "private",
    sellerName: item.seller?.companyName,
    locationText: item.location?.city
      ? [item.location.city, item.location.zip].filter(Boolean).join(", ")
      : undefined,
    raw: item,
  };
}
