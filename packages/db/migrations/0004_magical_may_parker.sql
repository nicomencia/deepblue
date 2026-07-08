ALTER TABLE "leads" ADD COLUMN "enrichment" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "enriched_at" timestamp with time zone;