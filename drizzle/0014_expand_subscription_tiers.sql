-- Preserve the capacity and price of existing 51–100 subscriptions by moving
-- them to the new 81–100 tier. The previous contact-only tier remains
-- contact-only after the boundary moves from 100 to 150 rooms.
UPDATE "LandlordProfile"
SET "subscriptionType" = 'ROOMS_81_100'
WHERE "subscriptionType" = 'ROOMS_51_100';

UPDATE "LandlordProfile"
SET "subscriptionType" = 'ROOMS_151_PLUS'
WHERE "subscriptionType" = 'ROOMS_101_PLUS';

UPDATE "SubscriptionChangeRequest"
SET "requestedTier" = 'ROOMS_81_100'
WHERE "requestedTier" = 'ROOMS_51_100';

UPDATE "SubscriptionChangeRequest"
SET "requestedTier" = 'ROOMS_151_PLUS'
WHERE "requestedTier" = 'ROOMS_101_PLUS';

UPDATE "SubscriptionChangeRequest"
SET "currentTier" = 'ROOMS_81_100'
WHERE "currentTier" = 'ROOMS_51_100';

UPDATE "SubscriptionChangeRequest"
SET "currentTier" = 'ROOMS_151_PLUS'
WHERE "currentTier" = 'ROOMS_101_PLUS';
