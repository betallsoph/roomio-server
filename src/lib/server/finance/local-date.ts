/** Civil calendar date in Asia/Ho_Chi_Minh as YYYY-MM-DD (timezone-independent string). */
export type LocalDate = string & { readonly __brand: 'LocalDate' };

/** Billing month as YYYY-MM (civil calendar, no timezone conversion). */
export type BillingMonth = string & { readonly __brand: 'BillingMonth' };

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BILLING_MONTH_RE = /^(\d{4})-(\d{2})$/;

export class LocalDateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LocalDateError';
	}
}

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in a civil month (month is 1–12). Leap-year aware for February. */
export function daysInMonth(year: number, month: number): number {
	if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
		throw new LocalDateError(`invalid year/month: ${year}-${month}`);
	}

	const daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (month === 2 && isLeapYear(year)) {
		return 29;
	}
	return daysPerMonth[month - 1]!;
}

function parseDateComponents(input: string): { year: number; month: number; day: number } {
	const match = LOCAL_DATE_RE.exec(input);
	if (!match) {
		throw new LocalDateError(`invalid local date format: ${input}`);
	}

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);

	if (month < 1 || month > 12) {
		throw new LocalDateError(`invalid month: ${input}`);
	}

	const maxDay = daysInMonth(year, month);
	if (day < 1 || day > maxDay) {
		throw new LocalDateError(`invalid day for calendar date: ${input}`);
	}

	return { year, month, day };
}

function toPadded(value: number, width: number): string {
	return String(value).padStart(width, '0');
}

/** Format validated Y/M/D components as a LocalDate string. */
export function formatLocalDate(year: number, month: number, day: number): LocalDate {
	const maxDay = daysInMonth(year, month);
	if (month < 1 || month > 12 || day < 1 || day > maxDay) {
		throw new LocalDateError(`invalid calendar date: ${year}-${month}-${day}`);
	}
	return `${toPadded(year, 4)}-${toPadded(month, 2)}-${toPadded(day, 2)}` as LocalDate;
}

/** Parse strict YYYY-MM-DD; validates real calendar days. */
export function parseLocalDate(input: string): LocalDate {
	parseDateComponents(input);
	return input as LocalDate;
}

function parseBillingMonthComponents(input: string): { year: number; month: number } {
	const match = BILLING_MONTH_RE.exec(input);
	if (!match) {
		throw new LocalDateError(`invalid billing month format: ${input}`);
	}

	const year = Number(match[1]);
	const month = Number(match[2]);

	if (month < 1 || month > 12) {
		throw new LocalDateError(`invalid billing month: ${input}`);
	}

	return { year, month };
}

/** Format validated year/month as YYYY-MM. */
export function formatBillingMonth(year: number, month: number): BillingMonth {
	if (month < 1 || month > 12) {
		throw new LocalDateError(`invalid billing month: ${year}-${month}`);
	}
	return `${toPadded(year, 4)}-${toPadded(month, 2)}` as BillingMonth;
}

/** Parse strict YYYY-MM billing month. */
export function parseBillingMonth(input: string): BillingMonth {
	parseBillingMonthComponents(input);
	return input as BillingMonth;
}

/** Absolute day index for civil date arithmetic (no Date/timezone). */
function absoluteDayIndex(year: number, month: number, day: number): number {
	let y = year - 1;
	let days = y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);

	for (let m = 1; m < month; m++) {
		days += daysInMonth(year, m);
	}

	return days + day;
}

/**
 * Billable days in the half-open interval [startDate, endDate).
 * Checkout day (endDate) is not billed. Returns 0 when endDate <= startDate.
 */
export function billableDays(startDate: LocalDate, endDate: LocalDate): number {
	const start = parseDateComponents(startDate);
	const end = parseDateComponents(endDate);

	const startIndex = absoluteDayIndex(start.year, start.month, start.day);
	const endIndex = absoluteDayIndex(end.year, end.month, end.day);

	if (endIndex <= startIndex) {
		return 0;
	}

	return endIndex - startIndex;
}
