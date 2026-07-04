-- Phòng trọ truyền thống và căn hộ dịch vụ dùng chung một loại hình vận hành.

UPDATE "Property"
SET "rentalType" = 'MOTEL'
WHERE "rentalType" = 'SERVICED_APARTMENT';

UPDATE "LandlordProfile" lp
SET "enabledRentalTypes" = (
  SELECT string_agg(types."type", ',' ORDER BY types."type")
  FROM (
    SELECT DISTINCT CASE WHEN trim(raw."type") = 'SERVICED_APARTMENT' THEN 'MOTEL' ELSE trim(raw."type") END AS "type"
    FROM unnest(string_to_array(lp."enabledRentalTypes", ',')) AS raw("type")
    WHERE trim(raw."type") <> ''
  ) types
)
WHERE lp."enabledRentalTypes" LIKE '%SERVICED_APARTMENT%';

UPDATE "SubscriptionChangeRequest" req
SET "requestedRentalTypes" = (
  SELECT string_agg(types."type", ',' ORDER BY types."type")
  FROM (
    SELECT DISTINCT CASE WHEN trim(raw."type") = 'SERVICED_APARTMENT' THEN 'MOTEL' ELSE trim(raw."type") END AS "type"
    FROM unnest(string_to_array(req."requestedRentalTypes", ',')) AS raw("type")
    WHERE trim(raw."type") <> ''
  ) types
)
WHERE req."requestedRentalTypes" LIKE '%SERVICED_APARTMENT%';

UPDATE "SubscriptionChangeRequest"
SET "requestedRoomAdditions" = (
  (
    "requestedRoomAdditions"::jsonb - 'SERVICED_APARTMENT' - 'MOTEL'
  ) || jsonb_build_object(
    'MOTEL',
    COALESCE(("requestedRoomAdditions"::jsonb ->> 'MOTEL')::integer, 0) +
    COALESCE(("requestedRoomAdditions"::jsonb ->> 'SERVICED_APARTMENT')::integer, 0)
  )
)::text
WHERE "requestedRoomAdditions" IS NOT NULL
  AND "requestedRoomAdditions"::jsonb ? 'SERVICED_APARTMENT';
