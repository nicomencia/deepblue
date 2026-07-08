/**
 * Listing lifecycle policy. A shortlisted listing that hasn't been re-sighted
 * for a while is *probed* (not reaped): the Wallapop search returns only the
 * newest page, so a still-for-sale car aging off the page must never be
 * mistaken for a sold one. Only the platform's own 404 confirms "gone".
 */

/** Hours since last sighting before a shortlisted listing is re-probed. */
export const DEFAULT_RECHECK_HOURS = 36;

/** True when a listing last seen at `lastSeenAt` is due for a liveness probe. */
export function dueForRecheck(
  lastSeenAt: Date,
  now: Date = new Date(),
  recheckHours: number = DEFAULT_RECHECK_HOURS,
): boolean {
  return now.getTime() - lastSeenAt.getTime() >= recheckHours * 60 * 60 * 1000;
}
