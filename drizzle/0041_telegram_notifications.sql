CREATE TABLE "telegram_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"chat_id" text,
	"message_id" integer,
	"fingerprint" text,
	"resolution" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "telegram_messages_state_check" CHECK ("telegram_messages"."state" in ('posting', 'open', 'resolved'))
);
--> statement-breakpoint
CREATE INDEX "telegram_messages_state_idx" ON "telegram_messages" USING btree ("state");--> statement-breakpoint
CREATE INDEX "telegram_messages_job_idx" ON "telegram_messages" USING btree ("job_id");