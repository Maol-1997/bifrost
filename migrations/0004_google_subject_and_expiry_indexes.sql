ALTER TABLE "users" ADD COLUMN "google_subject" text;--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_expires_at_index" ON "oauth_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_index" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_google_subject_unique" UNIQUE("google_subject");