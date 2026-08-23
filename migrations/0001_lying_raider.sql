CREATE TABLE "deployment_tool_policies" (
	"provider_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_tool_policies_pk" PRIMARY KEY("provider_id","tool_name"),
	CONSTRAINT "deployment_tool_policies_state_check" CHECK ("deployment_tool_policies"."state" in ('blocked', 'allowed_default_off', 'allowed_default_on'))
);
--> statement-breakpoint
ALTER TABLE "deployment_tool_policies" ADD CONSTRAINT "deployment_tool_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;