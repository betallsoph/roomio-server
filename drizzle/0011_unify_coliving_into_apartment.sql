-- COLIVING từng là một lựa chọn riêng. Từ đây Chung cư (APARTMENT) chính là mô hình
-- co-living/share phòng; giữ dữ liệu cũ nhưng quy về một mã duy nhất.

INSERT INTO "Block" ("id", "propertyId", "name")
SELECT md5(random()::text || clock_timestamp()::text || p."id"), p."id", 'Mặc định'
FROM "Property" p
WHERE p."rentalType" = 'COLIVING'
  AND NOT EXISTS (SELECT 1 FROM "Block" b WHERE b."propertyId" = p."id");

UPDATE "Room" r
SET "blockId" = COALESCE(r."blockId", (
      SELECT min(b."id") FROM "Block" b WHERE b."propertyId" = r."propertyId"
    )),
    "floor" = COALESCE(r."floor", 1),
    "roomCode" = COALESCE(NULLIF(r."roomCode", ''), r."roomNumber")
FROM "Property" p
WHERE r."propertyId" = p."id"
  AND p."rentalType" = 'COLIVING';

UPDATE "Property"
SET "rentalType" = 'APARTMENT'
WHERE "rentalType" = 'COLIVING';

UPDATE "LandlordProfile" lp
SET "enabledRentalTypes" = (
  SELECT string_agg(types."type", ',' ORDER BY types."type")
  FROM (
    SELECT DISTINCT CASE WHEN trim(raw."type") = 'COLIVING' THEN 'APARTMENT' ELSE trim(raw."type") END AS "type"
    FROM unnest(string_to_array(lp."enabledRentalTypes", ',')) AS raw("type")
    WHERE trim(raw."type") <> ''
  ) types
)
WHERE lp."enabledRentalTypes" LIKE '%COLIVING%';

UPDATE "SubscriptionChangeRequest" req
SET "requestedRentalTypes" = (
  SELECT string_agg(types."type", ',' ORDER BY types."type")
  FROM (
    SELECT DISTINCT CASE WHEN trim(raw."type") = 'COLIVING' THEN 'APARTMENT' ELSE trim(raw."type") END AS "type"
    FROM unnest(string_to_array(req."requestedRentalTypes", ',')) AS raw("type")
    WHERE trim(raw."type") <> ''
  ) types
)
WHERE req."requestedRentalTypes" LIKE '%COLIVING%';

UPDATE "SubscriptionChangeRequest"
SET "requestedRoomAdditions" = (
  (
    "requestedRoomAdditions"::jsonb - 'COLIVING' - 'APARTMENT'
  ) || jsonb_build_object(
    'APARTMENT',
    COALESCE(("requestedRoomAdditions"::jsonb ->> 'APARTMENT')::integer, 0) +
    COALESCE(("requestedRoomAdditions"::jsonb ->> 'COLIVING')::integer, 0)
  )
)::text
WHERE "requestedRoomAdditions" IS NOT NULL
  AND "requestedRoomAdditions"::jsonb ? 'COLIVING';
