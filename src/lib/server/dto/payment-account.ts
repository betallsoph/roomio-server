function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

export type PaymentAccountRowForDto = {
	id: string;
	landlordId: string;
	name: string;
	provider: string;
	isDefault: boolean;
	isActive: boolean;
	bankName: string;
	bankCode: string;
	accountNumber: string;
	accountName: string;
	bankBranch: string | null;
	momoNumber: string | null;
	payosClientId: string | null;
	payosApiKeyEnc?: string | null;
	payosChecksumKeyEnc?: string | null;
	payosConnectedAt: Date | string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
};

/** Public payment account fields — never expose payosApiKeyEnc or payosChecksumKeyEnc. */
export type PaymentAccountDto = {
	id: string;
	landlordId: string;
	name: string;
	provider: string;
	isDefault: boolean;
	isActive: boolean;
	bankName: string;
	bankCode: string;
	accountNumber: string;
	accountName: string;
	bankBranch: string | null;
	momoNumber: string | null;
	payosClientId: string | null;
	payosConnected: boolean;
	payosConnectedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export function toPaymentAccountDto(row: PaymentAccountRowForDto): PaymentAccountDto {
	const payosConnected = !!(
		row.payosClientId &&
		((row.payosApiKeyEnc && row.payosChecksumKeyEnc) || row.payosConnectedAt)
	);
	return {
		id: row.id,
		landlordId: row.landlordId,
		name: row.name,
		provider: row.provider,
		isDefault: row.isDefault,
		isActive: row.isActive,
		bankName: row.bankName,
		bankCode: row.bankCode,
		accountNumber: row.accountNumber,
		accountName: row.accountName,
		bankBranch: row.bankBranch,
		momoNumber: row.momoNumber,
		payosClientId: row.payosClientId,
		payosConnected,
		payosConnectedAt: row.payosConnectedAt ? toIso(row.payosConnectedAt) : null,
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt)
	};
}
