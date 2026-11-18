import type { BriefCriteria } from "@deepblue/core";

/** Madrid — only ever the origin for a radius the user actually asked for. */
const SPAIN_CENTER = { lat: 40.4168, lon: -3.7038 };

/**
 * Centres a person can pick by name. Asking for latitude and longitude made
 * the radius unusable for anyone who doesn't keep their coordinates in their
 * head. City centroids are enough: the evaluator already adds slack for
 * sellers geocoded to their town centre.
 */
export const SEARCH_CENTERS: ReadonlyArray<{ key: string; name: string; lat: number; lon: number }> = [
  { key: "madrid", name: "Madrid", lat: 40.4168, lon: -3.7038 },
  { key: "barcelona", name: "Barcelona", lat: 41.3874, lon: 2.1686 },
  { key: "valencia", name: "Valencia", lat: 39.4699, lon: -0.3763 },
  { key: "sevilla", name: "Sevilla", lat: 37.3891, lon: -5.9845 },
  { key: "zaragoza", name: "Zaragoza", lat: 41.6488, lon: -0.8891 },
  { key: "malaga", name: "Málaga", lat: 36.7213, lon: -4.4214 },
  { key: "murcia", name: "Murcia", lat: 37.9922, lon: -1.1307 },
  { key: "palma", name: "Palma", lat: 39.5696, lon: 2.6502 },
  { key: "las-palmas", name: "Las Palmas de Gran Canaria", lat: 28.1235, lon: -15.4363 },
  { key: "santa-cruz", name: "Santa Cruz de Tenerife", lat: 28.4636, lon: -16.2518 },
  { key: "bilbao", name: "Bilbao", lat: 43.263, lon: -2.935 },
  { key: "alicante", name: "Alicante", lat: 38.3452, lon: -0.481 },
  { key: "cordoba", name: "Córdoba", lat: 37.8882, lon: -4.7794 },
  { key: "valladolid", name: "Valladolid", lat: 41.6523, lon: -4.7245 },
  { key: "vigo", name: "Vigo", lat: 42.2406, lon: -8.7207 },
  { key: "a-coruna", name: "A Coruña", lat: 43.3623, lon: -8.4115 },
  { key: "granada", name: "Granada", lat: 37.1773, lon: -3.5986 },
  { key: "oviedo", name: "Oviedo", lat: 43.3619, lon: -5.8494 },
  { key: "pamplona", name: "Pamplona", lat: 42.8125, lon: -1.6458 },
  { key: "santander", name: "Santander", lat: 43.4623, lon: -3.81 },
  { key: "san-sebastian", name: "San Sebastián", lat: 43.3183, lon: -1.9812 },
  { key: "salamanca", name: "Salamanca", lat: 40.9701, lon: -5.6635 },
  { key: "burgos", name: "Burgos", lat: 42.3439, lon: -3.6969 },
  { key: "leon", name: "León", lat: 42.5987, lon: -5.5671 },
  { key: "logrono", name: "Logroño", lat: 42.4627, lon: -2.445 },
  { key: "girona", name: "Girona", lat: 41.9794, lon: 2.8214 },
  { key: "tarragona", name: "Tarragona", lat: 41.1189, lon: 1.2445 },
  { key: "castellon", name: "Castellón de la Plana", lat: 39.9864, lon: -0.0513 },
  { key: "toledo", name: "Toledo", lat: 39.8628, lon: -4.0273 },
  { key: "badajoz", name: "Badajoz", lat: 38.8794, lon: -6.9707 },
  { key: "cadiz", name: "Cádiz", lat: 36.5271, lon: -6.2886 },
  { key: "almeria", name: "Almería", lat: 36.834, lon: -2.4637 },
];

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

  // A named centre wins; raw coordinates stay accepted (the brief form).
  const center = SEARCH_CENTERS.find((c) => c.key === String(formData.get("center") ?? ""));
  if (center) return { lat: center.lat, lon: center.lon, radiusKm };

  return {
    lat: coord("lat") ?? SPAIN_CENTER.lat,
    lon: coord("lon") ?? SPAIN_CENTER.lon,
    radiusKm,
  };
}
