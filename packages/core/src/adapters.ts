/**
 * The single interface every marketplace sits behind. Wallapop drives a
 * browser session; AutoScout24 mixes scraping with email threads — the rest
 * of the system must not be able to tell the difference.
 */

import type { NormalizedListing, Platform } from "./domain.js";

export interface SearchQuery {
  keywords?: string;
  make?: string;
  model?: string;
  priceMaxEur?: number;
  /** Floor to skip financing/installment posts and obvious junk. */
  priceMinEur?: number;
  yearMin?: number;
  kmMax?: number;
  /** Only set when the brief pins exactly one fuel. */
  fuel?: "gasoline" | "diesel" | "hybrid" | "electric";
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

export interface PlatformAdapter {
  readonly platform: Platform;
  search(query: SearchQuery): Promise<NormalizedListing[]>;
  fetchListing(ref: ListingRef): Promise<NormalizedListing>;
  sendMessage(ref: ConversationRef, body: string): Promise<SendResult>;
  fetchReplies(ref: ConversationRef, sinceExternalId?: string): Promise<InboundMessage[]>;
}
