ALTER TABLE "leads" ADD COLUMN "chat_reading" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "chat_read_at" timestamp with time zone;