import { describe, expect, it } from "vitest";
import { composeDigest, groupByBrief, type DigestRow } from "./digest";

/** Minimal shape the digest actually reads; the rest of the row is irrelevant. */
const row = (
  briefId: string,
  briefName: string,
  title: string,
  score: number,
  grade = "C",
): DigestRow =>
  ({
    lead: {
      id: `lead-${title}`,
      alertedAt: null,
      verdict: { overall: grade, score, factors: {}, openQuestions: [] },
    },
    listing: {
      title,
      priceEur: 30_000,
      year: 2021,
      km: 50_000,
      locationText: "Madrid",
      url: "https://example.com/item",
      imageUrl: null,
    },
    brief: { id: briefId, name: briefName },
  }) as unknown as DigestRow;

describe("digest grouping", () => {
  const rows = [
    row("b1", "GR Yaris", "GR Yaris barato", 67),
    row("b2", "Peugeot 207 RC", "207 RC impecable", 81, "B"),
    row("b1", "GR Yaris", "GR Yaris caro", 41, "D"),
    row("b2", "Peugeot 207 RC", "207 RC regular", 55),
  ];

  it("puts every lead under its own search", () => {
    const sections = groupByBrief(rows);
    expect(sections.map((s) => s.briefName)).toEqual(["Peugeot 207 RC", "GR Yaris"]);
    expect(sections.map((s) => s.rows.length)).toEqual([2, 2]);
  });

  // The section holding the single best candidate is the one worth reading first.
  it("leads with the search that holds the best candidate", () => {
    expect(groupByBrief(rows)[0]?.briefName).toBe("Peugeot 207 RC");
  });

  it("orders within a search by score, best first", () => {
    const gr = groupByBrief(rows).find((s) => s.briefName === "GR Yaris");
    expect(gr?.rows.map((r) => r.lead.verdict?.score)).toEqual([67, 41]);
  });

  it("does not lose a lead whose verdict has no score", () => {
    const orphan = { ...row("b3", "Sin nota", "sin veredicto", 0), lead: { verdict: null } };
    const sections = groupByBrief([...rows, orphan as unknown as DigestRow]);
    expect(sections.flatMap((s) => s.rows)).toHaveLength(5);
  });
});

describe("digest rendering", () => {
  const rows = [
    row("b1", "GR Yaris", "GR Yaris barato", 67),
    row("b2", "Peugeot 207 RC", "207 RC impecable", 81, "B"),
  ];

  it("shows the score next to the title in both bodies", () => {
    const { text, html } = composeDigest(rows);
    expect(text).toContain("[B · 81] 207 RC impecable");
    expect(html).toContain("[B · 81] 207 RC impecable");
  });

  it("names every search and counts them in the heading", () => {
    const { text, html } = composeDigest(rows);
    expect(text).toContain("Nuevos candidatos (2) en 2 búsquedas");
    expect(text).toContain("GR Yaris (1)");
    expect(html).toContain("Peugeot 207 RC");
  });

  it("says one búsqueda when there is only one", () => {
    expect(composeDigest([rows[0]!]).text).toContain("en 1 búsqueda:");
  });

  // Regression: a global cap let one prolific search fill the mail and hide the
  // rest. The cap is per search, and each says what it is holding back.
  it("caps each search separately and reports the remainder", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      row("b1", "GR Yaris", `unidad ${i}`, 70 - i),
    );
    const { text, html } = composeDigest([...many, rows[1]!]);
    expect(text).toContain("…y 4 más de esta búsqueda en el dashboard.");
    expect(html).toContain("Peugeot 207 RC");
    expect(text).toContain("unidad 9");
    expect(text).not.toContain("unidad 10");
  });
});
