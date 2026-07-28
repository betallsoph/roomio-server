CREATE TABLE "AuditEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text,
	"actorType" text NOT NULL,
	"actorUserId" text,
	"actorRole" text,
	"action" text NOT NULL,
	"resourceType" text NOT NULL,
	"resourceId" text NOT NULL,
	"requestId" text,
	"jobId" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadataVersion" integer DEFAULT 1 NOT NULL,
	"occurredAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_User_id_fk" FOREIGN KEY ("actorUserId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "AuditEvent_landlord_timeline_idx" ON "AuditEvent" USING btree ("landlordId","occurredAt" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "AuditEvent_resource_timeline_idx" ON "AuditEvent" USING btree ("resourceType","resourceId","occurredAt");--> statement-breakpoint
CREATE INDEX "AuditEvent_requestId_idx" ON "AuditEvent" USING btree ("requestId");
--> statement-breakpoint
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actor_type_chk" CHECK ("actorType" IN ('USER', 'MACHINE', 'SYSTEM'));
--> statement-breakpoint
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actor_user_chk" CHECK (("actorType" <> 'USER') OR ("actorUserId" IS NOT NULL));
