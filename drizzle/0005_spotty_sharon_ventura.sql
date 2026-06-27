ALTER TABLE "LandlordProfile" ADD COLUMN "payosClientId" text;--> statement-breakpoint
ALTER TABLE "LandlordProfile" ADD COLUMN "payosApiKeyEnc" text;--> statement-breakpoint
ALTER TABLE "LandlordProfile" ADD COLUMN "payosChecksumKeyEnc" text;--> statement-breakpoint
ALTER TABLE "LandlordProfile" ADD COLUMN "payosConnectedAt" timestamp with time zone;