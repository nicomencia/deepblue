CREATE TABLE "discoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile" jsonb NOT NULL,
	"report" jsonb,
	"report_source" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"report_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "discoveries" ADD CONSTRAINT "discoveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discoveries_user_idx" ON "discoveries" USING btree ("user_id");