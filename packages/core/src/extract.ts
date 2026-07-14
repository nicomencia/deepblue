/**
 * Rule-based extraction from listing free text. Born from a real pattern:
 * compraventa chains (Flexicar & co.) list the financing-conditional price
 * as the headline and bury the real cash price in the description — and
 * cross-post the same physical car from several franchise accounts, only
 * distinguishable by their internal reference number.
 */

/** "Precio al contado: 13.490€ (IVA incluido)" and looser variants, with or without a decimal tail. */
const CASH_PRICE_RE = /(?:precio\s+)?al\s+contado[:\s]*([\d][\d.\s]{2,8})(?:,\d{1,2})?\s*€/i;

/** Dealer internal reference, e.g. "REF: 903000000234676". */
const LISTING_REF_RE = /\bREF[:.\s]*([0-9]{6,20})\b/i;

/**
 * Parse the real cash price out of the ad text. Returns undefined when the
 * text has none or the number fails sanity checks (garbage matches, or wildly
 * out of proportion with the listed price — > 3x either way).
 */
export function extractCashPriceEur(
  description: string | undefined,
  listedPriceEur?: number,
): number | undefined {
  if (!description) return undefined;
  const match = CASH_PRICE_RE.exec(description);
  if (!match?.[1]) return undefined;

  // "13.490" / "13 490" / "13490" — dots and spaces are thousand separators.
  const value = Number.parseInt(match[1].replace(/[.\s]/g, ""), 10);
  if (!Number.isFinite(value) || value < 500 || value > 500_000) return undefined;
  if (
    listedPriceEur !== undefined &&
    (value > listedPriceEur * 3 || value < listedPriceEur / 3)
  ) {
    return undefined;
  }
  return value;
}

/**
 * Stable identity of the physical car across accounts of the same network,
 * from the dealer's explicit internal REF in the ad text (high precision).
 */
export function extractDedupKey(
  platform: string,
  description: string | undefined,
): string | undefined {
  if (!description) return undefined;
  const match = LISTING_REF_RE.exec(description);
  return match?.[1] ? `${platform}|ref:${match[1]}` : undefined;
}

/**
 * Fallback identity when the ad has no REF: the exact odometer reading.
 * Born from real data (AUTOHERO, 2026-07-15: one Golf posted from 7 city
 * accounts — same 122.065 km to the kilometer, same price, consecutive ids).
 * A generic spec fingerprint collides too easily to kill leads over, but
 * exact km + exact price + same model/year identifies the physical unit:
 * two genuinely distinct cars don't share an odometer to the kilometer AND
 * a price. km is required non-round (dealers round template mileages) and
 * every field must be present — missing data never fingerprints.
 */
export function fingerprintDedupKey(listing: {
  platform: string;
  make?: string;
  model?: string;
  version?: string;
  year?: number;
  km?: number;
  priceEur?: number;
}): string | undefined {
  const { platform, make, model, version, year, km, priceEur } = listing;
  if (!make || !model || year === undefined || km === undefined || priceEur === undefined) {
    return undefined;
  }
  // Rounded odometers (120.000, 89.500) are dealer templates, not readings —
  // they'd collide across real units, so they never fingerprint.
  if (km < 1000 || km % 500 === 0) return undefined;
  if (priceEur <= 0) return undefined;

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return `${platform}|fp:${norm(make)}|${norm(model)}|${norm(version ?? "")}|${year}|${km}|${priceEur}`;
}

/**
 * First photo URL out of a Wallapop payload — works on live adapter objects
 * (search item / item detail) and on stored `raw` columns, which may wrap the
 * detail as { detail, user, stats }. Wallapop has shipped two image shapes:
 * modern { images: [{ urls: { medium|big|small } }] } and legacy flat
 * { images: [{ medium|large|original|small }] }; both are handled.
 */
export function extractFirstImageUrl(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const container = raw as { detail?: unknown; images?: unknown };
  const images =
    Array.isArray(container.images) ? container.images
    : container.detail && typeof container.detail === "object"
      ? (container.detail as { images?: unknown }).images
      : undefined;
  if (!Array.isArray(images) || images.length === 0) return undefined;

  const first = images[0] as
    | { urls?: Record<string, unknown> } & Record<string, unknown>
    | null;
  if (first === null || typeof first !== "object") return undefined;

  // Medium (~640px) is the email sweet spot; fall through to whatever exists.
  const candidates = first.urls && typeof first.urls === "object"
    ? [first.urls.medium, first.urls.big, first.urls.small]
    : [first.medium, first.large, first.original, first.small, first.xlarge];
  const url = candidates.find((c): c is string => typeof c === "string" && c.startsWith("http"));
  return url;
}

/**
 * Sellers type anything into structured fields: horsepower has arrived as
 * "1.4" (the displacement) and killed a whole ingest batch against the
 * integer column. Plausible car power is a whole number of CV in [20, 1500];
 * everything else is garbage and becomes undefined, never an error.
 */
export function sanitizePowerCv(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const cv = Math.round(value);
  if (cv !== value || cv < 20 || cv > 1500) return undefined;
  return cv;
}
