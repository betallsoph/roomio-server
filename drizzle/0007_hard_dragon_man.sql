CREATE TABLE "SubscriptionChangeRequest" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"requestedTier" text NOT NULL,
	"requestedPeriod" text NOT NULL,
	"currentTier" text NOT NULL,
	"currentPeriod" text NOT NULL,
	"standardRoomCount" integer NOT NULL,
	"colivingRoomCount" integer NOT NULL,
	"quotedMonthlyPrice" double precision,
	"quotedPeriodPrice" double precision,
	"pricingStrategy" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"adminNote" text,
	"createdAt" timestamp with time zone NOT NULL,
	"reviewedAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "SubscriptionChangeRequest" ADD CONSTRAINT "SubscriptionChangeRequest_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;