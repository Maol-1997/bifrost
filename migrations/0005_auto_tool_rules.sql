CREATE TABLE "deployment_tool_rules" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"instructions" text NOT NULL,
	"revision" integer NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment_tool_policies" ADD COLUMN "source" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment_tool_policies" ADD COLUMN "auto_probability" real;--> statement-breakpoint
ALTER TABLE "deployment_tool_policies" ADD COLUMN "rule_revision" integer;--> statement-breakpoint
ALTER TABLE "deployment_tool_rules" ADD CONSTRAINT "deployment_tool_rules_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_tool_policies" ADD CONSTRAINT "deployment_tool_policies_source_check" CHECK ("deployment_tool_policies"."source" in ('admin', 'auto'));