/** Canonical VND amount bounds (bigint, no float arithmetic). */
export const MONEY_MIN_VND = 0n;
export const MONEY_MAX_VND = 9_000_000_000_000_000n;

export type MoneyVnd = bigint & { readonly __brand: 'MoneyVnd' };

export type MoneyErrorCode =
	| 'MONEY_INVALID_INPUT'
	| 'MONEY_OUT_OF_RANGE'
	| 'MONEY_OVERFLOW'
	| 'MONEY_UNDERFLOW'
	| 'MONEY_DIVISION_BY_ZERO';

export class MoneyError extends Error {
	readonly code: MoneyErrorCode;

	constructor(code: MoneyErrorCode, message: string) {
		super(message);
		this.name = 'MoneyError';
		this.code = code;
	}
}

const UNSIGNED_INTEGER_RE = /^(0|[1-9]\d*)$/;

function assertInRange(value: bigint): MoneyVnd {
	if (value < -MONEY_MAX_VND || value > MONEY_MAX_VND) {
		throw new MoneyError('MONEY_OUT_OF_RANGE', `amount out of range: ${value}`);
	}
	return value as MoneyVnd;
}

/** Serialize a MoneyVnd value to a plain integer digit string (no separators). */
export function serializeMoneyVnd(amount: MoneyVnd): string {
	return amount.toString();
}

/**
 * Parse a strict integer digit string into MoneyVnd.
 * No implicit trim; rejects whitespace, decimals, exponents, separators, leading '+', etc.
 */
export function parseMoneyVnd(input: string, opts?: { allowNegative?: boolean }): MoneyVnd {
	const allowNegative = opts?.allowNegative ?? false;

	if (input.length === 0) {
		throw new MoneyError('MONEY_INVALID_INPUT', 'empty input');
	}

	if (input.startsWith('+')) {
		throw new MoneyError('MONEY_INVALID_INPUT', 'leading plus sign is not allowed');
	}

	let negative = false;
	let digits: string;

	if (input.startsWith('-')) {
		if (!allowNegative) {
			throw new MoneyError('MONEY_INVALID_INPUT', 'negative amounts are not allowed');
		}
		negative = true;
		digits = input.slice(1);
		if (digits.length === 0) {
			throw new MoneyError('MONEY_INVALID_INPUT', 'invalid negative format');
		}
	} else {
		digits = input;
	}

	if (!UNSIGNED_INTEGER_RE.test(digits)) {
		throw new MoneyError('MONEY_INVALID_INPUT', `invalid money format: ${input}`);
	}

	if (negative && digits === '0') {
		throw new MoneyError('MONEY_INVALID_INPUT', 'negative zero is not allowed');
	}

	const value = BigInt(negative ? `-${digits}` : digits);

	if (!allowNegative && value < MONEY_MIN_VND) {
		throw new MoneyError('MONEY_INVALID_INPUT', 'negative amounts are not allowed');
	}

	return assertInRange(value);
}

/** Checked addition; throws on overflow above MAX or underflow below 0. */
export function checkedAdd(a: MoneyVnd, b: MoneyVnd): MoneyVnd {
	const result = a + b;
	if (result > MONEY_MAX_VND) {
		throw new MoneyError('MONEY_OVERFLOW', `addition overflow: ${a} + ${b}`);
	}
	if (result < MONEY_MIN_VND) {
		throw new MoneyError('MONEY_UNDERFLOW', `addition underflow: ${a} + ${b}`);
	}
	return result as MoneyVnd;
}

/** Checked subtraction; throws on overflow above MAX or underflow below 0. */
export function checkedSubtract(a: MoneyVnd, b: MoneyVnd): MoneyVnd {
	const result = a - b;
	if (result > MONEY_MAX_VND) {
		throw new MoneyError('MONEY_OVERFLOW', `subtraction overflow: ${a} - ${b}`);
	}
	if (result < MONEY_MIN_VND) {
		throw new MoneyError('MONEY_UNDERFLOW', `subtraction underflow: ${a} - ${b}`);
	}
	return result as MoneyVnd;
}

/** Return the smallest MoneyVnd among the given values. */
export function minMoney(...values: MoneyVnd[]): MoneyVnd {
	if (values.length === 0) {
		throw new MoneyError('MONEY_INVALID_INPUT', 'minMoney requires at least one value');
	}

	let min = values[0];
	for (let i = 1; i < values.length; i++) {
		if (values[i] < min) {
			min = values[i];
		}
	}
	return min;
}

/**
 * Round half up (away from zero on ties) for `numerator * numeratorFactor / denominator`.
 * Uses integer arithmetic only; denominator must be > 0.
 */
export function roundHalfUpRatio(
	numerator: MoneyVnd | bigint,
	numeratorFactor: bigint,
	denominator: bigint
): MoneyVnd {
	if (denominator <= 0n) {
		throw new MoneyError('MONEY_DIVISION_BY_ZERO', 'denominator must be greater than zero');
	}

	const product = numerator * numeratorFactor;
	const quotient = product / denominator;
	const remainder = product % denominator;

	if (remainder === 0n) {
		return assertInRange(quotient);
	}

	const absRemainder = remainder < 0n ? -remainder : remainder;
	const shouldRoundAway = absRemainder * 2n >= denominator;

	if (!shouldRoundAway) {
		return assertInRange(quotient);
	}

	const rounded = product >= 0n ? quotient + 1n : quotient - 1n;
	return assertInRange(rounded);
}
