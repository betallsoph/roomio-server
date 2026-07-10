CREATE TABLE "TelegramBotSession" (
	"telegramUserId" text PRIMARY KEY NOT NULL,
	"tenantId" text,
	"flow" text NOT NULL,
	"step" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "TelegramBotSession" ADD CONSTRAINT "TelegramBotSession_tenantId_TenantProfile_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."TenantProfile"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "TelegramBotSession_tenantId_idx" ON "TelegramBotSession" USING btree ("tenantId");
--> statement-breakpoint
CREATE INDEX "TelegramBotSession_expiresAt_idx" ON "TelegramBotSession" USING btree ("expiresAt");
