CREATE TABLE "TenantInvite" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"tenantId" text NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"usedAt" timestamp with time zone,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "TenantInvite_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "TenantProfile" ADD COLUMN "telegramUserId" text;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD CONSTRAINT "TenantInvite_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD CONSTRAINT "TenantInvite_tenantId_TenantProfile_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."TenantProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantProfile" ADD CONSTRAINT "TenantProfile_telegramUserId_unique" UNIQUE("telegramUserId");