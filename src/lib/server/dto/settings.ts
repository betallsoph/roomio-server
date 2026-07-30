function toIso(value: Date | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return value instanceof Date ? value.toISOString() : value;
}

export type SettingsUserDto = {
	name: string;
	email: string;
	phone: string;
};

export type SettingsDto = {
	id: string;
	companyName: string | null;
	bankName: string;
	bankCode: string;
	accountNumber: string;
	accountName: string;
	bankBranch: string;
	momoNumber: string | null;
	payosClientId: string | null;
	payosConnected: boolean;
	payosConnectedAt: string | null;
	user: SettingsUserDto;
};

export type SettingsRowForDto = {
	id: string;
	companyName: string | null;
	bankName: string;
	bankCode: string;
	accountNumber: string;
	accountName: string;
	bankBranch: string;
	momoNumber: string | null;
	payosClientId: string | null;
	payosApiKeyEnc?: string | null;
	payosChecksumKeyEnc?: string | null;
	payosConnectedAt: Date | string | null;
	user: { name: string; email: string | null; phone: string | null };
};

/** Writable landlord profile fields — unknown keys are ignored at route boundary. */
export const SETTINGS_WRITE_FIELDS = [
	'companyName',
	'bankName',
	'bankCode',
	'accountNumber',
	'accountName',
	'bankBranch',
	'momoNumber',
	'payosClientId',
	'payosApiKey',
	'payosChecksumKey'
] as const;

export type SettingsWriteInput = Partial<{
	companyName: string;
	bankName: string;
	bankCode: string;
	accountNumber: string;
	accountName: string;
	bankBranch: string;
	momoNumber: string | null;
	payosClientId: string | null;
	payosApiKey: string;
	payosChecksumKey: string;
}>;

export function pickSettingsWriteInput(body: Record<string, unknown>): SettingsWriteInput {
	const picked: SettingsWriteInput = {};
	for (const key of SETTINGS_WRITE_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(body, key)) {
			(picked as Record<string, unknown>)[key] = body[key];
		}
	}
	return picked;
}

export function toSettingsDto(row: SettingsRowForDto): SettingsDto {
	const payosConnected = !!(row.payosClientId && row.payosApiKeyEnc && row.payosChecksumKeyEnc);
	return {
		id: row.id,
		companyName: row.companyName,
		bankName: row.bankName,
		bankCode: row.bankCode,
		accountNumber: row.accountNumber,
		accountName: row.accountName,
		bankBranch: row.bankBranch,
		momoNumber: row.momoNumber,
		payosClientId: row.payosClientId,
		payosConnected,
		payosConnectedAt: toIso(row.payosConnectedAt),
		user: {
			name: row.user.name,
			email: row.user.email ?? '',
			phone: row.user.phone ?? ''
		}
	};
}
