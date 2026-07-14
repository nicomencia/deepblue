/**
 * Absolute dashboard URLs for email deep links. Emails must carry links into
 * deepblue (the lead page is where verdicts, findings and — in Phase 2 —
 * approvals live), not just to the platform ad. 12-factor: PUBLIC_BASE_URL
 * in production; localhost fallback keeps dev emails clickable.
 */
export function dashboardUrl(path: string): string {
  const base =
    process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  return `${base.replace(/\/+$/, "")}${path}`;
}

export function leadUrl(leadId: string): string {
  return dashboardUrl(`/leads/${leadId}`);
}
