/**
 * Circuit breaker for platform blocks. Golden rule of Wallapop hygiene:
 * on 403/429 STOP — never retry, never retry harder. Adapters throw
 * PlatformBlockedError the moment they see a blocking status; the main loop
 * trips a long jittered cooldown and stops leasing until it expires.
 *
 * Global (not per-platform) on purpose: a job's platform is only known
 * after leasing it, and pausing everything is the honest behavior while a
 * single platform is active (ACTIVE_PLATFORMS = ["wallapop"]). When a second
 * platform returns, move the pause to lease time (Core filters by platform).
 */

const BLOCKING_STATUSES = new Set([403, 429]);

/** Base cooldown; the actual pause is jittered to 45–90 min. */
const COOLDOWN_BASE_MS = 60 * 60 * 1000;

export class PlatformBlockedError extends Error {
  readonly platform: string;
  readonly status: number;

  constructor(platform: string, status: number, context: string) {
    super(`platform_blocked: ${platform} HTTP ${status} (${context})`);
    this.name = "PlatformBlockedError";
    this.platform = platform;
    this.status = status;
  }
}

/** Throw on blocking statuses — call this before any other response handling. */
export function assertNotBlocked(platform: string, status: number, context: string): void {
  if (BLOCKING_STATUSES.has(status)) {
    throw new PlatformBlockedError(platform, status, context);
  }
}

export function blockedCooldownMs(): number {
  return Math.round(COOLDOWN_BASE_MS * (0.75 + Math.random() * 0.75));
}
