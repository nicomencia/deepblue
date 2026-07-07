/**
 * Cron endpoint auth: Cloud Scheduler (or any external trigger) must present
 * the CRON_SECRET bearer token. Without a configured secret, only non-prod
 * environments accept the call (dev convenience).
 */
export function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
