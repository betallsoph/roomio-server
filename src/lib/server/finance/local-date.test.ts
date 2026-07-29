import assert from 'node:assert/strict';
import test from 'node:test';

const {
	billableDays,
	daysInMonth,
	formatBillingMonth,
	formatLocalDate,
	parseBillingMonth,
	parseLocalDate
} = await import('./local-date.js');

test('daysInMonth handles 28/29/30/31-day months', () => {
	assert.equal(daysInMonth(2023, 2), 28);
	assert.equal(daysInMonth(2024, 2), 29);
	assert.equal(daysInMonth(2023, 4), 30);
	assert.equal(daysInMonth(2023, 1), 31);
	assert.equal(daysInMonth(2023, 12), 31);
});

test('parseLocalDate rejects invalid calendar days', () => {
	assert.throws(() => parseLocalDate('2023-02-29'));
	assert.throws(() => parseLocalDate('2023-00-10'));
	assert.throws(() => parseLocalDate('2023-13-01'));
	assert.throws(() => parseLocalDate('2023-01-00'));
	assert.throws(() => parseLocalDate('2023-04-31'));
});

test('parseLocalDate and formatLocalDate round-trip leap and non-leap February', () => {
	assert.equal(parseLocalDate('2024-02-29'), '2024-02-29');
	assert.equal(formatLocalDate(2024, 2, 29), '2024-02-29');
	assert.throws(() => formatLocalDate(2023, 2, 29));
});

test('parseBillingMonth and formatBillingMonth are strict YYYY-MM', () => {
	assert.equal(parseBillingMonth('2024-01'), '2024-01');
	assert.equal(formatBillingMonth(2024, 1), '2024-01');
	assert.throws(() => parseBillingMonth('2024-13'));
	assert.throws(() => parseBillingMonth('2024-1'));
	assert.throws(() => parseBillingMonth('2024-01-01'));
});

test('billableDays uses half-open interval and checkout day is not billed', () => {
	const start = parseLocalDate('2024-01-01');
	const end = parseLocalDate('2024-01-31');

	assert.equal(billableDays(start, end), 30);
	assert.equal(billableDays(start, start), 0);
	assert.equal(billableDays(end, start), 0);
});

test('billableDays handles month boundaries and ranges crossing New Year', () => {
	const jan31 = parseLocalDate('2023-01-31');
	const feb01 = parseLocalDate('2023-02-01');
	const dec31 = parseLocalDate('2023-12-31');
	const jan01Next = parseLocalDate('2024-01-01');

	assert.equal(billableDays(jan31, feb01), 1);
	assert.equal(billableDays(dec31, jan01Next), 1);
	assert.equal(billableDays(parseLocalDate('2023-12-15'), jan01Next), 17);
});

const TIMEZONES = ['UTC', 'America/New_York', 'Pacific/Auckland'] as const;

for (const timeZone of TIMEZONES) {
	test(`local-date helpers are timezone-independent (${timeZone})`, () => {
		const previousTz = process.env.TZ;
		process.env.TZ = timeZone;

		try {
			assert.equal(daysInMonth(2024, 2), 29);
			assert.equal(parseLocalDate('2024-02-29'), '2024-02-29');
			assert.equal(formatBillingMonth(2024, 2), '2024-02');

			const start = parseLocalDate('2024-01-15');
			const end = parseLocalDate('2024-02-01');
			assert.equal(billableDays(start, end), 17);
		} finally {
			if (previousTz === undefined) {
				delete process.env.TZ;
			} else {
				process.env.TZ = previousTz;
			}
		}
	});
}
