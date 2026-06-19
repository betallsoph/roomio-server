CREATE TABLE "AutomationJob" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"scheduledFor" text NOT NULL,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	"payload" text,
	"result" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "NotificationQueue" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"tenantId" text,
	"recipientUserId" text,
	"type" text NOT NULL,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"relatedType" text,
	"relatedId" text,
	"scheduledFor" text NOT NULL,
	"sentAt" timestamp with time zone,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PaymentTransaction" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text,
	"invoiceId" text,
	"provider" text DEFAULT 'sepay' NOT NULL,
	"providerTransactionId" text,
	"invoiceCode" text,
	"amount" double precision NOT NULL,
	"transferType" text NOT NULL,
	"content" text,
	"status" text NOT NULL,
	"rawPayload" text NOT NULL,
	"receivedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "AutomationJob" ADD CONSTRAINT "AutomationJob_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "NotificationQueue" ADD CONSTRAINT "NotificationQueue_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "NotificationQueue" ADD CONSTRAINT "NotificationQueue_tenantId_TenantProfile_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."TenantProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "NotificationQueue" ADD CONSTRAINT "NotificationQueue_recipientUserId_User_id_fk" FOREIGN KEY ("recipientUserId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_invoiceId_Invoice_id_fk" FOREIGN KEY ("invoiceId") REFERENCES "public"."Invoice"("id") ON DELETE set null ON UPDATE no action;