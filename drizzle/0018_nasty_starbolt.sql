CREATE TABLE "PaymentAccount" (
	"id" text PRIMARY KEY NOT NULL,
	"landlordId" text NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'vietqr' NOT NULL,
	"isDefault" boolean DEFAULT false NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"bankName" text DEFAULT 'Vietcombank' NOT NULL,
	"bankCode" text DEFAULT 'VCB' NOT NULL,
	"accountNumber" text DEFAULT '' NOT NULL,
	"accountName" text DEFAULT '' NOT NULL,
	"bankBranch" text,
	"momoNumber" text,
	"payosClientId" text,
	"payosApiKeyEnc" text,
	"payosChecksumKeyEnc" text,
	"payosConnectedAt" timestamp with time zone,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Contract" ADD COLUMN "paymentAccountId" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "paymentAccountId" text;--> statement-breakpoint
ALTER TABLE "PaymentTransaction" ADD COLUMN "paymentAccountId" text;--> statement-breakpoint
ALTER TABLE "Room" ADD COLUMN "paymentAccountId" text;--> statement-breakpoint
ALTER TABLE "PaymentAccount" ADD CONSTRAINT "PaymentAccount_landlordId_LandlordProfile_id_fk" FOREIGN KEY ("landlordId") REFERENCES "public"."LandlordProfile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "PaymentAccount_landlordId_idx" ON "PaymentAccount" USING btree ("landlordId");--> statement-breakpoint
CREATE INDEX "PaymentAccount_default_idx" ON "PaymentAccount" USING btree ("landlordId","isDefault");--> statement-breakpoint
CREATE INDEX "PaymentAccount_active_idx" ON "PaymentAccount" USING btree ("landlordId","isActive");--> statement-breakpoint
INSERT INTO "PaymentAccount" (
	"id",
	"landlordId",
	"name",
	"provider",
	"isDefault",
	"isActive",
	"bankName",
	"bankCode",
	"accountNumber",
	"accountName",
	"bankBranch",
	"momoNumber",
	"payosClientId",
	"payosApiKeyEnc",
	"payosChecksumKeyEnc",
	"payosConnectedAt",
	"createdAt",
	"updatedAt"
)
SELECT
	md5(random()::text || clock_timestamp()::text || lp."id"),
	lp."id",
	COALESCE(NULLIF(lp."companyName", ''), NULLIF(lp."accountName", ''), 'Tài khoản mặc định') || ' mặc định',
	CASE
		WHEN lp."payosClientId" IS NOT NULL
			AND lp."payosApiKeyEnc" IS NOT NULL
			AND lp."payosChecksumKeyEnc" IS NOT NULL THEN 'payos'
		ELSE 'vietqr'
	END,
	true,
	true,
	lp."bankName",
	lp."bankCode",
	lp."accountNumber",
	lp."accountName",
	lp."bankBranch",
	lp."momoNumber",
	lp."payosClientId",
	lp."payosApiKeyEnc",
	lp."payosChecksumKeyEnc",
	lp."payosConnectedAt",
	NOW(),
	NOW()
FROM "LandlordProfile" lp
WHERE NOT EXISTS (
	SELECT 1 FROM "PaymentAccount" pa WHERE pa."landlordId" = lp."id" AND pa."isActive" = true
);--> statement-breakpoint
UPDATE "Room" r
SET "paymentAccountId" = pa."id"
FROM "Property" p
JOIN "PaymentAccount" pa ON pa."landlordId" = p."landlordId" AND pa."isDefault" = true AND pa."isActive" = true
WHERE r."propertyId" = p."id" AND r."paymentAccountId" IS NULL;--> statement-breakpoint
UPDATE "Contract" c
SET "paymentAccountId" = r."paymentAccountId"
FROM "Room" r
WHERE c."roomId" = r."id" AND c."paymentAccountId" IS NULL;--> statement-breakpoint
UPDATE "Invoice" i
SET "paymentAccountId" = r."paymentAccountId"
FROM "Room" r
WHERE i."roomId" = r."id" AND i."paymentAccountId" IS NULL;--> statement-breakpoint
UPDATE "PaymentTransaction" pt
SET "paymentAccountId" = i."paymentAccountId"
FROM "Invoice" i
WHERE pt."invoiceId" = i."id" AND pt."paymentAccountId" IS NULL;--> statement-breakpoint
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_paymentAccountId_PaymentAccount_id_fk" FOREIGN KEY ("paymentAccountId") REFERENCES "public"."PaymentAccount"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_paymentAccountId_PaymentAccount_id_fk" FOREIGN KEY ("paymentAccountId") REFERENCES "public"."PaymentAccount"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_paymentAccountId_PaymentAccount_id_fk" FOREIGN KEY ("paymentAccountId") REFERENCES "public"."PaymentAccount"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Room" ADD CONSTRAINT "Room_paymentAccountId_PaymentAccount_id_fk" FOREIGN KEY ("paymentAccountId") REFERENCES "public"."PaymentAccount"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Contract_paymentAccountId_idx" ON "Contract" USING btree ("paymentAccountId");--> statement-breakpoint
CREATE INDEX "Invoice_paymentAccountId_idx" ON "Invoice" USING btree ("paymentAccountId");--> statement-breakpoint
CREATE INDEX "PaymentTransaction_paymentAccountId_idx" ON "PaymentTransaction" USING btree ("paymentAccountId");--> statement-breakpoint
CREATE INDEX "Room_paymentAccountId_idx" ON "Room" USING btree ("paymentAccountId");
