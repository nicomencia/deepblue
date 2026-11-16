import type { ConfidenceGrade } from "@deepblue/core";

/** Grade colors are status tokens defined in layout CSS (light+dark variants). */
export const gradeVar = (grade: ConfidenceGrade | string): string =>
  `var(--grade-${String(grade).toLowerCase()})`;

export const fmtEur = (n: number | null | undefined): string =>
  n == null ? "—" : `${n.toLocaleString("es-ES")} €`;

export const fmtKm = (n: number | null | undefined): string =>
  n == null ? "—" : `${n.toLocaleString("es-ES")} km`;

export const fmtDate = (d: Date | string): string =>
  new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d));

/**
 * Why a lead sits outside its search, from the reason code stored on it.
 * Short on purpose: the row beside it already shows the price, year and km.
 */
const MISS_REASON: Record<string, string> = {
  fuel_mismatch: "combustible distinto al que buscas",
  gearbox_mismatch: "cambio distinto al que buscas",
  drivetrain_mismatch: "tracción distinta a la que buscas",
  km_over_limit: "km por encima de tu tope",
  price_over_budget: "precio por encima de tu presupuesto",
  year_below_minimum: "más antiguo que tu año mínimo",
  year_above_maximum: "más nuevo que tu año máximo",
  outside_search_radius: "fuera de tu radio de búsqueda",
};

export const missReasonLabel = (reason: string | null | undefined): string =>
  (reason && MISS_REASON[reason]) || "fuera de los límites de la búsqueda";
