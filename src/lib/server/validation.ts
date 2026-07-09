export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ValidationError';
	}
}

export function requiredString(value: unknown, field: string, max = 255): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new ValidationError(`Thiếu ${field}`);
	}
	const trimmed = value.trim();
	if (trimmed.length > max) {
		throw new ValidationError(`${field} quá dài`);
	}
	return trimmed;
}

export function optionalString(value: unknown, field: string, max = 255): string | null {
	if (value === undefined || value === null || value === '') return null;
	return requiredString(value, field, max);
}

export function requiredNumber(value: unknown, field: string, min = 0): number {
	const numberValue = Number(value);
	if (!Number.isFinite(numberValue) || numberValue < min) {
		throw new ValidationError(`${field} không hợp lệ`);
	}
	return numberValue;
}

export function requiredEnum<T extends string>(
	value: unknown,
	field: string,
	allowed: readonly T[]
): T {
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		throw new ValidationError(`${field} không hợp lệ`);
	}
	return value as T;
}

export function requiredMonth(value: unknown, field = 'tháng'): string {
	const month = requiredString(value, field, 7);
	if (!/^\d{4}-\d{2}$/.test(month)) {
		throw new ValidationError(`${field} phải có định dạng YYYY-MM`);
	}
	return month;
}

export function requiredDate(value: unknown, field = 'ngày'): string {
	const date = requiredString(value, field, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new ValidationError(`${field} phải có định dạng YYYY-MM-DD`);
	}
	return date;
}

export function requiredEmail(value: unknown): string {
	const email = requiredString(value, 'email', 254).toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new ValidationError('Email không hợp lệ');
	}
	return email;
}

export function requiredPhone(value: unknown): string {
	const phone = requiredString(value, 'số điện thoại', 20);
	if (!/^[0-9+\-\s.()]{8,20}$/.test(phone)) {
		throw new ValidationError('Số điện thoại không hợp lệ');
	}
	if (phone.replace(/\D/g, '').length < 8) {
		throw new ValidationError('Số điện thoại không hợp lệ');
	}
	return phone;
}

export function phoneLookupDigits(value: unknown): string[] {
	const phone = requiredPhone(value);
	const digits = phone.replace(/\D/g, '');
	const variants = new Set<string>([digits]);

	if (digits.startsWith('0084') && digits.length > 4) {
		const local = `0${digits.slice(4)}`;
		variants.add(`84${digits.slice(4)}`);
		variants.add(local);
	}

	if (digits.startsWith('84') && digits.length > 2) {
		variants.add(`0${digits.slice(2)}`);
		variants.add(`0084${digits.slice(2)}`);
	}

	if (digits.startsWith('0') && digits.length > 1) {
		variants.add(`84${digits.slice(1)}`);
		variants.add(`0084${digits.slice(1)}`);
	}

	return [...variants];
}
