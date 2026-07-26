ALTER TABLE "LandlordProfile" ALTER COLUMN "bankName" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "LandlordProfile" ALTER COLUMN "bankCode" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "LandlordProfile" ALTER COLUMN "accountNumber" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "LandlordProfile" ALTER COLUMN "accountName" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "LandlordProfile" ALTER COLUMN "bankBranch" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "PaymentAccount" ALTER COLUMN "bankName" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "PaymentAccount" ALTER COLUMN "bankCode" SET DEFAULT '';--> statement-breakpoint
UPDATE "PaymentAccount"
SET
	"isDefault" = false,
	"isActive" = false,
	"bankName" = '',
	"bankCode" = '',
	"accountNumber" = '',
	"accountName" = '',
	"bankBranch" = NULL,
	"updatedAt" = NOW()
WHERE
	"accountNumber" = '1234567890'
	AND ("bankCode" = 'VCB' OR "bankName" = 'Vietcombank');--> statement-breakpoint
UPDATE "LandlordProfile"
SET
	"bankName" = '',
	"bankCode" = '',
	"accountNumber" = '',
	"accountName" = '',
	"bankBranch" = ''
WHERE
	"accountNumber" = '1234567890'
	AND ("bankCode" = 'VCB' OR "bankName" = 'Vietcombank');
