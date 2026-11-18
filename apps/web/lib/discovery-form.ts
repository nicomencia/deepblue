/**
 * The discovery intake: what the form offers, and how a submitted form becomes
 * a DiscoveryProfile.
 *
 * Designed for two things at once (Nico, 2026-11-18): room to write — the
 * free text is where a buyer says what actually matters — and controls that
 * force the few facts the advisor cannot do without. Those facts used to be
 * optional free-text lists typed "one per line" and coordinates nobody knows;
 * now they are dropdowns and checkboxes, and the lists accept commas.
 *
 * Pure: no DB, no Next, so it is tested directly.
 */

import { discoveryProfileSchema, ECO_LABELS, type BodyStyle, type DiscoveryProfile } from "@deepblue/core";
import { z } from "zod";
import { searchArea } from "./search-area";

/** Km per year as ranges: nobody knows their exact figure, everybody knows the band. */
export const KM_BANDS: ReadonlyArray<{ value: string; label: string; km?: number }> = [
  { value: "lt5", label: "Menos de 5.000 km", km: 4_000 },
  { value: "5-10", label: "5.000 – 10.000 km", km: 7_500 },
  { value: "10-20", label: "10.000 – 20.000 km", km: 15_000 },
  { value: "20-30", label: "20.000 – 30.000 km", km: 25_000 },
  { value: "gt30", label: "Más de 30.000 km", km: 35_000 },
  { value: "unknown", label: "No lo sé" },
];

export const SEAT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "any", label: "Me da igual" },
  { value: "2", label: "2 plazas me valen" },
  { value: "4", label: "Al menos 4" },
  { value: "5", label: "Al menos 5" },
  { value: "7", label: "7 plazas" },
];

/** The common priorities, phrased the way a buyer says them. */
export const PRIORITY_OPTIONS: readonly string[] = [
  "fiabilidad",
  "bajo consumo",
  "comodidad en viaje",
  "manejo y diversión",
  "espacio y maletero",
  "capacidad para pistas",
  "potencia de sobra",
  "mantenimiento barato",
  "seguridad y ayudas",
  "que no pierda valor",
];
export const MAX_TOP_PRIORITIES = 3;

/**
 * One checkbox per body a buyer recognises; "coupe" also means its open
 * cousins. Optional and tucked under "Más filtros": many buyers can't tell an
 * estate from a hatchback, so each carries an example on hover.
 */
export const BODY_OPTIONS: ReadonlyArray<{ value: string; label: string; hint: string; styles: BodyStyle[] }> = [
  { value: "hatchback", label: "Compacto o utilitario", hint: "Tipo Golf, Ibiza o Clio", styles: ["hatchback"] },
  { value: "sedan", label: "Berlina", hint: "Con maletero separado, tipo Serie 3 o Passat berlina", styles: ["sedan"] },
  { value: "estate", label: "Familiar", hint: "Maletero largo, tipo Octavia Combi o Passat Variant", styles: ["estate"] },
  { value: "SUV", label: "SUV", hint: "Alto, tipo Qashqai, Tucson o RAV4", styles: ["SUV"] },
  { value: "MPV", label: "Monovolumen", hint: "Tipo Touran, Scénic o Zafira", styles: ["MPV"] },
  { value: "coupe", label: "Coupé o descapotable", hint: "Dos puertas o techo abierto, tipo MX-5 o Serie 2 Coupé", styles: ["coupe", "convertible", "roadster"] },
];

const FOUR_BY_FOUR = "tracción a las 4 ruedas";

const num = (v: FormDataEntryValue | null): number | undefined => {
  const n = Number(String(v ?? "").replace(/[.\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** A list typed as lines OR separated by commas — both are how people write lists. */
export const splitList = (v: FormDataEntryValue | null): string[] =>
  String(v ?? "")
    .split(/[\n,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

export type ParsedDiscoveryForm = { ok: true; profile: DiscoveryProfile } | { ok: false; error: string };

export function parseDiscoveryForm(formData: FormData): ParsedDiscoveryForm {
  const budgetEur = num(formData.get("budgetEur"));
  if (!budgetEur) return { ok: false, error: "Indica un presupuesto en números, por ejemplo 8.000" };

  const usage = String(formData.get("usage") ?? "").trim();
  if (!usage) return { ok: false, error: "Cuéntanos para qué quieres el coche" };

  const kmBand = KM_BANDS.find((b) => b.value === String(formData.get("kmBand") ?? ""));
  if (!kmBand) return { ok: false, error: "Elige cuántos kilómetros haces al año (vale «No lo sé»)" };

  const seats = String(formData.get("seats") ?? "");
  if (!SEAT_OPTIONS.some((s) => s.value === seats)) {
    return { ok: false, error: "Elige cuántas plazas necesitas (vale «Me da igual»)" };
  }

  const topPriorities = formData
    .getAll("topPriority")
    .map(String)
    .filter((p) => PRIORITY_OPTIONS.includes(p));
  if (topPriorities.length === 0) {
    return { ok: false, error: "Marca lo que más te importa: al menos una cosa, hasta tres" };
  }
  if (topPriorities.length > MAX_TOP_PRIORITIES) {
    return {
      ok: false,
      error: `Marca como mucho ${MAX_TOP_PRIORITIES} cosas en «lo que más te importa»: son las que deciden. Lo demás cuéntalo en «¿Para qué lo quieres?»`,
    };
  }
  const mustHaves = splitList(formData.get("mustHaves"));
  if (formData.get("drivetrain") === "4x4" && !mustHaves.some((m) => /4x4|4 ruedas|tracci[oó]n total/i.test(m))) {
    mustHaves.unshift(FOUR_BY_FOUR);
  }

  const bodyStyles = [
    ...new Set(
      formData
        .getAll("body")
        .map(String)
        .flatMap((v) => BODY_OPTIONS.find((b) => b.value === v)?.styles ?? []),
    ),
  ];

  const profile = discoveryProfileSchema.parse({
    budgetEur,
    usage,
    kmPerYear: kmBand.km,
    seatsMin: seats === "any" ? undefined : Number(seats),
    fuelPreference: z
      .array(z.enum(["gasoline", "diesel", "hybrid", "electric"]))
      .catch([])
      .parse(formData.getAll("fuel").map(String)),
    gearbox: z.enum(["manual", "automatic", "any"]).catch("any").parse(String(formData.get("gearbox") ?? "any")),
    // Only the ticked ones. Anything softer goes in the free text; a second
    // list next to "Imprescindible" read as the same question twice.
    priorities: topPriorities,
    topPriorities,
    bodyStyles: bodyStyles.length > 0 ? bodyStyles : undefined,
    mustHaves,
    dealBreakers: splitList(formData.get("dealBreakers")),
    notes: String(formData.get("notes") ?? "").trim() || undefined,
    yearMin: num(formData.get("yearMin")),
    yearMax: num(formData.get("yearMax")),
    kmMax: num(formData.get("kmMax")),
    // Unchecked boxes are absent from FormData: absent means "not required",
    // never `false` stored as an opinion the user didn't express.
    noRhd: formData.get("noRhd") ? true : undefined,
    requireSpanishPlates: formData.get("requireSpanishPlates") ? true : undefined,
    ecoLabelMin: z
      .enum(ECO_LABELS)
      .optional()
      .catch(undefined)
      .parse(String(formData.get("ecoLabelMin") ?? "") || undefined),
    location: searchArea(formData),
    riskTolerance: z.enum(["low", "medium", "high"]).catch("medium").parse(String(formData.get("riskTolerance") ?? "medium")),
    sellerPreference: z
      .enum(["any", "prefer_private"])
      .catch("prefer_private")
      .parse(String(formData.get("sellerPreference") ?? "prefer_private")),
  });
  if (profile.fuelPreference?.length === 0) delete profile.fuelPreference;

  if (profile.yearMin && profile.yearMax && profile.yearMin > profile.yearMax) {
    return { ok: false, error: "El año mínimo no puede ser mayor que el máximo" };
  }
  return { ok: true, profile };
}
