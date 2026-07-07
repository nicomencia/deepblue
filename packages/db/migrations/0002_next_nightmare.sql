ALTER TABLE "listings" ADD COLUMN "power_cv" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "eco_label" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "seller_rating" real;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "seller_review_count" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "seller_sold_count" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "detail_fetched_at" timestamp with time zone;