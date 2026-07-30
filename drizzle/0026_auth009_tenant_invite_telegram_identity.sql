ALTER TABLE "TenantInvite" ALTER COLUMN "tenantId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "TenantInvite" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "passwordSetAt" timestamp with time zone;