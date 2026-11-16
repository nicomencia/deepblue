/**
 * The single interface every marketplace sits behind. Wallapop drives a
 * browser session; AutoScout24 mixes scraping with email threads — the rest
 * of the system must not be able to tell the difference.
 */

import type { ListingCheckStatus } from "./jobs.js";
import type { NormalizedListing, Platform } from "./domain.js";

export interface SearchQuery {
  keywords?: string;
  make?: string;
  model?: string;
  priceMaxEur?: number;
  /** Floor to skip financing/installment posts and obvious junk. */
  priceMinEur?: number;
  yearMin?: number;
  /** Cap for old-unit hunts (e.g. a gen-I search on a model still in production). */
  yearMax?: number;
  kmMax?: number;
  /** @deprecated Single-fuel form; still read so jobs queued before `fuels` run. */
  fuel?: "gasoline" | "diesel" | "hybrid" | "electric";
  /**
   * The brief's fuel and gearbox filters, for platforms that can apply them in
   * the search itself. A hint, not a guarantee: the adapter sends only what it
   * has verified the platform honours, and evaluation enforces the filter on
   * whatever comes back either way.
   */
  fuels?: Array<"gasoline" | "diesel" | "hybrid" | "electric">;
  gearboxes?: Array<"manual" | "automatic">;
  location?: { lat: number; lon: number; radiusKm: number };
}

export interface ListingRef {
  platform: Platform;
  platformListingId: string;
  url?: string;
}

export interface ConversationRef {
  platform: Platform;
  platformListingId: string;
  /** Listing web URL, when the chat UI is reached through the ad page. */
  url?: string;
  /** Platform-native conversation/thread id once one exists. */
  platformConversationId?: string;
}

export interface InboundMessage {
  conversation: ConversationRef;
  externalId: string;
  body: string;
  receivedAt: string;
}

export interface SendResult {
  externalId?: string;
  sentAt: string;
}

/** Liveness of one listing, reported by the Runner from the platform itself. */
export interface ListingCheck {
  platform: Platform;
  platformListingId: string;
  status: ListingCheckStatus;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  search(query: SearchQuery): Promise<NormalizedListing[]>;
  fetchListing(ref: ListingRef): Promise<NormalizedListing>;
  /** Cheap probe of a single listing: still on sale, reserved, or gone. */
  checkListing(ref: ListingRef): Promise<ListingCheck>;
  sendMessage(ref: ConversationRef, body: string): Promise<SendResult>;
  fetchReplies(ref: ConversationRef, sinceExternalId?: string): Promise<InboundMessage[]>;
}
