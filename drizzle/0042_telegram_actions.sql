CREATE TABLE "telegram_prompts" (
	"chat_id" text NOT NULL,
	"message_id" integer NOT NULL,
	"event_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telegram_prompts_chat_id_message_id_pk" PRIMARY KEY("chat_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "token" text;--> statement-breakpoint
-- The messages sent before buttons existed get the token telegramToken (lib/telegram.ts) derives: the first 16 hex characters of the event id's SHA-256.
UPDATE "telegram_messages" SET "token" = substr(encode(sha256(convert_to("id", 'UTF8')), 'hex'), 1, 16);--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_messages_token_idx" ON "telegram_messages" USING btree ("token");--> statement-breakpoint
CREATE INDEX "telegram_messages_message_idx" ON "telegram_messages" USING btree ("chat_id","message_id");