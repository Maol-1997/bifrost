CREATE TABLE "user_provider_agent_notes" (
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"note" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_provider_agent_notes_pk" PRIMARY KEY("user_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "user_provider_agent_notes" ADD CONSTRAINT "user_provider_agent_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;