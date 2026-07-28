CREATE TABLE "ManagedTenant" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"displayName" text NOT NULL,
	"emailSnapshot" text,
	"phoneSnapshot" text,
	"claimedByUserId" text,
	"claimVersion" integer DEFAULT 0 NOT NULL,
	"claimAccessSuspendedAt" timestamp with time zone,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"legacyTenantProfileId" text,
	"backfillSource" text,
	"needsReview" boolean DEFAULT false NOT NULL,
	"createdByActorType" text DEFAULT 'USER' NOT NULL,
	"createdByUserId" text,
	"archivedAt" timestamp with time zone,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Tenancy" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"propertyId" text NOT NULL,
	"roomId" text NOT NULL,
	"managedTenantId" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"startDate" date NOT NULL,
	"plannedEndDate" date,
	"endDate" date,
	"depositRequired" bigint DEFAULT 0 NOT NULL,
	"financeInitializedAt" timestamp with time zone,
	"financeInitializationSource" text,
	"financeInitializationVersion" integer DEFAULT 0 NOT NULL,
	"createdByActorType" text DEFAULT 'USER' NOT NULL,
	"createdByUserId" text,
	"endedByUserId" text,
	"backfillSource" text,
	"needsReview" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "Tenancy_active_no_end_date" CHECK (status <> 'ACTIVE' OR "endDate" IS NULL),
	CONSTRAINT "Tenancy_ended_end_date_valid" CHECK (status <> 'ENDED' OR ("endDate" IS NOT NULL AND "endDate" >= "startDate")),
	CONSTRAINT "Tenancy_planned_end_after_start" CHECK ("plannedEndDate" IS NULL OR "plannedEndDate" >= "startDate"),
	CONSTRAINT "Tenancy_deposit_non_negative" CHECK ("depositRequired" >= 0)
);
--> statement-breakpoint
ALTER TABLE "TenantProfile" ALTER COLUMN "idNumber" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "TenantProfile" ALTER COLUMN "moveInDate" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "TenantProfile" ALTER COLUMN "deposit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "Contract" ADD COLUMN "managedTenantId" text;--> statement-breakpoint
ALTER TABLE "Contract" ADD COLUMN "tenancyId" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "managedTenantId" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "tenancyId" text;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD COLUMN "managedTenantId" text;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD COLUMN "tenancyId" text;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD COLUMN "managedTenantId" text;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD COLUMN "tenancyId" text;--> statement-breakpoint
ALTER TABLE "NotificationQueue" ADD COLUMN "managedTenantId" text;--> statement-breakpoint
ALTER TABLE "NotificationQueue" ADD COLUMN "tenancyId" text;--> statement-breakpoint
ALTER TABLE "Room" ADD COLUMN "currentManagedTenantId" text;--> statement-breakpoint
ALTER TABLE "SpecialNote" ADD COLUMN "managedTenantId" text;--> statement-breakpoint
ALTER TABLE "SpecialNote" ADD COLUMN "tenancyId" text;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD COLUMN "managedTenantId" text;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD COLUMN "tenancyId" text;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD COLUMN "tokenHash" text;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD COLUMN "revokedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD COLUMN "acceptedByUserId" text;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD COLUMN "expectedClaimVersion" integer;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD COLUMN "claimRecoveryId" text;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD COLUMN "updatedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ManagedTenant" ADD CONSTRAINT "ManagedTenant_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ManagedTenant" ADD CONSTRAINT "ManagedTenant_claimedByUserId_User_id_fk" FOREIGN KEY ("claimedByUserId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ManagedTenant" ADD CONSTRAINT "ManagedTenant_createdByUserId_User_id_fk" FOREIGN KEY ("createdByUserId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_propertyId_Property_id_fk" FOREIGN KEY ("propertyId") REFERENCES "public"."Property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_roomId_Room_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_createdByUserId_User_id_fk" FOREIGN KEY ("createdByUserId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_endedByUserId_User_id_fk" FOREIGN KEY ("endedByUserId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ManagedTenant_landlord_status_createdAt_idx" ON "ManagedTenant" USING btree ("landlordId","status","createdAt");--> statement-breakpoint
CREATE INDEX "ManagedTenant_claimedByUserId_idx" ON "ManagedTenant" USING btree ("claimedByUserId");--> statement-breakpoint
CREATE UNIQUE INDEX "ManagedTenant_landlord_legacyProfile_unique" ON "ManagedTenant" USING btree ("landlordId","legacyTenantProfileId") WHERE "legacyTenantProfileId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "Tenancy_landlord_status_idx" ON "Tenancy" USING btree ("landlordId","status");--> statement-breakpoint
CREATE INDEX "Tenancy_managedTenant_startDate_idx" ON "Tenancy" USING btree ("managedTenantId","startDate");--> statement-breakpoint
CREATE INDEX "Tenancy_room_startDate_idx" ON "Tenancy" USING btree ("roomId","startDate");--> statement-breakpoint
CREATE UNIQUE INDEX "Tenancy_active_room_unique" ON "Tenancy" USING btree ("roomId") WHERE status = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "Tenancy_active_managedTenant_unique" ON "Tenancy" USING btree ("managedTenantId") WHERE status = 'ACTIVE' AND "managedTenantId" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_tenancyId_Tenancy_id_fk" FOREIGN KEY ("tenancyId") REFERENCES "public"."Tenancy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenancyId_Tenancy_id_fk" FOREIGN KEY ("tenancyId") REFERENCES "public"."Tenancy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenancyId_Tenancy_id_fk" FOREIGN KEY ("tenancyId") REFERENCES "public"."Tenancy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_tenancyId_Tenancy_id_fk" FOREIGN KEY ("tenancyId") REFERENCES "public"."Tenancy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "NotificationQueue" ADD CONSTRAINT "NotificationQueue_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "NotificationQueue" ADD CONSTRAINT "NotificationQueue_tenancyId_Tenancy_id_fk" FOREIGN KEY ("tenancyId") REFERENCES "public"."Tenancy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Room" ADD CONSTRAINT "Room_currentManagedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("currentManagedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SpecialNote" ADD CONSTRAINT "SpecialNote_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SpecialNote" ADD CONSTRAINT "SpecialNote_tenancyId_Tenancy_id_fk" FOREIGN KEY ("tenancyId") REFERENCES "public"."Tenancy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD CONSTRAINT "TenantInvite_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD CONSTRAINT "TenantInvite_tenancyId_Tenancy_id_fk" FOREIGN KEY ("tenancyId") REFERENCES "public"."Tenancy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantInvite" ADD CONSTRAINT "TenantInvite_acceptedByUserId_User_id_fk" FOREIGN KEY ("acceptedByUserId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Room_currentManagedTenantId_idx" ON "Room" USING btree ("currentManagedTenantId");--> statement-breakpoint
CREATE INDEX "TenantInvite_landlord_managedTenant_tenancy_idx" ON "TenantInvite" USING btree ("landlordId","managedTenantId","tenancyId");--> statement-breakpoint
CREATE UNIQUE INDEX "TenantInvite_tokenHash_unique" ON "TenantInvite" USING btree ("tokenHash") WHERE "tokenHash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "TenantInvite_pending_per_tenancy_unique" ON "TenantInvite" USING btree ("tenancyId") WHERE status = 'PENDING' AND "tenancyId" IS NOT NULL;