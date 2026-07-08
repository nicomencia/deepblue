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
 * Stable identity of the physical car across accounts of the same network.
 * Only the explicit internal REF is trusted (high precision) — spec
 * fingerprints collide too easily to kill leads over.
 */
export function extractDedupKey(
  platform: string,
  description: string | undefined,
): string | undefined {
  if (!description) return undefined;
  const match = LISTING_REF_RE.exec(description);
  return match?.[1] ? `${platform}|ref:${match[1]}` : undefined;
}
