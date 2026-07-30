ALTER TABLE "MaintenanceRequest" ADD COLUMN "landlordId" text;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD COLUMN "propertyId" text;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD COLUMN "roomId" text;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD COLUMN "landlordId" text;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD COLUMN "propertyId" text;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" DROP CONSTRAINT "MaintenanceRequest_managedTenantId_ManagedTenant_id_fk";--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" DROP CONSTRAINT "MaintenanceRequest_tenancyId_Tenancy_id_fk";--> statement-breakpoint
ALTER TABLE "MeterReading" DROP CONSTRAINT "MeterReading_managedTenantId_ManagedTenant_id_fk";--> statement-breakpoint
ALTER TABLE "MeterReading" DROP CONSTRAINT "MeterReading_tenancyId_Tenancy_id_fk";--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_propertyId_Property_id_fk" FOREIGN KEY ("propertyId") REFERENCES "public"."Property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_roomId_Room_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenancyId_Tenancy_id_fk" FOREIGN KEY ("tenancyId") REFERENCES "public"."Tenancy"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_propertyId_Property_id_fk" FOREIGN KEY ("propertyId") REFERENCES "public"."Property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_managedTenantId_ManagedTenant_id_fk" FOREIGN KEY ("managedTenantId") REFERENCES "public"."ManagedTenant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_tenancyId_Tenancy_id_fk" FOREIGN KEY ("tenancyId") REFERENCES "public"."Tenancy"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MeterReading" DROP CONSTRAINT "MeterReading_roomId_Room_id_fk";--> statement-breakpoint
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_roomId_Room_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" DROP CONSTRAINT "MaintenanceRequest_tenantId_TenantProfile_id_fk";--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_TenantProfile_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."TenantProfile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "MaintenanceRequest_landlordId_idx" ON "MaintenanceRequest" USING btree ("landlordId");--> statement-breakpoint
CREATE INDEX "MaintenanceRequest_propertyId_idx" ON "MaintenanceRequest" USING btree ("propertyId");--> statement-breakpoint
CREATE INDEX "MaintenanceRequest_roomId_idx" ON "MaintenanceRequest" USING btree ("roomId");--> statement-breakpoint
CREATE INDEX "MeterReading_landlordId_idx" ON "MeterReading" USING btree ("landlordId");--> statement-breakpoint
CREATE INDEX "MeterReading_propertyId_idx" ON "MeterReading" USING btree ("propertyId");
