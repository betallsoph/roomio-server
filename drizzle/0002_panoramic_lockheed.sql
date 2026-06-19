ALTER TABLE "PaymentTransaction" ALTER COLUMN "provider" SET DEFAULT 'payos';--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "paymentProvider" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "payosOrderCode" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "payosPaymentLinkId" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "payosCheckoutUrl" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "payosQrCode" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "payosStatus" text;