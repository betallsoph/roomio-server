CREATE TABLE "Announcement" (
	"id" text PRIMARY KEY NOT NULL,
	"senderId" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"isImportant" boolean DEFAULT false NOT NULL,
	"targetType" text NOT NULL,
	"targetId" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Block" (
	"id" text PRIMARY KEY NOT NULL,
	"propertyId" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Contract" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"roomId" text NOT NULL,
	"startDate" text NOT NULL,
	"endDate" text NOT NULL,
	"monthlyRent" double precision NOT NULL,
	"deposit" double precision DEFAULT 0 NOT NULL,
	"fileUrl" text,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Expense" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"propertyId" text,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"amount" double precision NOT NULL,
	"date" text NOT NULL,
	"notes" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "InvoiceItem" (
	"id" text PRIMARY KEY NOT NULL,
	"invoiceId" text NOT NULL,
	"name" text NOT NULL,
	"amount" double precision NOT NULL,
	"details" text
);
--> statement-breakpoint
CREATE TABLE "Invoice" (
	"id" text PRIMARY KEY NOT NULL,
	"roomId" text NOT NULL,
	"roomNumber" text NOT NULL,
	"tenantName" text NOT NULL,
	"tenantPhone" text NOT NULL,
	"month" text NOT NULL,
	"rentAmount" double precision NOT NULL,
	"totalAmount" double precision NOT NULL,
	"dueDate" text NOT NULL,
	"paidDate" text,
	"status" text NOT NULL,
	"paidAmount" double precision DEFAULT 0 NOT NULL,
	"paymentProofImage" text,
	"paymentMethod" text,
	"createdAt" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "LandlordProfile" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"subscriptionType" text DEFAULT 'FREE' NOT NULL,
	"subValidUntil" timestamp with time zone,
	"companyName" text,
	"bankName" text DEFAULT 'Vietcombank' NOT NULL,
	"bankCode" text DEFAULT 'VCB' NOT NULL,
	"accountNumber" text DEFAULT '1234567890' NOT NULL,
	"accountName" text DEFAULT 'NGUYEN VAN HAU' NOT NULL,
	"bankBranch" text DEFAULT 'Chi nhánh TP.HCM' NOT NULL,
	"momoNumber" text,
	CONSTRAINT "LandlordProfile_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "MaintenanceRequest" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"roomNumber" text NOT NULL,
	"buildingName" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"imageUrl" text,
	"status" text NOT NULL,
	"priority" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"response" text,
	"assignedToId" text
);
--> statement-breakpoint
CREATE TABLE "Message" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"senderId" text NOT NULL,
	"content" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "MeterReading" (
	"id" text PRIMARY KEY NOT NULL,
	"roomId" text NOT NULL,
	"serviceId" text NOT NULL,
	"month" text NOT NULL,
	"prevValue" double precision NOT NULL,
	"currValue" double precision NOT NULL,
	"recordedAt" text NOT NULL,
	"photoUrl" text,
	"status" text DEFAULT 'approved' NOT NULL,
	"submittedBy" text DEFAULT 'LANDLORD' NOT NULL,
	"isAnomalous" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Property" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"name" text NOT NULL,
	"shortName" text NOT NULL,
	"address" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "RoomAsset" (
	"id" text PRIMARY KEY NOT NULL,
	"roomId" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"status" text NOT NULL,
	"imageUrl" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "RoomServiceConfig" (
	"id" text PRIMARY KEY NOT NULL,
	"roomId" text NOT NULL,
	"serviceId" text NOT NULL,
	"customRate" double precision,
	"quantity" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Room" (
	"id" text PRIMARY KEY NOT NULL,
	"propertyId" text NOT NULL,
	"blockId" text,
	"roomNumber" text NOT NULL,
	"roomCode" text,
	"roomType" text NOT NULL,
	"floor" integer,
	"status" text NOT NULL,
	"monthlyRent" double precision NOT NULL,
	"area" double precision,
	"debtAmount" double precision DEFAULT 0,
	"tenantId" text
);
--> statement-breakpoint
CREATE TABLE "Service" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"defaultRate" double precision NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "SpecialNote" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"content" text NOT NULL,
	"sender" text DEFAULT 'TENANT' NOT NULL,
	"isRead" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "StaffProfile" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"landlordId" text NOT NULL,
	CONSTRAINT "StaffProfile_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "TenantProfile" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"idNumber" text NOT NULL,
	"idFrontImage" text,
	"idBackImage" text,
	"vehicleImage" text,
	"checkInImage" text,
	"moveInDate" text NOT NULL,
	"deposit" double precision NOT NULL,
	"notes" text,
	CONSTRAINT "TenantProfile_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "User" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"passwordHash" text NOT NULL,
	"name" text NOT NULL,
	"avatar" text,
	"role" text DEFAULT 'TENANT' NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "User_email_unique" UNIQUE("email"),
	CONSTRAINT "User_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "Block" ADD CONSTRAINT "Block_propertyId_Property_id_fk" FOREIGN KEY ("propertyId") REFERENCES "public"."Property"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_tenantId_TenantProfile_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."TenantProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_roomId_Room_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_propertyId_Property_id_fk" FOREIGN KEY ("propertyId") REFERENCES "public"."Property"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_Invoice_id_fk" FOREIGN KEY ("invoiceId") REFERENCES "public"."Invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_roomId_Room_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LandlordProfile" ADD CONSTRAINT "LandlordProfile_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_TenantProfile_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."TenantProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_assignedToId_StaffProfile_id_fk" FOREIGN KEY ("assignedToId") REFERENCES "public"."StaffProfile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_roomId_Room_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Property" ADD CONSTRAINT "Property_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RoomAsset" ADD CONSTRAINT "RoomAsset_roomId_Room_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RoomServiceConfig" ADD CONSTRAINT "RoomServiceConfig_roomId_Room_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RoomServiceConfig" ADD CONSTRAINT "RoomServiceConfig_serviceId_Service_id_fk" FOREIGN KEY ("serviceId") REFERENCES "public"."Service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Room" ADD CONSTRAINT "Room_propertyId_Property_id_fk" FOREIGN KEY ("propertyId") REFERENCES "public"."Property"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Room" ADD CONSTRAINT "Room_blockId_Block_id_fk" FOREIGN KEY ("blockId") REFERENCES "public"."Block"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Room" ADD CONSTRAINT "Room_tenantId_TenantProfile_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."TenantProfile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Service" ADD CONSTRAINT "Service_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SpecialNote" ADD CONSTRAINT "SpecialNote_tenantId_TenantProfile_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."TenantProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantProfile" ADD CONSTRAINT "TenantProfile_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;