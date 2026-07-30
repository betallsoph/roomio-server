CREATE TABLE "Conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"managedTenantId" text NOT NULL,
	"tenancyId" text,
	"legacyConversationId" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Announcement" ADD COLUMN "landlordId" text;--> statement-breakpoint
ALTER TABLE "SpecialNote" ADD COLUMN "landlordId" text;--> statement-breakpoint
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenancyId_Tenancy_id_fk" FOREIGN KEY ("tenancyId") REFERENCES "public"."Tenancy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Conversation_landlordId_idx" ON "Conversation" USING btree ("landlordId");--> statement-breakpoint
CREATE INDEX "Conversation_managedTenantId_idx" ON "Conversation" USING btree ("managedTenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "Conversation_legacyConversationId_key" ON "Conversation" USING btree ("legacyConversationId");--> statement-breakpoint
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SpecialNote" ADD CONSTRAINT "SpecialNote_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Announcement_landlordId_idx" ON "Announcement" USING btree ("landlordId");--> statement-breakpoint
CREATE INDEX "SpecialNote_landlordId_idx" ON "SpecialNote" USING btree ("landlordId");--> statement-breakpoint
UPDATE "Announcement" a
SET "landlordId" = lp.id
FROM "LandlordProfile" lp
WHERE lp."userId" = a."senderId"
  AND a."landlordId" IS NULL;--> statement-breakpoint
UPDATE "SpecialNote" sn
SET "landlordId" = mt."landlordId"
FROM "ManagedTenant" mt
WHERE mt.id = sn."managedTenantId"
  AND sn."landlordId" IS NULL;--> statement-breakpoint
UPDATE "SpecialNote" sn
SET "landlordId" = p."landlordId"
FROM "TenantProfile" tp
INNER JOIN "Room" r ON r."tenantId" = tp.id
INNER JOIN "Property" p ON p.id = r."propertyId"
WHERE tp.id = sn."tenantId"
  AND sn."landlordId" IS NULL;--> statement-breakpoint
INSERT INTO "Conversation" ("id", "landlordId", "managedTenantId", "tenancyId", "legacyConversationId", "createdAt")
SELECT DISTINCT ON (m."conversationId")
  gen_random_uuid()::text,
  split_part(m."conversationId", '_', 1),
  mt.id,
  t.id,
  m."conversationId",
  NOW()
FROM "Message" m
INNER JOIN "LandlordProfile" lp ON lp.id = split_part(m."conversationId", '_', 1)
INNER JOIN "TenantProfile" tp ON tp.id = split_part(m."conversationId", '_', 2)
INNER JOIN "ManagedTenant" mt ON mt."legacyTenantProfileId" = tp.id AND mt."landlordId" = lp.id
LEFT JOIN LATERAL (
  SELECT t2.id
  FROM "Tenancy" t2
  WHERE t2."managedTenantId" = mt.id
    AND t2.status = 'ACTIVE'
  ORDER BY t2."startDate" DESC
  LIMIT 1
) t ON true
WHERE m."conversationId" LIKE '%\_%'
  AND NOT EXISTS (
    SELECT 1 FROM "Conversation" c WHERE c."legacyConversationId" = m."conversationId"
  );