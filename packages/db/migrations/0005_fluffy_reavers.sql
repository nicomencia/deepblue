ALTER TABLE "listings" ADD COLUMN "cash_price_eur" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "dedup_key" text;--> statement-breakpoint
CREATE INDEX "listings_dedup_key_idx" ON "listings" USING btree ("dedup_key");