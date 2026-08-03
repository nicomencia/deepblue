/**
 * Instant-alert bodies. Their own module because THREE lanes send them —
 * ingest (near misses), enrichment (new candidates) and price-watch (drops) —
 * and importing them from ingest would close the cycle
 * ingest -> price-watch -> enrich-verdict -> ingest.
 */

import { composeUnitLine, type EvaluationResult, type NormalizedListing } from "@deepblue/core";
import { leadUrl } from "./links";

/** Exported for tests: the instant-alert text is a contract with the reader. */
export function composeAlert(
  item: NormalizedListing,
  evaluation: EvaluationResult,
  leadId?: string,
): string {
  const v = evaluation.verdict;
  const specs = [
    item.priceEur !== undefined ? `${item.priceEur.toLocaleString("es-ES")} €` : undefined,
    item.year,
    item.km !== undefined ? `${item.km.toLocaleString("es-ES")} km` : undefined,
    item.locationText,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [
    `${item.title}`,
    specs,
    "",
    `Confianza global: ${v.overall}`,
    `Recomendación: ${composeUnitLine(v)}`,
    ...(v.repairExposureEur
      ? [
          `Exposición en reparaciones sin verificar: ~${v.repairExposureEur.min.toLocaleString("es-ES")}–${v.repairExposureEur.max.toLocaleString("es-ES")} €`,
        ]
      : []),
    ...(v.budgetNote ? [v.budgetNote] : []),
    // No question list here (user rule 2026-07-17): the alert is the lead's
    // brief; questions live on the lead page, where the outreach flow uses them.
    "",
    ...(leadId ? [`Ficha en deepblue: ${leadUrl(leadId)}`] : []),
    `Anuncio: ${item.url}`,
  ];
  return lines.join("\n");
}

export function composeAlertHtml(
  item: NormalizedListing,
  evaluation: EvaluationResult,
  leadId?: string,
): string {
  const v = evaluation.verdict;
  const href = leadId ? leadUrl(leadId) : item.url;
  const specs = [
    item.priceEur !== undefined ? `${item.priceEur.toLocaleString("es-ES")} €` : undefined,
    item.year,
    item.km !== undefined ? `${item.km.toLocaleString("es-ES")} km` : undefined,
    item.locationText,
  ]
    .filter(Boolean)
    .join(" · ");

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = [
    `<p><strong><a href="${href}">${esc(item.title)}</a></strong><br><small>${esc(specs)}</small></p>`,
    item.imageUrl
      ? `<p><a href="${href}"><img src="${item.imageUrl}" alt="" width="320" style="max-width:100%;border-radius:6px"></a></p>`
      : "",
    `<p>Confianza global: <strong>${v.overall}</strong> — ${esc(composeUnitLine(v))}</p>`,
    v.repairExposureEur
      ? `<p><small>Riesgos sin verificar: ~${v.repairExposureEur.min.toLocaleString("es-ES")}–${v.repairExposureEur.max.toLocaleString("es-ES")} € de exposición en reparaciones</small></p>`
      : "",
    v.budgetNote ? `<p><small>${esc(v.budgetNote)}</small></p>` : "",
    `<p><a href="${href}">Ficha en deepblue</a> · <a href="${item.url}">anuncio original</a></p>`,
  ];
  return parts.filter(Boolean).join("\n");
}
