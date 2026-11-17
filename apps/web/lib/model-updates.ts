/**
 * "Is there a newer Claude model than the one this lane uses?"
 *
 * Models are pinned per lane on purpose (lib/llm.ts): every version so far has
 * changed something the code relies on, so upgrading is a measured change, not
 * a silent one. Pinning has one cost — nobody notices when a newer version
 * ships. This closes that gap: once a day the digest asks /v1/models (free, no
 * tokens), and each newer version is reported to the user exactly once.
 *
 * It never switches a model. It only says so.
 */

import { DISCOVERY_MODEL, DOSSIER_MODEL, ENRICH_MODEL, getAnthropic, isLlmConfigured, READS_MODEL } from "./llm";
import { DRAFT_MODEL } from "./draft-message";

export interface LaneModel {
  /** What the lane does, in the user's words. */
  lane: string;
  model: string;
}

export interface AvailableModel {
  id: string;
  createdAt: string;
}

export interface ModelUpdate {
  /** "opus" | "sonnet" | "haiku" | ... */
  family: string;
  /** The model in use, as configured. */
  current: string;
  /** The newest model of that family; undefined when `current` is unknown to the API. */
  newest?: string;
  lanes: string[];
}

/** The model each lane resolves to right now (env override or code default). */
export function laneModels(): LaneModel[] {
  return [
    { lane: "investigación de dossiers", model: DOSSIER_MODEL },
    { lane: "descubrimiento de modelos", model: DISCOVERY_MODEL },
    { lane: "lectura del anuncio", model: ENRICH_MODEL },
    { lane: "lectura del chat", model: READS_MODEL },
    { lane: "redacción de mensajes", model: DRAFT_MODEL },
  ];
}

/** "claude-sonnet-5-5" → "sonnet"; undefined for an id that names no family. */
export function modelFamily(id: string): string | undefined {
  return /^claude-([a-z]+)-/.exec(id)?.[1];
}

/**
 * Pure: which lanes run on a model that is not the newest of its family, or on
 * a model the API no longer lists (retired, or a typo in .env). Lanes sharing a
 * model are reported together. "Newest" is by the API's own `created_at`, never
 * by parsing version numbers out of ids, which have changed shape before
 * (dated snapshots like claude-haiku-4-5-20251001 vs claude-haiku-5-5).
 */
export function findModelUpdates(lanes: LaneModel[], available: AvailableModel[]): ModelUpdate[] {
  const known = new Map(available.map((m) => [m.id, m]));
  const newestByFamily = new Map<string, AvailableModel>();
  for (const m of available) {
    const family = modelFamily(m.id);
    if (!family) continue;
    const best = newestByFamily.get(family);
    if (!best || m.createdAt > best.createdAt) newestByFamily.set(family, m);
  }

  const byModel = new Map<string, ModelUpdate>();
  for (const { lane, model } of lanes) {
    const family = modelFamily(model) ?? "?";
    const newest = newestByFamily.get(family);
    const unknown = !known.has(model);
    const outdated = !unknown && newest !== undefined && newest.id !== model;
    if (!unknown && !outdated) continue;
    const entry = byModel.get(model) ?? { family, current: model, newest: unknown ? undefined : newest?.id, lanes: [] };
    entry.lanes.push(lane);
    byModel.set(model, entry);
  }
  return [...byModel.values()];
}

/**
 * Ask the API and compare. Never throws: a failed check must not cost the
 * user their digest — it logs and reports nothing.
 */
export async function checkModelUpdates(): Promise<ModelUpdate[]> {
  if (!isLlmConfigured()) return [];
  try {
    const available: AvailableModel[] = [];
    for await (const m of getAnthropic().models.list()) {
      available.push({ id: m.id, createdAt: m.created_at });
    }
    const updates = findModelUpdates(laneModels(), available);
    for (const u of updates) {
      console.info(
        u.newest
          ? `[models] ${u.current} → hay ${u.newest} (${u.lanes.join(", ")})`
          : `[models] ${u.current} no aparece en /v1/models (${u.lanes.join(", ")})`,
      );
    }
    return updates;
  } catch (err) {
    console.warn("[models] no se pudo comprobar si hay modelos nuevos:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Stable key for "already told the user about this", stored in the events log. */
export const updateKey = (u: ModelUpdate): string => `${u.current}→${u.newest ?? "unknown"}`;

/** The notice, as plain text lines and as HTML. */
export function composeModelNotice(updates: ModelUpdate[]): { text: string; html: string } {
  const lines = updates.map((u) =>
    u.newest
      ? `· ${capitalize(u.family)}: ya existe ${u.newest}. Ahora usas ${u.current} en ${u.lanes.join(" y ")}.`
      : `· ${u.current} no aparece en la lista de modelos de la API (¿retirado o mal escrito en .env?). Lo usa: ${u.lanes.join(" y ")}.`,
  );
  const how =
    "Nada cambia solo. Para probar uno nuevo, descomenta su línea DEEPBLUE_*_MODEL en .env.local; " +
    "para adoptarlo, cambia el default en apps/web/lib/llm.ts tras compararlo (como en DEV-SETUP §5, cambio 39).";
  const text = `Modelos de Claude\n\n${lines.join("\n")}\n\n${how}`;
  const html =
    `<h3 style="margin:24px 0 4px;padding-bottom:4px;border-bottom:1px solid #ddd">Modelos de Claude</h3>` +
    `<ul style="padding-left:16px;margin-top:8px">${lines.map((l) => `<li>${escapeHtml(l.slice(2))}</li>`).join("")}</ul>` +
    `<p><small>${escapeHtml(how)}</small></p>`;
  return { text, html };
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
