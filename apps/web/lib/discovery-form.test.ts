import { describe, expect, it } from "vitest";
import { parseDiscoveryForm, splitList } from "./discovery-form";

const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x);
  return fd;
};
const minimal = {
  budgetEur: "27.000",
  usage: "familiar para todo, montaña los findes",
  kmBand: "20-30",
  seats: "5",
  topPriority: ["fiabilidad", "comodidad en viaje"],
};

describe("parseDiscoveryForm", () => {
  it("turns the dropdowns and checkboxes into the profile the advisor reads", () => {
    const r = parseDiscoveryForm(form(minimal));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile).toMatchObject({
      budgetEur: 27_000,
      kmPerYear: 25_000,
      seatsMin: 5,
      topPriorities: ["fiabilidad", "comodidad en viaje"],
      priorities: ["fiabilidad", "comodidad en viaje"],
    });
  });

  it("forces the key facts, with a way out for the ones people don't know", () => {
    expect(parseDiscoveryForm(form({ ...minimal, kmBand: "" }))).toMatchObject({ ok: false });
    expect(parseDiscoveryForm(form({ ...minimal, seats: "" }))).toMatchObject({ ok: false });
    expect(parseDiscoveryForm(form({ ...minimal, usage: "  " }))).toMatchObject({ ok: false });
    const unsure = parseDiscoveryForm(form({ ...minimal, kmBand: "unknown", seats: "any" }));
    expect(unsure.ok && unsure.profile.kmPerYear).toBeUndefined();
    expect(unsure.ok && unsure.profile.seatsMin).toBeUndefined();
  });

  it("asks for 1 to 3 key priorities — the ones that decide", () => {
    expect(parseDiscoveryForm(form({ ...minimal, topPriority: [] }))).toMatchObject({ ok: false });
    const four = ["fiabilidad", "bajo consumo", "comodidad en viaje", "espacio y maletero"];
    const r = parseDiscoveryForm(form({ ...minimal, topPriority: four }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("como mucho 3");
    // Values outside the offered list are ignored, not trusted.
    const forged = parseDiscoveryForm(form({ ...minimal, topPriority: ["fiabilidad", "<script>"] }));
    expect(forged.ok && forged.profile.topPriorities).toEqual(["fiabilidad"]);
  });

  it("adds the 4x4 must-have once, and expands body checkboxes into styles", () => {
    const r = parseDiscoveryForm(form({ ...minimal, drivetrain: "4x4", mustHaves: "Isofix", body: ["estate", "coupe"] }));
    expect(r.ok && r.profile.mustHaves).toEqual(["tracción a las 4 ruedas", "Isofix"]);
    expect(r.ok && r.profile.bodyStyles).toEqual(["estate", "coupe", "convertible", "roadster"]);
    const already = parseDiscoveryForm(form({ ...minimal, drivetrain: "4x4", mustHaves: "tracción total" }));
    expect(already.ok && already.profile.mustHaves).toEqual(["tracción total"]);
    const none = parseDiscoveryForm(form(minimal));
    expect(none.ok && none.profile.bodyStyles).toBeUndefined();
  });

  it("places a radius around a named city instead of asking for coordinates", () => {
    const r = parseDiscoveryForm(form({ ...minimal, center: "bilbao", radiusKm: "150" }));
    expect(r.ok && r.profile.location).toEqual({ lat: 43.263, lon: -2.935, radiusKm: 150 });
    const noRadius = parseDiscoveryForm(form({ ...minimal, center: "bilbao" }));
    expect(noRadius.ok && noRadius.profile.location).toBeUndefined();
  });
});

describe("splitList", () => {
  it("accepts commas, semicolons and lines — however people write a list", () => {
    expect(splitList("Isofix, aire acondicionado;bola\nportón eléctrico, ")).toEqual([
      "Isofix",
      "aire acondicionado",
      "bola",
      "portón eléctrico",
    ]);
  });
});
