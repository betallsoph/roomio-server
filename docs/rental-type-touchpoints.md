# Rental type & operating model touchpoints

Generated: 2026-07-16 (Phase 0 audit). Pattern: `COLIVING|SERVICED_APARTMENT|APARTMENT|MOTEL|DORM|WHOLE_UNIT|rentalType|operatingModel`
Excludes: `drizzle/**` migration artefacts.

## Verify SQL (prod — boss runs, not agent)

```sql
SELECT "rentalType", count(*) FROM "Property" GROUP BY 1;          -- expect: only 4 canonical values
SELECT count(*) FROM "Property" WHERE "rentalType" IN ('COLIVING','SERVICED_APARTMENT');  -- expect: 0
SELECT "operatingModel", count(*) FROM "Property" GROUP BY 1;      -- after 0019: all UNSPECIFIED
SELECT "enabledRentalTypes", count(*) FROM "LandlordProfile" GROUP BY 1;  -- inspect leftover aliases
```

## Touchpoints by repo


### roomio-api

roomio-api/src/routes/api/rooms/+server.ts:214:		if (property.rentalType === 'APARTMENT') {
roomio-api/src/routes/api/rooms/+server.ts:271:				.select({ rentalType: properties.rentalType, count: sql<number>`count(${rooms.id})` })
roomio-api/src/routes/api/rooms/+server.ts:275:				.groupBy(properties.rentalType);
roomio-api/src/routes/api/rooms/+server.ts:277:				.filter((row) => pricingGroupForRentalType(row.rentalType) === 'STANDARD')
roomio-api/src/routes/api/rooms/+server.ts:280:				.filter((row) => pricingGroupForRentalType(row.rentalType) === 'COLIVING')
roomio-api/src/routes/api/rooms/+server.ts:287:			const isColivingGroup = pricingGroupForRentalType(property.rentalType) === 'COLIVING';
roomio-api/src/routes/api/rooms/+server.ts:516:				if (property.rentalType === 'APARTMENT') {
roomio-api/src/routes/api/rooms/+server.ts:560:					(property.rentalType === 'APARTMENT' &&
roomio-api/src/routes/api/properties/+server.ts:47:async function landlordAllowsRentalType(landlordId: string, rentalType: string) {
roomio-api/src/routes/api/properties/+server.ts:52:	const enabled = profile?.enabledRentalTypes?.split(',').map(canonicalRentalType) ?? ['APARTMENT'];
roomio-api/src/routes/api/properties/+server.ts:53:	return enabled.includes(rentalType);
roomio-api/src/routes/api/properties/+server.ts:90:		const rentalType = normalizeRentalTypeOr(body.rentalType);
roomio-api/src/routes/api/properties/+server.ts:91:		const operatingModelResult = resolveOperatingModelForPost(body.operatingModel);
roomio-api/src/routes/api/properties/+server.ts:92:		if (!operatingModelResult.ok) {
roomio-api/src/routes/api/properties/+server.ts:99:		if (!(await landlordAllowsRentalType(landlordId, rentalType))) {
roomio-api/src/routes/api/properties/+server.ts:103:			rentalType === 'APARTMENT' &&
roomio-api/src/routes/api/properties/+server.ts:120:						rentalType,
roomio-api/src/routes/api/properties/+server.ts:121:						operatingModel: operatingModelResult.value
roomio-api/src/routes/api/properties/+server.ts:170:			body.rentalType !== undefined ? normalizeRentalTypeOr(body.rentalType) : null;
roomio-api/src/routes/api/properties/+server.ts:171:		const operatingModelResult = resolveOperatingModelForPut(body.operatingModel);
roomio-api/src/routes/api/properties/+server.ts:172:		if (!operatingModelResult.ok) {
roomio-api/src/routes/api/properties/+server.ts:184:						.select({ rentalType: properties.rentalType })
roomio-api/src/routes/api/properties/+server.ts:190:					currentProperty.rentalType !== requestedRentalType &&
roomio-api/src/routes/api/properties/+server.ts:191:					pricingGroupForRentalType(currentProperty.rentalType) !==
roomio-api/src/routes/api/properties/+server.ts:203:					const targetIsColiving = pricingGroupForRentalType(requestedRentalType) === 'COLIVING';
roomio-api/src/routes/api/properties/+server.ts:224:												? sql`${properties.rentalType} in ('APARTMENT', 'COLIVING')`
roomio-api/src/routes/api/properties/+server.ts:225:												: sql`${properties.rentalType} not in ('APARTMENT', 'COLIVING')`
roomio-api/src/routes/api/properties/+server.ts:243:			if (requestedRentalType) updateData.rentalType = requestedRentalType;
roomio-api/src/routes/api/properties/+server.ts:244:			if ('value' in operatingModelResult) {
roomio-api/src/routes/api/properties/+server.ts:245:				updateData.operatingModel = operatingModelResult.value;
roomio-api/src/routes/api/super-admin/+server.ts:36:	if (value === undefined || value === null) return 'APARTMENT';
roomio-api/src/routes/api/super-admin/+server.ts:95:					columns: { id: true, name: true, rentalType: true, operatingModel: true },
roomio-api/src/routes/api/super-admin/+server.ts:126:					.filter((property) => pricingGroupForRentalType(property.rentalType) === 'STANDARD')
roomio-api/src/routes/api/super-admin/+server.ts:129:					.filter((property) => pricingGroupForRentalType(property.rentalType) === 'COLIVING')
roomio-api/src/routes/api/super-admin/+server.ts:171:						rentalType: property.rentalType,
roomio-api/src/routes/api/super-admin/+server.ts:172:						operatingModel: property.operatingModel,
roomio-api/src/routes/api/super-admin/+server.ts:250:			![...enabledTypeSet].some((type) => pricingGroupForRentalType(type) === 'COLIVING')
roomio-api/src/lib/server/subscription-pricing.ts:11:export type PricingGroup = 'STANDARD' | 'COLIVING';
roomio-api/src/lib/server/subscription-pricing.ts:26:export function pricingGroupForRentalType(rentalType: string | null | undefined): PricingGroup {
roomio-api/src/lib/server/subscription-pricing.ts:27:	return rentalType === 'APARTMENT' || rentalType === 'COLIVING' ? 'COLIVING' : 'STANDARD';
roomio-api/src/lib/server/subscription-pricing.ts:56:	COLIVING: {
roomio-api/src/lib/server/subscription-pricing.ts:133:		standardRoomCount > 0 ? 'STANDARD' : colivingRoomCount > 0 ? 'COLIVING' : 'STANDARD';
roomio-api/src/lib/server/subscription-pricing.ts:155:			group: 'COLIVING',
roomio-api/src/lib/server/subscription-pricing.ts:158:			monthlyPrice: monthlyPrice('COLIVING', colivingTier)
roomio-api/src/lib/server/rental-types.test.ts:13:	assert.equal(canonicalRentalType('coliving'), 'APARTMENT');
roomio-api/src/lib/server/rental-types.test.ts:14:	assert.equal(canonicalRentalType(' COLIVING '), 'APARTMENT');
roomio-api/src/lib/server/rental-types.test.ts:15:	assert.equal(canonicalRentalType('serviced_apartment'), 'MOTEL');
roomio-api/src/lib/server/rental-types.test.ts:16:	assert.equal(canonicalRentalType('SERVICED_APARTMENT'), 'MOTEL');
roomio-api/src/lib/server/rental-types.test.ts:17:	assert.equal(canonicalRentalType('motel'), 'MOTEL');
roomio-api/src/lib/server/rental-types.test.ts:18:	assert.equal(canonicalRentalType('APARTMENT'), 'APARTMENT');
roomio-api/src/lib/server/rental-types.test.ts:25:	assert.equal(isValidRentalType('COLIVING'), false);
roomio-api/src/lib/server/rental-types.test.ts:30:	assert.equal(normalizeRentalTypeOr('coliving'), 'APARTMENT');
roomio-api/src/lib/server/rental-types.test.ts:31:	assert.equal(normalizeRentalTypeOr('PENTHOUSE'), 'APARTMENT');
roomio-api/src/lib/server/rental-types.test.ts:32:	assert.equal(normalizeRentalTypeOr('WHOLE_UNIT'), 'WHOLE_UNIT');
roomio-api/src/lib/server/rental-types.test.ts:33:	assert.equal(normalizeRentalTypeOr(undefined), 'APARTMENT');
roomio-api/src/lib/server/rental-types.test.ts:34:	assert.equal(normalizeRentalTypeOr(null), 'APARTMENT');
roomio-api/src/lib/server/rental-types.test.ts:35:	assert.equal(normalizeRentalTypeOr(42), 'APARTMENT');
roomio-api/src/lib/server/rental-types.test.ts:36:	assert.equal(normalizeRentalTypeOr('invalid', 'DORM'), 'DORM');
roomio-api/src/lib/server/rental-types.test.ts:40:	assert.deepEqual(parseEnabledRentalTypes(' coliving, MOTEL,, '), ['APARTMENT', 'MOTEL']);
roomio-api/src/lib/server/rental-types.test.ts:41:	assert.deepEqual(parseEnabledRentalTypes('SERVICED_APARTMENT,DORM'), ['MOTEL', 'DORM']);
roomio-api/src/lib/server/rental-types.test.ts:42:	assert.deepEqual(parseEnabledRentalTypes(''), ['APARTMENT']);
roomio-api/src/lib/server/rental-types.test.ts:43:	assert.deepEqual(parseEnabledRentalTypes(null), ['APARTMENT']);
roomio-api/src/lib/server/rental-types.test.ts:44:	assert.deepEqual(parseEnabledRentalTypes('PENTHOUSE,UNKNOWN'), ['APARTMENT']);
roomio-api/src/routes/api/subscription/requests/+server.ts:25:		.select({ rentalType: properties.rentalType, count: sql<number>`count(${rooms.id})` })
roomio-api/src/routes/api/subscription/requests/+server.ts:29:		.groupBy(properties.rentalType);
roomio-api/src/routes/api/subscription/requests/+server.ts:32:			.filter((row) => pricingGroupForRentalType(row.rentalType) === 'STANDARD')
roomio-api/src/routes/api/subscription/requests/+server.ts:35:			.filter((row) => pricingGroupForRentalType(row.rentalType) === 'COLIVING')
roomio-api/src/routes/api/subscription/requests/+server.ts:139:							.filter(([type]) => pricingGroupForRentalType(type) === 'COLIVING')
roomio-api/src/routes/api/subscription/requests/+server.ts:158:			![...futureRentalTypes].some((type) => pricingGroupForRentalType(type) === 'COLIVING')
roomio-api/src/routes/api/subscription/requests/+server.ts:283:					(profileForApproval?.enabledRentalTypes || 'APARTMENT').split(',').filter(Boolean)
roomio-api/src/lib/server/rental-types.ts:1:export const RENTAL_TYPES = ['APARTMENT', 'MOTEL', 'DORM', 'WHOLE_UNIT'] as const;
roomio-api/src/lib/server/rental-types.ts:7:	if (type === 'COLIVING') return 'APARTMENT';
roomio-api/src/lib/server/rental-types.ts:8:	if (type === 'SERVICED_APARTMENT') return 'MOTEL';
roomio-api/src/lib/server/rental-types.ts:19:	fallback: RentalType = 'APARTMENT'
roomio-api/src/lib/server/rental-types.ts:26:/** Split comma list, canonicalize, dedupe, filter valid; default ['APARTMENT'] when empty. */
roomio-api/src/lib/server/rental-types.ts:28:	const raw = (value ?? 'APARTMENT').split(',').map((type) => canonicalRentalType(type)).filter(Boolean);
roomio-api/src/lib/server/rental-types.ts:30:	return unique.length > 0 ? unique : ['APARTMENT'];
roomio-api/src/lib/server/db/schema.ts:41:	enabledRentalTypes: text('enabledRentalTypes').notNull().default('APARTMENT'), // comma list: APARTMENT, MOTEL, DORM, WHOLE_UNIT
roomio-api/src/lib/server/db/schema.ts:144:		rentalType: text('rentalType').notNull().default('APARTMENT'), // APARTMENT | MOTEL | DORM | WHOLE_UNIT
roomio-api/src/lib/server/db/schema.ts:145:		operatingModel: text('operatingModel').notNull().default('UNSPECIFIED'), // UNSPECIFIED | OWNED | RENT_TO_RENT | MANAGED
roomio-api/src/routes/api/subscription/quote/+server.ts:34:			.select({ rentalType: properties.rentalType, count: sql<number>`count(${rooms.id})` })
roomio-api/src/routes/api/subscription/quote/+server.ts:38:			.groupBy(properties.rentalType);
roomio-api/src/routes/api/subscription/quote/+server.ts:41:			.filter((row) => pricingGroupForRentalType(row.rentalType) === 'STANDARD')
roomio-api/src/routes/api/subscription/quote/+server.ts:44:			.filter((row) => pricingGroupForRentalType(row.rentalType) === 'COLIVING')
roomio-api/docs/subscription-pricing.md:38:- `APARTMENT` là chung cư chia sẻ phòng (co-living) và dùng bảng giá co-living. `COLIVING` cũ được tự động quy về `APARTMENT`.
roomio-api/docs/subscription-pricing.md:39:- `MOTEL` đại diện chung cho phòng trọ truyền thống và căn hộ dịch vụ. `SERVICED_APARTMENT` cũ được tự động quy về `MOTEL`.
roomio-api/docs/subscription-pricing.md:40:- `DORM` đại diện chung cho KTX và Sleepbox.
roomio-api/docs/subscription-pricing.md:41:- `WHOLE_UNIT` đại diện cho căn hộ chung cư nguyên căn hoặc nhà nguyên căn; mỗi căn/nhà được tính là 1 đơn vị cho thuê trong hạn mức/gói.

### roomio-web

roomio-web/src/routes/dashboard/rooms/+page.svelte:88:		rentalType: string;
roomio-web/src/routes/dashboard/rooms/+page.svelte:97:	let enabledRentalTypes = $state<string[]>(['APARTMENT']);
roomio-web/src/routes/dashboard/rooms/+page.svelte:129:	let quickPropertyRentalType = $state('APARTMENT');
roomio-web/src/routes/dashboard/rooms/+page.svelte:149:			value: 'APARTMENT',
roomio-web/src/routes/dashboard/rooms/+page.svelte:154:			value: 'MOTEL',
roomio-web/src/routes/dashboard/rooms/+page.svelte:158:		{ value: 'DORM', label: 'KTX / Sleepbox', lines: ['KTX', 'Sleepbox'] },
roomio-web/src/routes/dashboard/rooms/+page.svelte:160:			value: 'WHOLE_UNIT',
roomio-web/src/routes/dashboard/rooms/+page.svelte:173:			quickPropertyRentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-web/src/routes/dashboard/rooms/+page.svelte:187:		const parsed = (value || 'APARTMENT')
roomio-web/src/routes/dashboard/rooms/+page.svelte:191:		return parsed.length > 0 ? parsed : ['APARTMENT'];
roomio-web/src/routes/dashboard/rooms/+page.svelte:201:				quickPropertyRentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-web/src/routes/dashboard/rooms/+page.svelte:327:		const isApartmentRoomForm = activeRentalType() === 'APARTMENT';
roomio-web/src/routes/dashboard/rooms/+page.svelte:665:		return getActiveProperty()?.rentalType ?? 'APARTMENT';
roomio-web/src/routes/dashboard/rooms/+page.svelte:670:		if (type === 'COLIVING') return 'Chung cư / Co-living';
roomio-web/src/routes/dashboard/rooms/+page.svelte:671:		if (type === 'MOTEL') return 'Khu trọ';
roomio-web/src/routes/dashboard/rooms/+page.svelte:672:		if (type === 'SERVICED_APARTMENT') return 'Căn hộ dịch vụ';
roomio-web/src/routes/dashboard/rooms/+page.svelte:673:		if (type === 'DORM') return 'KTX / Sleepbox';
roomio-web/src/routes/dashboard/rooms/+page.svelte:674:		if (type === 'WHOLE_UNIT') return 'Nguyên căn';
roomio-web/src/routes/dashboard/rooms/+page.svelte:679:		if (type === 'COLIVING') return 'căn co-living';
roomio-web/src/routes/dashboard/rooms/+page.svelte:680:		if (type === 'MOTEL') return 'khu trọ';
roomio-web/src/routes/dashboard/rooms/+page.svelte:681:		if (type === 'SERVICED_APARTMENT') return 'tòa nhà căn hộ dịch vụ';
roomio-web/src/routes/dashboard/rooms/+page.svelte:682:		if (type === 'DORM') return 'khu KTX / sleepbox';
roomio-web/src/routes/dashboard/rooms/+page.svelte:683:		if (type === 'WHOLE_UNIT') return 'bất động sản nguyên căn';
roomio-web/src/routes/dashboard/rooms/+page.svelte:688:		if (type === 'COLIVING') return 'Phòng share';
roomio-web/src/routes/dashboard/rooms/+page.svelte:689:		if (type === 'MOTEL') return 'Dãy';
roomio-web/src/routes/dashboard/rooms/+page.svelte:690:		if (type === 'SERVICED_APARTMENT') return 'Tầng / khu';
roomio-web/src/routes/dashboard/rooms/+page.svelte:691:		if (type === 'DORM') return 'Phòng / khu';
roomio-web/src/routes/dashboard/rooms/+page.svelte:692:		if (type === 'WHOLE_UNIT') return 'Cụm / dự án';
roomio-web/src/routes/dashboard/rooms/+page.svelte:697:		if (type === 'COLIVING') return 'Ví dụ: Co-living Thảo Điền';
roomio-web/src/routes/dashboard/rooms/+page.svelte:698:		if (type === 'MOTEL') return 'Ví dụ: Khu trọ An Bình';
roomio-web/src/routes/dashboard/rooms/+page.svelte:699:		if (type === 'SERVICED_APARTMENT') return 'Ví dụ: CHDV Nguyễn Trãi';
roomio-web/src/routes/dashboard/rooms/+page.svelte:700:		if (type === 'DORM') return 'Ví dụ: Sleepbox Cầu Giấy';
roomio-web/src/routes/dashboard/rooms/+page.svelte:701:		if (type === 'WHOLE_UNIT') return 'Ví dụ: Căn A1205 Masteri / Nhà nguyên căn Bình Thạnh';
roomio-web/src/routes/dashboard/rooms/+page.svelte:706:		if (type === 'COLIVING') return 'Ví dụ: Phòng 1, Phòng 2';
roomio-web/src/routes/dashboard/rooms/+page.svelte:707:		if (type === 'MOTEL') return 'Ví dụ: Dãy A, Dãy B';
roomio-web/src/routes/dashboard/rooms/+page.svelte:708:		if (type === 'SERVICED_APARTMENT') return 'Ví dụ: Tầng 1, Tầng 2';
roomio-web/src/routes/dashboard/rooms/+page.svelte:709:		if (type === 'DORM') return 'Ví dụ: Phòng nam, Phòng nữ';
roomio-web/src/routes/dashboard/rooms/+page.svelte:710:		if (type === 'WHOLE_UNIT') return 'Ví dụ: Masteri Thảo Điền, Nhà phố Quận 7';
roomio-web/src/routes/dashboard/rooms/+page.svelte:719:		quickPropertyRentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-web/src/routes/dashboard/rooms/+page.svelte:732:		if (quickPropertyRentalType === 'APARTMENT' && blocks.length === 0) {
roomio-web/src/routes/dashboard/rooms/+page.svelte:743:					rentalType: quickPropertyRentalType,
roomio-web/src/routes/dashboard/rooms/+page.svelte:773:		if (type === 'MOTEL') return 'Dãy';
roomio-web/src/routes/dashboard/rooms/+page.svelte:774:		if (type === 'SERVICED_APARTMENT') return 'Tầng / khu';
roomio-web/src/routes/dashboard/rooms/+page.svelte:775:		if (type === 'DORM') return 'Phòng / khu';
roomio-web/src/routes/dashboard/rooms/+page.svelte:776:		if (type === 'WHOLE_UNIT') return 'Cụm / dự án';
roomio-web/src/routes/dashboard/rooms/+page.svelte:782:		if (type === 'MOTEL') return 'Mã phòng';
roomio-web/src/routes/dashboard/rooms/+page.svelte:783:		if (type === 'DORM') return 'Mã giường / box';
roomio-web/src/routes/dashboard/rooms/+page.svelte:784:		if (type === 'WHOLE_UNIT') return 'Mã căn/nhà';
roomio-web/src/routes/dashboard/rooms/+page.svelte:829:		if (activeRentalType() === 'APARTMENT') {
roomio-web/src/routes/dashboard/rooms/+page.svelte:843:		if (activeRentalType() !== 'APARTMENT') return '';
roomio-web/src/routes/dashboard/rooms/+page.svelte:1308:						{:else if activeRentalType() === 'APARTMENT'}
roomio-web/src/routes/dashboard/rooms/+page.svelte:1414:							{#if activeRentalType() !== 'APARTMENT'}
roomio-web/src/routes/dashboard/rooms/+page.svelte:1470:						{#if activeRentalType() !== 'APARTMENT' && getActiveProperty() && getActiveProperty()!.blocks.length > 0}
roomio-web/src/routes/dashboard/rooms/+page.svelte:1603:							>{quickBlockLabel()}{quickPropertyRentalType === 'APARTMENT'
roomio-web/src/routes/dashboard/tenants/+page.svelte:21:			rentalType?: string;
roomio-web/src/routes/dashboard/tenants/+page.svelte:44:		rentalType: string;
roomio-web/src/routes/dashboard/tenants/+page.svelte:84:	let enabledRentalTypes = $state<string[]>(['APARTMENT']);
roomio-web/src/routes/dashboard/tenants/+page.svelte:141:	let quickPropertyRentalType = $state('APARTMENT');
roomio-web/src/routes/dashboard/tenants/+page.svelte:147:			value: 'APARTMENT',
roomio-web/src/routes/dashboard/tenants/+page.svelte:152:			value: 'MOTEL',
roomio-web/src/routes/dashboard/tenants/+page.svelte:156:		{ value: 'DORM', label: 'KTX / Sleepbox', lines: ['KTX', 'Sleepbox'] },
roomio-web/src/routes/dashboard/tenants/+page.svelte:158:			value: 'WHOLE_UNIT',
roomio-web/src/routes/dashboard/tenants/+page.svelte:175:			quickPropertyRentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-web/src/routes/dashboard/tenants/+page.svelte:184:		const parsed = (value || 'APARTMENT')
roomio-web/src/routes/dashboard/tenants/+page.svelte:188:		return parsed.length > 0 ? parsed : ['APARTMENT'];
roomio-web/src/routes/dashboard/tenants/+page.svelte:198:				quickPropertyRentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-web/src/routes/dashboard/tenants/+page.svelte:241:					rentalType: prop.rentalType ?? 'APARTMENT',
roomio-web/src/routes/dashboard/tenants/+page.svelte:269:										rentalType: prop.rentalType
roomio-web/src/routes/dashboard/tenants/+page.svelte:296:		return selectedQuickProperty()?.rentalType === 'APARTMENT';
roomio-web/src/routes/dashboard/tenants/+page.svelte:366:		if (room.property.rentalType === 'APARTMENT') {
roomio-web/src/routes/dashboard/tenants/+page.svelte:423:		if (type === 'COLIVING') return 'căn co-living';
roomio-web/src/routes/dashboard/tenants/+page.svelte:424:		if (type === 'MOTEL') return 'khu trọ';
roomio-web/src/routes/dashboard/tenants/+page.svelte:425:		if (type === 'SERVICED_APARTMENT') return 'tòa nhà căn hộ dịch vụ';
roomio-web/src/routes/dashboard/tenants/+page.svelte:426:		if (type === 'DORM') return 'khu KTX / sleepbox';
roomio-web/src/routes/dashboard/tenants/+page.svelte:427:		if (type === 'WHOLE_UNIT') return 'bất động sản nguyên căn';
roomio-web/src/routes/dashboard/tenants/+page.svelte:432:		if (type === 'COLIVING') return 'Phòng share';
roomio-web/src/routes/dashboard/tenants/+page.svelte:433:		if (type === 'MOTEL') return 'Dãy';
roomio-web/src/routes/dashboard/tenants/+page.svelte:434:		if (type === 'SERVICED_APARTMENT') return 'Tầng / khu';
roomio-web/src/routes/dashboard/tenants/+page.svelte:435:		if (type === 'DORM') return 'Phòng / khu';
roomio-web/src/routes/dashboard/tenants/+page.svelte:436:		if (type === 'WHOLE_UNIT') return 'Cụm / dự án';
roomio-web/src/routes/dashboard/tenants/+page.svelte:441:		if (type === 'COLIVING') return 'Ví dụ: Co-living Thảo Điền';
roomio-web/src/routes/dashboard/tenants/+page.svelte:442:		if (type === 'MOTEL') return 'Ví dụ: Khu trọ An Bình';
roomio-web/src/routes/dashboard/tenants/+page.svelte:443:		if (type === 'SERVICED_APARTMENT') return 'Ví dụ: CHDV Nguyễn Trãi';
roomio-web/src/routes/dashboard/tenants/+page.svelte:444:		if (type === 'DORM') return 'Ví dụ: Sleepbox Cầu Giấy';
roomio-web/src/routes/dashboard/tenants/+page.svelte:445:		if (type === 'WHOLE_UNIT') return 'Ví dụ: Căn A1205 Masteri / Nhà nguyên căn Bình Thạnh';
roomio-web/src/routes/dashboard/tenants/+page.svelte:450:		if (type === 'COLIVING') return 'Ví dụ: Phòng 1, Phòng 2';
roomio-web/src/routes/dashboard/tenants/+page.svelte:451:		if (type === 'MOTEL') return 'Ví dụ: Dãy A, Dãy B';
roomio-web/src/routes/dashboard/tenants/+page.svelte:452:		if (type === 'SERVICED_APARTMENT') return 'Ví dụ: Tầng 1, Tầng 2';
roomio-web/src/routes/dashboard/tenants/+page.svelte:453:		if (type === 'DORM') return 'Ví dụ: Phòng nam, Phòng nữ';
roomio-web/src/routes/dashboard/tenants/+page.svelte:454:		if (type === 'WHOLE_UNIT') return 'Ví dụ: Masteri Thảo Điền, Nhà phố Quận 7';
roomio-web/src/routes/dashboard/tenants/+page.svelte:463:		quickPropertyRentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-web/src/routes/dashboard/tenants/+page.svelte:476:		if (quickPropertyRentalType === 'APARTMENT' && blocks.length === 0) {
roomio-web/src/routes/dashboard/tenants/+page.svelte:487:					rentalType: quickPropertyRentalType,
roomio-web/src/routes/dashboard/tenants/+page.svelte:1452:											>{quickBlockLabel(selectedQuickProperty()?.rentalType)}</label
roomio-web/src/routes/dashboard/tenants/+page.svelte:1461:														selectedQuickProperty()?.rentalType
roomio-web/src/routes/dashboard/tenants/+page.svelte:1647:							>{quickBlockLabel()}{quickPropertyRentalType === 'APARTMENT' ? '' : ' (tùy chọn)'}</label
roomio-web/src/routes/dashboard/buildings/+page.svelte:7:		rentalTypeLabel,
roomio-web/src/routes/dashboard/buildings/+page.svelte:34:		rentalType: string;
roomio-web/src/routes/dashboard/buildings/+page.svelte:43:	let enabledRentalTypes = $state<string[]>(['APARTMENT']);
roomio-web/src/routes/dashboard/buildings/+page.svelte:54:	let rentalType = $state('APARTMENT');
roomio-web/src/routes/dashboard/buildings/+page.svelte:65:			rentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-web/src/routes/dashboard/buildings/+page.svelte:77:			if (!enabledRentalTypes.includes(rentalType)) {
roomio-web/src/routes/dashboard/buildings/+page.svelte:78:				rentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-web/src/routes/dashboard/buildings/+page.svelte:112:		if (rentalType === 'APARTMENT' && blocksArray.length === 0) {
roomio-web/src/routes/dashboard/buildings/+page.svelte:124:					rentalType,
roomio-web/src/routes/dashboard/buildings/+page.svelte:135:			toast.success(`Đã thêm ${propertyLabel(rentalType)} ${name} thành công`);
roomio-web/src/routes/dashboard/buildings/+page.svelte:142:			rentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-web/src/routes/dashboard/buildings/+page.svelte:258:								{rentalTypeLabel(prop.rentalType)} · {prop.shortName} · {prop.address}
roomio-web/src/routes/dashboard/buildings/+page.svelte:326:									{rentalTypeLabel(prop.rentalType)} · {prop.address}
roomio-web/src/routes/dashboard/buildings/+page.svelte:401:										onclick={() => (rentalType = option.value)}
roomio-web/src/routes/dashboard/buildings/+page.svelte:402:										class="rounded-[6px] border-2 border-black px-3 py-2 text-xs font-black transition-colors {rentalType ===
roomio-web/src/routes/dashboard/buildings/+page.svelte:417:								>Tên {propertyLabel(rentalType)}</label
roomio-web/src/routes/dashboard/buildings/+page.svelte:424:								placeholder={propertyNamePlaceholder(rentalType)}
roomio-web/src/routes/dashboard/buildings/+page.svelte:456:							>{blockLabel(rentalType)}{rentalType === 'APARTMENT' ? '' : ' (tùy chọn)'}</label
roomio-web/src/routes/dashboard/buildings/+page.svelte:462:							required={rentalType === 'APARTMENT'}
roomio-web/src/routes/dashboard/buildings/+page.svelte:463:							placeholder={blockPlaceholder(rentalType)}
roomio-web/src/routes/dashboard/buildings/+page.svelte:481:							<span class="modal-action-label">Thêm {propertyLabel(rentalType)}</span>
roomio-web/src/routes/dashboard/buildings/+page.svelte:513:						>Chi tiết {propertyLabel(selectedProperty.rentalType)}</span
roomio-web/src/routes/dashboard/buildings/+page.svelte:528:							{rentalTypeLabel(selectedProperty.rentalType)} · {selectedProperty.shortName}
roomio-web/src/routes/dashboard/buildings/+page.svelte:561:								{blockLabel(selectedProperty.rentalType)} ({selectedProperty.blocks.length})
roomio-web/src/lib/SubscriptionManagement.svelte:61:			value: 'APARTMENT',
roomio-web/src/lib/SubscriptionManagement.svelte:66:			value: 'MOTEL',
roomio-web/src/lib/SubscriptionManagement.svelte:70:		{ value: 'DORM', label: 'KTX / Sleepbox', lines: ['KTX', 'Sleepbox'] },
roomio-web/src/lib/SubscriptionManagement.svelte:72:			value: 'WHOLE_UNIT',
roomio-web/src/lib/SubscriptionManagement.svelte:79:		return type === 'APARTMENT' || type === 'COLIVING';
roomio-web/src/lib/SubscriptionManagement.svelte:268:	function rentalTypeLabel(type: string) {
roomio-web/src/lib/SubscriptionManagement.svelte:269:		if (type === 'COLIVING') return 'Share phòng chung cư / Co-living / Share phòng';
roomio-web/src/lib/SubscriptionManagement.svelte:270:		if (type === 'SERVICED_APARTMENT') return 'Phòng trọ truyền thống / Căn hộ dịch vụ';
roomio-web/src/lib/SubscriptionManagement.svelte:280:				.map(([type, count]) => ({ type, label: rentalTypeLabel(type), count: Number(count) }));
roomio-web/src/lib/SubscriptionManagement.svelte:337:								{rentalTypeLabel(type)}
roomio-web/src/lib/SubscriptionManagement.svelte:531:											.map(rentalTypeLabel)
roomio-web/src/lib/rental-types.ts:3:		value: 'APARTMENT',
roomio-web/src/lib/rental-types.ts:8:		value: 'MOTEL',
roomio-web/src/lib/rental-types.ts:12:	{ value: 'DORM', label: 'KTX / Sleepbox', lines: ['KTX', 'Sleepbox'] },
roomio-web/src/lib/rental-types.ts:14:		value: 'WHOLE_UNIT',
roomio-web/src/lib/rental-types.ts:44:	APARTMENT: 'Co-living',
roomio-web/src/lib/rental-types.ts:45:	COLIVING: 'Co-living',
roomio-web/src/lib/rental-types.ts:46:	MOTEL: 'Trọ / CHDV',
roomio-web/src/lib/rental-types.ts:47:	SERVICED_APARTMENT: 'Trọ / CHDV',
roomio-web/src/lib/rental-types.ts:48:	DORM: 'KTX / Sleepbox',
roomio-web/src/lib/rental-types.ts:49:	WHOLE_UNIT: 'Nguyên căn'
roomio-web/src/lib/rental-types.ts:61:	if (normalized === 'COLIVING') return 'APARTMENT';
roomio-web/src/lib/rental-types.ts:62:	if (normalized === 'SERVICED_APARTMENT') return 'MOTEL';
roomio-web/src/lib/rental-types.ts:67:	const parsed = (value || 'APARTMENT')
roomio-web/src/lib/rental-types.ts:71:	return parsed.length > 0 ? [...new Set(parsed)] : ['APARTMENT'];
roomio-web/src/lib/rental-types.ts:74:export function rentalTypeLabel(type: string): string {
roomio-web/src/lib/rental-types.ts:79:export function rentalTypeShortLabel(type: string): string {
roomio-web/src/lib/rental-types.ts:84:export function propertyLabel(type = 'APARTMENT'): string {
roomio-web/src/lib/rental-types.ts:85:	if (type === 'COLIVING') return 'căn co-living';
roomio-web/src/lib/rental-types.ts:86:	if (type === 'MOTEL') return 'khu trọ';
roomio-web/src/lib/rental-types.ts:87:	if (type === 'SERVICED_APARTMENT') return 'tòa nhà căn hộ dịch vụ';
roomio-web/src/lib/rental-types.ts:88:	if (type === 'DORM') return 'khu KTX / sleepbox';
roomio-web/src/lib/rental-types.ts:89:	if (type === 'WHOLE_UNIT') return 'bất động sản nguyên căn';
roomio-web/src/lib/rental-types.ts:93:export function blockLabel(type = 'APARTMENT'): string {
roomio-web/src/lib/rental-types.ts:94:	if (type === 'COLIVING') return 'Phòng share';
roomio-web/src/lib/rental-types.ts:95:	if (type === 'MOTEL') return 'Dãy';
roomio-web/src/lib/rental-types.ts:96:	if (type === 'SERVICED_APARTMENT') return 'Tầng / khu';
roomio-web/src/lib/rental-types.ts:97:	if (type === 'DORM') return 'Phòng / khu';
roomio-web/src/lib/rental-types.ts:98:	if (type === 'WHOLE_UNIT') return 'Cụm / dự án';
roomio-web/src/lib/rental-types.ts:102:export function propertyNamePlaceholder(type = 'APARTMENT'): string {
roomio-web/src/lib/rental-types.ts:103:	if (type === 'COLIVING') return 'Ví dụ: Co-living Thảo Điền';
roomio-web/src/lib/rental-types.ts:104:	if (type === 'MOTEL') return 'Ví dụ: Khu trọ An Bình';
roomio-web/src/lib/rental-types.ts:105:	if (type === 'SERVICED_APARTMENT') return 'Ví dụ: CHDV Nguyễn Trãi';
roomio-web/src/lib/rental-types.ts:106:	if (type === 'DORM') return 'Ví dụ: Sleepbox Cầu Giấy';
roomio-web/src/lib/rental-types.ts:107:	if (type === 'WHOLE_UNIT') return 'Ví dụ: Căn A1205 Masteri / Nhà nguyên căn Bình Thạnh';
roomio-web/src/lib/rental-types.ts:111:export function blockPlaceholder(type = 'APARTMENT'): string {
roomio-web/src/lib/rental-types.ts:112:	if (type === 'COLIVING') return 'Ví dụ: Phòng 1, Phòng 2';
roomio-web/src/lib/rental-types.ts:113:	if (type === 'MOTEL') return 'Ví dụ: Dãy A, Dãy B, Dãy sau';
roomio-web/src/lib/rental-types.ts:114:	if (type === 'SERVICED_APARTMENT') return 'Ví dụ: Tầng 1, Tầng 2, Khu sau';
roomio-web/src/lib/rental-types.ts:115:	if (type === 'DORM') return 'Ví dụ: Phòng nam, Phòng nữ, Khu yên tĩnh';
roomio-web/src/lib/rental-types.ts:116:	if (type === 'WHOLE_UNIT') return 'Ví dụ: Masteri Thảo Điền, Nhà phố Quận 7';
roomio-web/src/lib/rental-types.ts:121:	if (canonicalRentalType(type) === 'WHOLE_UNIT') return 'căn / nhà';
roomio-web/src/lib/rental-types.ts:126:	return type === 'APARTMENT' || type === 'COLIVING';
roomio-web/src/lib/rental-types.ts:129:export function pricingGroupLabel(group: 'STANDARD' | 'COLIVING', short = false): string {
roomio-web/src/lib/rental-types.ts:138:export function operatingModelLabel(value: string | null | undefined, short = false): string {
roomio-web/src/routes/admin/+page.svelte:85:			rentalType: string;
roomio-web/src/routes/admin/+page.svelte:118:	let editRentalTypes = $state<string[]>(['APARTMENT']);
roomio-web/src/routes/admin/+page.svelte:136:		enabledRentalTypes: ['APARTMENT'],
roomio-web/src/routes/admin/+page.svelte:240:			value: 'APARTMENT',
roomio-web/src/routes/admin/+page.svelte:245:			value: 'MOTEL',
roomio-web/src/routes/admin/+page.svelte:249:		{ value: 'DORM', label: 'KTX / Sleepbox', lines: ['KTX', 'Sleepbox'] },
roomio-web/src/routes/admin/+page.svelte:251:			value: 'WHOLE_UNIT',
roomio-web/src/routes/admin/+page.svelte:278:	const COLIVING_TIER_PRICES: Record<string, number | null> = {
roomio-web/src/routes/admin/+page.svelte:290:		return type === 'APARTMENT' || type === 'COLIVING';
roomio-web/src/routes/admin/+page.svelte:293:	function selectedTierPrice(tier: string, rentalTypes: string[], period: 'MONTHLY' | 'YEARLY') {
roomio-web/src/routes/admin/+page.svelte:295:		const hasStandard = rentalTypes.some((type) => !isColivingPricingType(type));
roomio-web/src/routes/admin/+page.svelte:296:		const hasColiving = rentalTypes.some(isColivingPricingType);
roomio-web/src/routes/admin/+page.svelte:300:				? (COLIVING_TIER_PRICES[tier] ?? 0)
roomio-web/src/routes/admin/+page.svelte:307:		rentalTypes: string[],
roomio-web/src/routes/admin/+page.svelte:310:		const hasStandard = rentalTypes.some((type) => !isColivingPricingType(type));
roomio-web/src/routes/admin/+page.svelte:311:		const hasColiving = rentalTypes.some(isColivingPricingType);
roomio-web/src/routes/admin/+page.svelte:315:		const price = selectedTierPrice(tier, rentalTypes, period);
roomio-web/src/routes/admin/+page.svelte:509:			enabledRentalTypes: ['APARTMENT'],
roomio-web/src/routes/admin/+page.svelte:663:		const parsed = (value || 'APARTMENT')
roomio-web/src/routes/admin/+page.svelte:667:				if (normalized === 'COLIVING') return 'APARTMENT';
roomio-web/src/routes/admin/+page.svelte:668:				if (normalized === 'SERVICED_APARTMENT') return 'MOTEL';
roomio-web/src/routes/admin/+page.svelte:672:		return parsed.length > 0 ? [...new Set(parsed)] : ['APARTMENT'];
roomio-web/src/routes/admin/+page.svelte:675:	function rentalTypesLabel(value: string | null | undefined) {
roomio-web/src/routes/admin/+page.svelte:707:	function updateEditRoomLimit(group: 'STANDARD' | 'COLIVING', rawValue: string) {
roomio-web/src/routes/admin/+page.svelte:733:	function updateCreateRoomLimit(group: 'STANDARD' | 'COLIVING', rawValue: string) {
roomio-web/src/routes/admin/+page.svelte:1029:																Thêm loại hình: {rentalTypesLabel(request.requestedRentalTypes)}
roomio-web/src/routes/admin/+page.svelte:1110:												>{rentalTypesLabel(selectedLandlord.enabledRentalTypes)}</span
roomio-web/src/routes/admin/+page.svelte:1367:										onchange={(event) => updateEditRoomLimit('COLIVING', event.currentTarget.value)}
roomio-web/src/routes/admin/+page.svelte:1584:											updateCreateRoomLimit('COLIVING', event.currentTarget.value)}

### roomio-tma

roomio-tma/src/routes/super-admin/+page.svelte:9:		rentalTypeLabel
roomio-tma/src/routes/super-admin/+page.svelte:62:			rentalType: string;
roomio-tma/src/routes/super-admin/+page.svelte:78:	let editRentalTypes = $state<string[]>(['APARTMENT']);
roomio-tma/src/routes/super-admin/+page.svelte:92:		enabledRentalTypes: ['APARTMENT']
roomio-tma/src/routes/super-admin/+page.svelte:220:			enabledRentalTypes: ['APARTMENT']
roomio-tma/src/routes/super-admin/+page.svelte:337:	function rentalTypesLabel(value: string | null | undefined) {
roomio-tma/src/routes/super-admin/+page.svelte:340:			.map((option) => rentalTypeLabel(option.value))
roomio-tma/src/routes/super-admin/+page.svelte:593:											>{rentalTypesLabel(selectedLandlord.enabledRentalTypes)}</span
roomio-tma/src/routes/dashboard/rooms/+page.svelte:101:		rentalType: string;
roomio-tma/src/routes/dashboard/rooms/+page.svelte:467:		return canonicalRentalType(getActiveProperty()?.rentalType ?? 'APARTMENT');
roomio-tma/src/routes/dashboard/workspace/[propertyId]/+page.svelte:28:		rentalType: string;
roomio-tma/src/routes/dashboard/workspace/[propertyId]/+page.svelte:69:		APARTMENT: {
roomio-tma/src/routes/dashboard/workspace/[propertyId]/+page.svelte:82:		MOTEL: {
roomio-tma/src/routes/dashboard/workspace/[propertyId]/+page.svelte:95:		SERVICED_APARTMENT: {
roomio-tma/src/routes/dashboard/workspace/[propertyId]/+page.svelte:108:		DORM: {
roomio-tma/src/routes/dashboard/workspace/[propertyId]/+page.svelte:162:		return WORKSPACE_META[property?.rentalType ?? 'APARTMENT'] ?? WORKSPACE_META.APARTMENT;
roomio-tma/src/routes/dashboard/buildings/+page.svelte:13:		rentalTypeLabel
roomio-tma/src/routes/dashboard/buildings/+page.svelte:35:		rentalType: string;
roomio-tma/src/routes/dashboard/buildings/+page.svelte:44:	let enabledRentalTypes = $state<string[]>(['APARTMENT']);
roomio-tma/src/routes/dashboard/buildings/+page.svelte:55:	let rentalType = $state('APARTMENT');
roomio-tma/src/routes/dashboard/buildings/+page.svelte:66:			rentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-tma/src/routes/dashboard/buildings/+page.svelte:78:			if (!enabledRentalTypes.includes(rentalType)) {
roomio-tma/src/routes/dashboard/buildings/+page.svelte:79:				rentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-tma/src/routes/dashboard/buildings/+page.svelte:113:		if (isApartmentRentalType(rentalType) && blocksArray.length === 0) {
roomio-tma/src/routes/dashboard/buildings/+page.svelte:125:					rentalType,
roomio-tma/src/routes/dashboard/buildings/+page.svelte:136:			toast.success(`Đã thêm ${propertyLabel(rentalType)} ${name} thành công`);
roomio-tma/src/routes/dashboard/buildings/+page.svelte:143:			rentalType = enabledRentalTypes[0] ?? 'APARTMENT';
roomio-tma/src/routes/dashboard/buildings/+page.svelte:266:								{rentalTypeLabel(prop.rentalType)} · {prop.shortName} · {prop.address}
roomio-tma/src/routes/dashboard/buildings/+page.svelte:334:									{rentalTypeLabel(prop.rentalType)} · {prop.address}
roomio-tma/src/routes/dashboard/buildings/+page.svelte:414:										onclick={() => (rentalType = option.value)}
roomio-tma/src/routes/dashboard/buildings/+page.svelte:415:										class="rounded-[6px] border-2 border-black px-3 py-2 text-xs font-black transition-colors {rentalType ===
roomio-tma/src/routes/dashboard/buildings/+page.svelte:430:								>Tên {propertyLabel(rentalType)}</label
roomio-tma/src/routes/dashboard/buildings/+page.svelte:437:								placeholder={propertyNamePlaceholder(rentalType)}
roomio-tma/src/routes/dashboard/buildings/+page.svelte:469:							>{blockLabel(rentalType)}{isApartmentRentalType(rentalType) ? '' : ' (tùy chọn)'}</label
roomio-tma/src/routes/dashboard/buildings/+page.svelte:475:							required={isApartmentRentalType(rentalType)}
roomio-tma/src/routes/dashboard/buildings/+page.svelte:476:							placeholder={blockPlaceholder(rentalType)}
roomio-tma/src/routes/dashboard/buildings/+page.svelte:494:							Thêm {propertyLabel(rentalType)}
roomio-tma/src/routes/dashboard/buildings/+page.svelte:531:						>Chi tiết {propertyLabel(selectedProperty.rentalType)}</span
roomio-tma/src/routes/dashboard/buildings/+page.svelte:548:								{rentalTypeLabel(selectedProperty.rentalType)} · Mã viết tắt: {selectedProperty.shortName}
roomio-tma/src/routes/dashboard/buildings/+page.svelte:589:								{blockLabel(selectedProperty.rentalType)} ({selectedProperty.blocks.length})
roomio-tma/src/lib/rental-types.ts:1:export const RENTAL_TYPES = ['APARTMENT', 'MOTEL', 'DORM', 'WHOLE_UNIT'] as const;
roomio-tma/src/lib/rental-types.ts:5:	COLIVING: 'APARTMENT',
roomio-tma/src/lib/rental-types.ts:6:	SERVICED_APARTMENT: 'MOTEL'
roomio-tma/src/lib/rental-types.ts:26:		value: 'APARTMENT',
roomio-tma/src/lib/rental-types.ts:31:		value: 'MOTEL',
roomio-tma/src/lib/rental-types.ts:35:	{ value: 'DORM', label: 'KTX / Sleepbox', lines: ['KTX', 'Sleepbox'] },
roomio-tma/src/lib/rental-types.ts:37:		value: 'WHOLE_UNIT',
roomio-tma/src/lib/rental-types.ts:44:	APARTMENT: 'Share phòng chung cư / Co-living',
roomio-tma/src/lib/rental-types.ts:45:	MOTEL: 'Phòng trọ truyền thống / Căn hộ dịch vụ',
roomio-tma/src/lib/rental-types.ts:46:	DORM: 'KTX / Sleepbox',
roomio-tma/src/lib/rental-types.ts:47:	WHOLE_UNIT: 'Căn hộ chung cư nguyên căn / Nhà nguyên căn'
roomio-tma/src/lib/rental-types.ts:51:	APARTMENT: 'Co-living',
roomio-tma/src/lib/rental-types.ts:52:	MOTEL: 'Trọ / CHDV',
roomio-tma/src/lib/rental-types.ts:53:	DORM: 'KTX / Sleepbox',
roomio-tma/src/lib/rental-types.ts:54:	WHOLE_UNIT: 'Nguyên căn'
roomio-tma/src/lib/rental-types.ts:59:	return isValidRentalType(canonical) ? canonical : 'APARTMENT';
roomio-tma/src/lib/rental-types.ts:62:export function rentalTypeLabel(type: string): string {
roomio-tma/src/lib/rental-types.ts:67:export function rentalTypeShortLabel(type: string): string {
roomio-tma/src/lib/rental-types.ts:74:	if (resolved === 'MOTEL') return 'khu trọ';
roomio-tma/src/lib/rental-types.ts:75:	if (resolved === 'DORM') return 'khu KTX / sleepbox';
roomio-tma/src/lib/rental-types.ts:76:	if (resolved === 'WHOLE_UNIT') return 'bất động sản nguyên căn';
roomio-tma/src/lib/rental-types.ts:81:	return rentalTypeShortLabel(type);
roomio-tma/src/lib/rental-types.ts:86:	if (resolved === 'MOTEL') return 'Dãy';
roomio-tma/src/lib/rental-types.ts:87:	if (resolved === 'DORM') return 'Phòng / khu';
roomio-tma/src/lib/rental-types.ts:88:	if (resolved === 'WHOLE_UNIT') return 'Cụm / dự án';
roomio-tma/src/lib/rental-types.ts:94:	if (resolved === 'MOTEL') return 'Ví dụ: Khu trọ An Bình';
roomio-tma/src/lib/rental-types.ts:95:	if (resolved === 'DORM') return 'Ví dụ: Sleepbox Cầu Giấy';
roomio-tma/src/lib/rental-types.ts:96:	if (resolved === 'WHOLE_UNIT') return 'Ví dụ: Căn A1205 Masteri / Nhà nguyên căn Bình Thạnh';
roomio-tma/src/lib/rental-types.ts:102:	if (resolved === 'MOTEL') return 'Ví dụ: Dãy A, Dãy B, Dãy sau';
roomio-tma/src/lib/rental-types.ts:103:	if (resolved === 'DORM') return 'Ví dụ: Phòng nam, Phòng nữ, Khu yên tĩnh';
roomio-tma/src/lib/rental-types.ts:104:	if (resolved === 'WHOLE_UNIT') return 'Ví dụ: Masteri Thảo Điền, Nhà phố Quận 7';
roomio-tma/src/lib/rental-types.ts:110:	if (resolved === 'MOTEL') return 'Mã phòng';
roomio-tma/src/lib/rental-types.ts:111:	if (resolved === 'DORM') return 'Mã giường / box';
roomio-tma/src/lib/rental-types.ts:112:	if (resolved === 'WHOLE_UNIT') return 'Mã căn/nhà';
roomio-tma/src/lib/rental-types.ts:118:	if (resolved === 'WHOLE_UNIT') return 'căn / nhà';
roomio-tma/src/lib/rental-types.ts:123:	const parsed = (value || 'APARTMENT')
roomio-tma/src/lib/rental-types.ts:128:	return deduped.length > 0 ? deduped : ['APARTMENT'];
roomio-tma/src/lib/rental-types.ts:133:	return resolved === 'APARTMENT';
roomio-tma/src/lib/rental-types.ts:137:	return resolveRentalType(type) === 'APARTMENT';
