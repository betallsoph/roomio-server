import assert from 'node:assert/strict';
import test from 'node:test';

const {
	MONEY_MAX_VND,
	MONEY_MIN_VND,
	MoneyError,
	checkedAdd,
	checkedSubtract,
	minMoney,
	parseMoneyVnd,
	roundHalfUpRatio,
	serializeMoneyVnd
} = await import('./money.js');

test('parseMoneyVnd accepts canonical values 0, 1, and max', () => {
	assert.equal(serializeMoneyVnd(parseMoneyVnd('0')), '0');
	assert.equal(serializeMoneyVnd(parseMoneyVnd('1')), '1');
	assert.equal(
		serializeMoneyVnd(parseMoneyVnd(MONEY_MAX_VND.toString())),
		MONEY_MAX_VND.toString()
	);
	assert.equal(MONEY_MIN_VND, 0n);
});

test('parseMoneyVnd rejects invalid formats', () => {
	const invalidInputs = ['', '+1', '01', '1.5', '1e6', '1,000', ' 1', '1 ', 'NaN', '--1'];

	for (const input of invalidInputs) {
		assert.throws(() => parseMoneyVnd(input), MoneyError, `expected reject: ${input}`);
	}
});

test('parseMoneyVnd enforces negative policy', () => {
	assert.throws(() => parseMoneyVnd('-1'), MoneyError);
	assert.throws(() => parseMoneyVnd('-0'), MoneyError);

	const negative = parseMoneyVnd('-1', { allowNegative: true });
	assert.equal(serializeMoneyVnd(negative), '-1');

	const negativeMax = parseMoneyVnd(`-${MONEY_MAX_VND}`, { allowNegative: true });
	assert.equal(negativeMax, -MONEY_MAX_VND);
});

test('parseMoneyVnd rejects out-of-range values', () => {
	const overMax = `${MONEY_MAX_VND}0`;
	assert.throws(
		() => parseMoneyVnd(overMax),
		(error: unknown) => {
			assert.ok(error instanceof MoneyError);
			assert.equal(error.code, 'MONEY_OUT_OF_RANGE');
			return true;
		}
	);

	assert.throws(
		() => parseMoneyVnd(`-${MONEY_MAX_VND}0`, { allowNegative: true }),
		(error: unknown) => {
			assert.ok(error instanceof MoneyError);
			assert.equal(error.code, 'MONEY_OUT_OF_RANGE');
			return true;
		}
	);
});

test('checkedAdd and checkedSubtract enforce bounds', () => {
	const one = parseMoneyVnd('1');
	const two = parseMoneyVnd('2');
	const max = parseMoneyVnd(MONEY_MAX_VND.toString());

	assert.equal(checkedAdd(one, two), 3n);
	assert.equal(checkedSubtract(two, one), 1n);

	assert.throws(
		() => checkedAdd(max, one),
		(error: unknown) => {
			assert.ok(error instanceof MoneyError);
			assert.equal(error.code, 'MONEY_OVERFLOW');
			return true;
		}
	);

	assert.throws(
		() => checkedSubtract(one, two),
		(error: unknown) => {
			assert.ok(error instanceof MoneyError);
			assert.equal(error.code, 'MONEY_UNDERFLOW');
			return true;
		}
	);
});

test('minMoney returns smallest value', () => {
	const a = parseMoneyVnd('100');
	const b = parseMoneyVnd('50');
	const c = parseMoneyVnd('75');

	assert.equal(minMoney(a, b, c), b);
	assert.throws(() => minMoney(), MoneyError);
});

test('roundHalfUpRatio rounds .4 down and .6 up for positive values', () => {
	const numerator = parseMoneyVnd('10');

	assert.equal(roundHalfUpRatio(numerator, 44n, 100n), 4n);
	assert.equal(roundHalfUpRatio(numerator, 45n, 100n), 5n);
	assert.equal(roundHalfUpRatio(numerator, 46n, 100n), 5n);
});

test('roundHalfUpRatio rounds ties away from zero for negative values', () => {
	const numerator = parseMoneyVnd('-10', { allowNegative: true });

	assert.equal(roundHalfUpRatio(numerator, 44n, 100n), -4n);
	assert.equal(roundHalfUpRatio(numerator, 45n, 100n), -5n);
	assert.equal(roundHalfUpRatio(numerator, 46n, 100n), -5n);
});

test('roundHalfUpRatio rejects zero denominator', () => {
	const numerator = parseMoneyVnd('10');
	assert.throws(
		() => roundHalfUpRatio(numerator, 1n, 0n),
		(error: unknown) => {
			assert.ok(error instanceof MoneyError);
			assert.equal(error.code, 'MONEY_DIVISION_BY_ZERO');
			return true;
		}
	);
});
