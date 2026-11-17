import { describe, expect, it } from "vitest";
import { composeModelNotice, findModelUpdates, modelFamily, updateKey } from "./model-updates";

const AVAILABLE = [
  { id: "claude-opus-5-5", createdAt: "2026-09-21T16:24:00Z" },
  { id: "claude-sonnet-5-5", createdAt: "2026-09-28T00:00:00Z" },
  { id: "claude-haiku-5-5", createdAt: "2026-10-07T18:00:00Z" },
  { id: "claude-sonnet-5", createdAt: "2026-06-29T00:00:00Z" },
  { id: "claude-opus-4-8", createdAt: "2026-05-28T00:00:00Z" },
  { id: "claude-haiku-4-5-20251001", createdAt: "2025-10-15T00:00:00Z" },
];
const CURRENT = [
  { lane: "investigación de dossiers", model: "claude-opus-5-5" },
  { lane: "lectura del anuncio", model: "claude-sonnet-5-5" },
  { lane: "lectura del chat", model: "claude-sonnet-5-5" },
  { lane: "redacción de mensajes", model: "claude-haiku-5-5" },
];

describe("findModelUpdates", () => {
  it("reports nothing when every lane runs the newest of its family", () => {
    expect(findModelUpdates(CURRENT, AVAILABLE)).toEqual([]);
  });

  it("reports a newer version once, with every lane that uses the old one", () => {
    const withNewSonnet = [...AVAILABLE, { id: "claude-sonnet-6", createdAt: "2027-01-10T00:00:00Z" }];
    expect(findModelUpdates(CURRENT, withNewSonnet)).toEqual([
      {
        family: "sonnet",
        current: "claude-sonnet-5-5",
        newest: "claude-sonnet-6",
        lanes: ["lectura del anuncio", "lectura del chat"],
      },
    ]);
  });

  it("judges 'newest' by release date, not by the shape of the id", () => {
    // The dated Haiku 4.5 id must not look newer than claude-haiku-5-5.
    const old = [{ lane: "redacción de mensajes", model: "claude-haiku-4-5-20251001" }];
    expect(findModelUpdates(old, AVAILABLE)[0]?.newest).toBe("claude-haiku-5-5");
  });

  it("flags a model the API no longer lists (retired, or a typo in .env)", () => {
    const typo = [{ lane: "lectura del chat", model: "claude-sonet-5-5" }];
    const [u] = findModelUpdates(typo, AVAILABLE);
    expect(u).toMatchObject({ current: "claude-sonet-5-5", newest: undefined, lanes: ["lectura del chat"] });
  });

  it("reads the family from the id", () => {
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(modelFamily("claude-fable-5-2")).toBe("fable");
    expect(modelFamily("gpt-4")).toBeUndefined();
  });
});

describe("composeModelNotice", () => {
  it("names the new model, the one in use and the lanes, and says nothing changes by itself", () => {
    const u = { family: "sonnet", current: "claude-sonnet-5-5", newest: "claude-sonnet-6", lanes: ["lectura del anuncio", "lectura del chat"] };
    const { text, html } = composeModelNotice([u]);
    expect(text).toContain("Sonnet: ya existe claude-sonnet-6. Ahora usas claude-sonnet-5-5 en lectura del anuncio y lectura del chat.");
    expect(text).toContain("Nada cambia solo");
    expect(html).toContain("<li>Sonnet: ya existe claude-sonnet-6");
    expect(updateKey(u)).toBe("claude-sonnet-5-5→claude-sonnet-6");
  });
});
