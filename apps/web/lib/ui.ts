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
