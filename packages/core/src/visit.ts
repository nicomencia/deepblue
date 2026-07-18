/**
 * Visit report: everything the system knows about ONE unit, turned into the
 * in-person verification list. Deterministic — every line traces to a dossier
 * issue, a chat finding, an import fact, or the negotiation state. The visit
 * is where claims become evidence: seller-stated rulings get their paper
 * checked, open risks get their dossier verify steps, and the agreed price
 * carries its walk-away logic.
 */

import type { IssueAssessment, IssueFinding } from "./domain.js";

export interface VisitCheckItem {
  check: string;
  detail?: string;
}

export interface VisitChecklistSection {
  title: string;
  items: VisitCheckItem[];
}

export interface VisitChecklistInput {
  title: string;
  year?: number | null;
  km?: number | null;
  fuel?: string | null;
  gearbox?: string | null;
  askingPriceEur?: number | null;
  /** Price agreed in chat, when the negotiation closed. */
  agreedPriceEur?: number | null;
  /** The user's hard cap — printed as the never-cross line. */
  maxBudgetEur?: number;
  issues: IssueAssessment[];
  findings?: IssueFinding[];
  /** Conversation reading flags — already unit-specific observations. */
  redFlags?: string[];
  rhd?: boolean | null;
  foreignPlates?: boolean | null;
}

const LIKELIHOOD_ES: Record<string, string> = { low: "baja", medium: "media", high: "alta" };

const eur = (n: number): string => `${n.toLocaleString("es-ES")} €`;

export function composeVisitChecklist(input: VisitChecklistInput): VisitChecklistSection[] {
  const sections: VisitChecklistSection[] = [];
  const findings = input.findings ?? [];

  // 1. Open risks — the dossier says exactly how each one is settled.
  const open = input.issues.filter((i) => i.status === "unconfirmed");
  if (open.length > 0) {
    sections.push({
      title: "Riesgos abiertos — comprobar en persona",
      items: open.map((i) => ({
        check: i.title,
        detail:
          `Cómo: ${i.verifyBy.join("; ")}. Probabilidad ${LIKELIHOOD_ES[i.likelihood] ?? i.likelihood}` +
          (i.typicalRepairCostEur
            ? ` — si no se descarta, resta ~${eur(i.typicalRepairCostEur.min)}–${eur(i.typicalRepairCostEur.max)}.`
            : "."),
      })),
    });
  }

  // 2. Chat claims taken on faith — the visit is where the paper appears.
  const claimed = findings.filter(
    (f) => f.status === "ruled_out" && f.note?.startsWith("palabra del vendedor"),
  );
  if (claimed.length > 0) {
    sections.push({
      title: "Prometido por chat — pide ver la prueba",
      items: claimed.map((f) => ({
        check: `${f.title} — ver la factura/evidencia real`,
        detail: f.note,
      })),
    });
  }

  // 3. Confirmed problems ride along as price context, never surprises.
  const confirmed = input.issues.filter((i) => i.status === "confirmed");
  if (confirmed.length > 0) {
    sections.push({
      title: "Confirmado — ya contado en el precio, revisa el alcance",
      items: confirmed.map((i) => ({
        check: i.title,
        detail: i.typicalRepairCostEur
          ? `Coste típico ~${eur(i.typicalRepairCostEur.min)}–${eur(i.typicalRepairCostEur.max)}.`
          : undefined,
      })),
    });
  }

  // 4. Red flags the conversation raised — specific to this seller/unit.
  if (input.redFlags?.length) {
    sections.push({
      title: "Avisos de la conversación",
      items: input.redFlags.map((r) => ({ check: r })),
    });
  }

  // 5. Papers.
  const papers: VisitCheckItem[] = [
    { check: "Permiso de circulación — titular es quien vende y nº de propietarios coincide" },
    { check: "Ficha técnica e ITV — fechas, sin limitaciones anotadas" },
    { check: "Libro de mantenimiento y facturas — fechas y km coherentes con el cuentakilómetros" },
  ];
  if (input.foreignPlates) {
    papers.push({
      check: "Documentación de importación — V5/COC, DUA o justificante de aduanas e IVA",
      detail: "Sin esto la rematriculación se complica y encarece.",
    });
  }
  if (input.rhd) {
    papers.push({ check: "Volante a la derecha — confirmar en persona y valorar el descuento real" });
  }
  sections.push({ title: "Papeles", items: papers });

  // 6. Cold checks — always before the engine warms.
  sections.push({
    title: "Con el motor FRÍO (llega antes de la hora)",
    items: [
      { check: "Capó frío al llegar — si está caliente, lo han calentado a propósito" },
      { check: "Vaso de expansión: nivel entre marcas, líquido limpio, sin restos secos alrededor" },
      { check: "Varilla de aceite y tapón — nivel, color, sin mayonesa" },
      { check: "Suelo bajo el coche y vano motor — fugas, óxido, tornillería tocada" },
    ],
  });

  // 7. Start + drive.
  sections.push({
    title: "Arranque y prueba",
    items: [
      { check: "Arranque en frío a la primera — humo del escape, ruidos los primeros segundos" },
      { check: "Cuadro: todos los testigos se encienden y se apagan" },
      { check: "Dirección recta y sin ruidos a tope de giro; frenada recta y sin vibración" },
      { check: "Cambios suaves (todas las marchas) y embrague sin patinar" },
      { check: "Badenes y bordillos: golpeteos de suspensión, crujidos de silentblocks" },
      { check: "Electrónica: aire acondicionado frío, elevalunas, luces, multimedia" },
    ],
  });

  // 8. Price + close.
  const openExposure = open.reduce(
    (acc, i) =>
      i.typicalRepairCostEur
        ? { min: acc.min + i.typicalRepairCostEur.min, max: acc.max + i.typicalRepairCostEur.max }
        : acc,
    { min: 0, max: 0 },
  );
  const priceItems: VisitCheckItem[] = [];
  if (input.agreedPriceEur) {
    priceItems.push({
      check: `Precio acordado por chat: ${eur(input.agreedPriceEur)} — el trato es ESE, condicionado a que todo cuadre`,
    });
  } else if (input.askingPriceEur) {
    priceItems.push({ check: `Precio del anuncio: ${eur(input.askingPriceEur)} — sin acuerdo cerrado aún` });
  }
  if (openExposure.max > 0) {
    priceItems.push({
      check: `Lo que no se pueda descartar hoy vale ~${eur(openExposure.min)}–${eur(openExposure.max)} — renegocia con eso delante o levántate`,
    });
  }
  if (input.maxBudgetEur) {
    priceItems.push({ check: `Tu tope duro: ${eur(input.maxBudgetEur)} — no se cruza por ningún motivo` });
  }
  priceItems.push({ check: "Sin prisa: la urgencia del vendedor es su problema, no el tuyo" });
  sections.push({ title: "Precio y cierre", items: priceItems });

  return sections;
}

/** Plain-text rendering for email. */
export function visitChecklistText(input: VisitChecklistInput): string {
  const specs = [
    input.year ?? undefined,
    input.km != null ? `${input.km.toLocaleString("es-ES")} km` : undefined,
    input.fuel ?? undefined,
    input.gearbox ?? undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines: string[] = [`INFORME DE VISITA — ${input.title}`, specs, ""];
  for (const section of composeVisitChecklist(input)) {
    lines.push(`== ${section.title.toUpperCase()} ==`);
    for (const item of section.items) {
      lines.push(`[ ] ${item.check}`);
      if (item.detail) lines.push(`    ${item.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
