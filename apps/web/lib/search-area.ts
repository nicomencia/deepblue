import type { BriefCriteria } from "@deepblue/core";

/** Madrid — only ever the origin for a radius the user actually asked for. */
const SPAIN_CENTER = { lat: 40.4168, lon: -3.7038 };

/**
 * The search area of a brief, from its form.
 *
 * **No radius means all of Spain**: the location is left off the criteria
 * entirely, so the evaluator runs no distance check at all. That is the default
 * on purpose — Wallapop ignores `distance` and returns country-wide results
 * anyway (RECON.md), so a radius only ever throws away cars the sweep already
 * paid to fetch. For a thin nationwide market (a GR Yaris: ~6 units in the
 * whole country) a circle drawn round one city is how a brief finds nothing.
 *
 * Coordinates without a radius mean nothing and are ignored: a centre cannot
 * filter on its own.
 */
export function searchArea(formData: FormData): BriefCriteria["location"] | undefined {
  const raw = String(formData.get("radiusKm") ?? "").replace(/[.\s]/g, "");
  const radiusKm = Number(raw);
  if (!raw || !Number.isFinite(radiusKm) || radiusKm <= 0) return undefined;

  // Coordinates keep their decimal point and accept the Spanish comma; a bare
  // Number("") is 0, which once aimed a sweep at the Gulf of Guinea.
  const coord = (name: string): number | undefined => {
    const s = String(formData.get(name) ?? "").trim().replace(",", ".");
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    lat: coord("lat") ?? SPAIN_CENTER.lat,
    lon: coord("lon") ?? SPAIN_CENTER.lon,
    radiusKm,
  };
}
