import { describe, expect, it } from "vitest";
import { composeVisitChecklist, visitChecklistText } from "./visit.js";
import type { IssueAssessment } from "./domain.js";

const degas: IssueAssessment = {
  title: "1.0 EcoBoost: pérdida de refrigerante por el manguito degas",
  severity: "critical",
  status: "unconfirmed",
  likelihood: "medium",
  typicalRepairCostEur: { min: 2000, max: 4500 },
  verifyBy: ["nivel del vaso en frío", "restos secos en las conexiones"],
};
const belt: IssueAssessment = {
  title: "1.0 EcoBoost: correa de distribución bañada en aceite degradada",
  severity: "major",
  status: "ruled_out",
  likelihood: "high",
  typicalRepairCostEur: { min: 600, max: 1200 },
  verifyBy: ["factura del cambio"],
};

const fordInput = {
  title: "Ford Focus 2015",
  year: 2015,
  km: 220000,
  fuel: "Gasolina",
  gearbox: "Manual",
  askingPriceEur: 15000,
  agreedPriceEur: 14200,
  maxBudgetEur: 14500,
  issues: [degas, belt],
  findings: [
    {
      title: belt.title,
      status: "ruled_out" as const,
      note: "palabra del vendedor: «Si, esta recién cambiada y con factura»",
      at: "2026-07-17T21:00:00Z",
    },
  ],
  redFlags: ["Vendedora intermediaria y venta con prisa por mudanza"],
};

describe("composeVisitChecklist", () => {
  const sections = composeVisitChecklist(fordInput);
  const flat = JSON.stringify(sections);

  it("puts open risks with their dossier verify steps and cost band", () => {
    const risks = sections.find((s) => s.title.startsWith("Riesgos abiertos"));
    expect(risks!.items.map((i) => i.check)).toContain(degas.title);
    expect(flat).toContain("nivel del vaso en frío");
    // es-ES only groups 5+ digits: 2000 stays ungrouped.
    expect(flat).toContain("resta ~2000 €–4500 €");
  });

  it("asks for the paper behind seller-stated rulings", () => {
    const promised = sections.find((s) => s.title.startsWith("Prometido por chat"));
    expect(promised!.items[0]!.check).toContain("factura");
    expect(promised!.items[0]!.detail).toContain("recién cambiada");
  });

  it("carries the agreed price, the open exposure and the hard cap", () => {
    const price = sections.find((s) => s.title === "Precio y cierre");
    const checks = price!.items.map((i) => i.check).join(" | ");
    expect(checks).toContain("14.200 €");
    expect(checks).toContain("14.500 €");
    expect(checks).toContain("2000 €–4500 €");
  });

  it("adds import paper checks only when the facts call for them", () => {
    expect(flat).not.toContain("V5");
    const imported = JSON.stringify(
      composeVisitChecklist({ ...fordInput, foreignPlates: true, rhd: true }),
    );
    expect(imported).toContain("V5");
    expect(imported).toContain("Volante a la derecha");
  });

  it("always includes cold checks and papers", () => {
    expect(sections.some((s) => s.title.includes("FRÍO"))).toBe(true);
    expect(sections.some((s) => s.title === "Papeles")).toBe(true);
  });
});

describe("visitChecklistText", () => {
  it("renders a printable plain-text report", () => {
    const text = visitChecklistText(fordInput);
    expect(text).toContain("INFORME DE VISITA — Ford Focus 2015");
    expect(text).toContain("220.000 km");
    expect(text).toContain("[ ] ");
    expect(text).toContain("== PAPELES ==");
  });
});
