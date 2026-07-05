CREATE TABLE "SupportContact" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"secondaryPhone" text,
	"company" text,
	"serviceArea" text,
	"notes" text,
	"isPinned" boolean DEFAULT false NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "SupportContact" ADD CONSTRAINT "SupportContact_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;