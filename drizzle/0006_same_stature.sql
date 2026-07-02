ALTER TABLE "LandlordProfile" ADD COLUMN "subscriptionPeriod" text DEFAULT 'MONTHLY' NOT NULL;
UPDATE "LandlordProfile" SET "subscriptionType" = 'ROOMS_4_10' WHERE "subscriptionType" = 'PREMIUM';
UPDATE "LandlordProfile" SET "subscriptionType" = 'ROOMS_101_PLUS' WHERE "subscriptionType" = 'ENTERPRISE';
