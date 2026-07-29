CREATE TABLE "StaffPermission" (
	"id" text PRIMARY KEY NOT NULL,
	"staffId" text NOT NULL,
	"permission" text NOT NULL,
	"grantedByUserId" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"revokedAt" timestamp with time zone,
	CONSTRAINT "StaffPermission_permission_allowed" CHECK ("permission" IN ('VIEW_ROOMS','VIEW_TENANTS','MANAGE_METERS','MANAGE_REQUESTS'))
);
--> statement-breakpoint
CREATE TABLE "StaffPropertyAssignment" (
	"id" text PRIMARY KEY NOT NULL,
	"staffId" text NOT NULL,
	"propertyId" text NOT NULL,
	"assignedByUserId" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"revokedAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "StaffPermission" ADD CONSTRAINT "StaffPermission_staffId_StaffProfile_id_fk" FOREIGN KEY ("staffId") REFERENCES "public"."StaffProfile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StaffPermission" ADD CONSTRAINT "StaffPermission_grantedByUserId_User_id_fk" FOREIGN KEY ("grantedByUserId") REFERENCES "public"."User"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StaffPropertyAssignment" ADD CONSTRAINT "StaffPropertyAssignment_staffId_StaffProfile_id_fk" FOREIGN KEY ("staffId") REFERENCES "public"."StaffProfile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StaffPropertyAssignment" ADD CONSTRAINT "StaffPropertyAssignment_propertyId_Property_id_fk" FOREIGN KEY ("propertyId") REFERENCES "public"."Property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StaffPropertyAssignment" ADD CONSTRAINT "StaffPropertyAssignment_assignedByUserId_User_id_fk" FOREIGN KEY ("assignedByUserId") REFERENCES "public"."User"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "StaffPermission_active_staff_permission_unique" ON "StaffPermission" USING btree ("staffId","permission") WHERE "revokedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "StaffPropertyAssignment_active_staff_property_unique" ON "StaffPropertyAssignment" USING btree ("staffId","propertyId") WHERE "revokedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "StaffPropertyAssignment_propertyId_revokedAt_idx" ON "StaffPropertyAssignment" USING btree ("propertyId","revokedAt");