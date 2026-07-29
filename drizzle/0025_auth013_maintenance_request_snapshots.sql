ALTER TABLE "MaintenanceRequest" ADD COLUMN "landlordId" text;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD COLUMN "propertyId" text;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD COLUMN "roomId" text;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_propertyId_Property_id_fk" FOREIGN KEY ("propertyId") REFERENCES "public"."Property"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_roomId_Room_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "MaintenanceRequest_landlordId_idx" ON "MaintenanceRequest" USING btree ("landlordId");--> statement-breakpoint
CREATE INDEX "MaintenanceRequest_propertyId_idx" ON "MaintenanceRequest" USING btree ("propertyId");--> statement-breakpoint
CREATE INDEX "MaintenanceRequest_roomId_idx" ON "MaintenanceRequest" USING btree ("roomId");