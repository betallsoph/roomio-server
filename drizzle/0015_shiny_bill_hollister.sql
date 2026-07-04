ALTER TABLE "NotificationQueue" ADD COLUMN "attemptCount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "NotificationQueue" ADD COLUMN "lastError" text;--> statement-breakpoint
ALTER TABLE "NotificationQueue" ADD COLUMN "providerMessageId" text;--> statement-breakpoint
ALTER TABLE "NotificationQueue" ADD COLUMN "nextAttemptAt" timestamp with time zone;