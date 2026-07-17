/**
 * Adaptive reply-polling policy. Each fetch opens a real browser against
 * Wallapop, so cadence must earn its cost: poll fast while a conversation is
 * hot (this seller answers in minutes), back off when they take days, and
 * barely poll at all when the ball is in OUR court. Pure functions — the
 * sweep feeds them timestamps and applies the verdict.
 */

interface TimelineMessage {
  direction: "outbound" | "inbound";
  at: Date;
}

/**
 * Median minutes this seller takes to answer: each sent message pairs with
 * the FIRST reply after it (later ones are double-texts, not new answers).
 * Undefined until at least one exchange completes.
 */
export function medianSellerReplyMinutes(timeline: TimelineMessage[]): number | undefined {
  const sorted = [...timeline].sort((a, b) => a.at.getTime() - b.at.getTime());
  const latencies: number[] = [];
  let pendingOutboundMs: number | undefined;
  for (const m of sorted) {
    if (m.direction === "outbound") {
      pendingOutboundMs = m.at.getTime();
    } else if (pendingOutboundMs !== undefined) {
      latencies.push((m.at.getTime() - pendingOutboundMs) / 60_000);
      pendingOutboundMs = undefined;
    }
  }
  if (latencies.length === 0) return undefined;
  latencies.sort((a, b) => a - b);
  const mid = Math.floor(latencies.length / 2);
  const lo = latencies[mid - 1] ?? 0;
  const hi = latencies[mid] ?? 0;
  return latencies.length % 2 === 1 ? hi : (lo + hi) / 2;
}

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

export interface ReplyPollInput {
  now: Date;
  /** When we last sent a message — the start of the current wait, if any. */
  lastOutboundAt?: Date;
  /** When the seller last replied. */
  lastInboundAt?: Date;
  /** This seller's median reply latency, when at least one exchange exists. */
  medianReplyMinutes?: number;
}

/**
 * Minutes to wait between reply fetches for one conversation.
 *
 * Waiting on the seller: expect them to take their usual time — poll at half
 * their median (floor 10 min, cap 60) while the answer is plausibly on its
 * way, drop to 90 min once they've taken twice their usual, and to 6 h after
 * a full day of silence (the nudge flow owns that situation, not polling).
 * Our turn: one quick check 30 min after their message catches double-texts,
 * then every 3 h — nothing is owed to us.
 */
export function replyPollCooldownMinutes(input: ReplyPollInput): number {
  const out = input.lastOutboundAt?.getTime();
  const inb = input.lastInboundAt?.getTime();
  const waitingForSeller = out !== undefined && (inb === undefined || out > inb);

  if (!waitingForSeller) {
    if (inb !== undefined && input.now.getTime() - inb < 30 * 60_000) return 15;
    return 180;
  }

  const expected = clamp(input.medianReplyMinutes ?? 45, 10, 240);
  const waitedMinutes = (input.now.getTime() - (out as number)) / 60_000;
  if (waitedMinutes < 2 * expected) return clamp(Math.round(expected / 2), 10, 60);
  if (waitedMinutes < 24 * 60) return 90;
  return 360;
}
