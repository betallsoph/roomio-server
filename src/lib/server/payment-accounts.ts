import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { landlordProfiles, paymentAccounts } from '$lib/server/db/schema';
import { isPayosEncryptionConfigured } from './env';

export type PaymentAccountRow = typeof paymentAccounts.$inferSelect;
export type PaymentAccountConfiguration = Pick<
	PaymentAccountRow,
	| 'provider'
	| 'bankCode'
	| 'accountNumber'
	| 'accountName'
	| 'payosClientId'
	| 'payosApiKeyEnc'
	| 'payosChecksumKeyEnc'
>;

const LEGACY_PLACEHOLDER_ACCOUNT_NUMBERS = new Set(['1234567890']);

function hasConfiguredPayos(account: PaymentAccountConfiguration): boolean {
	return !!(
		account.provider === 'payos' &&
		account.payosClientId &&
		account.payosApiKeyEnc &&
		account.payosChecksumKeyEnc &&
		isPayosEncryptionConfigured()
	);
}

function hasConfiguredBank(account: PaymentAccountConfiguration): boolean {
	const accountNumber = account.accountNumber?.trim();
	return !!(
		accountNumber &&
		account.bankCode?.trim() &&
		account.accountName?.trim() &&
		!LEGACY_PLACEHOLDER_ACCOUNT_NUMBERS.has(accountNumber)
	);
}

export function paymentAccountConfigurationStatus(
	account: PaymentAccountConfiguration
): 'NOT_CONFIGURED' | 'ACTIVE' {
	if (hasConfiguredPayos(account) || hasConfiguredBank(account)) return 'ACTIVE';
	return 'NOT_CONFIGURED';
}

export function publicPaymentAccount(account: PaymentAccountRow) {
	const status = paymentAccountConfigurationStatus(account);
	const payosConnected = hasConfiguredPayos(account);
	return {
		id: account.id,
		landlordId: account.landlordId,
		name: account.name,
		provider: account.provider,
		isDefault: account.isDefault,
		isActive: account.isActive && status === 'ACTIVE',
		configurationStatus: status,
		bankName: account.bankName,
		bankCode: account.bankCode,
		accountNumber: account.accountNumber,
		accountName: account.accountName,
		bankBranch: account.bankBranch,
		momoNumber: account.momoNumber,
		payosClientId: account.payosClientId,
		payosConnected,
		payosConnectedAt: account.payosConnectedAt,
		createdAt: account.createdAt,
		updatedAt: account.updatedAt
	};
}

function accountNameFromProfile(profile: {
	companyName: string | null;
	accountNumber: string;
	accountName: string;
}) {
	const companyName = profile.companyName?.trim();
	if (companyName) return `${companyName} mặc định`;
	if (profile.accountName?.trim()) return profile.accountName.trim();
	if (profile.accountNumber?.trim()) return `Tài khoản ${profile.accountNumber.trim()}`;
	return 'Tài khoản mặc định';
}

function profileHasPaymentConfig(profile: {
	bankCode: string;
	accountNumber: string;
	accountName: string;
	payosClientId: string | null;
	payosApiKeyEnc: string | null;
	payosChecksumKeyEnc: string | null;
}) {
	const hasPayOS = !!(
		profile.payosClientId &&
		profile.payosApiKeyEnc &&
		profile.payosChecksumKeyEnc &&
		isPayosEncryptionConfigured()
	);
	const accountNumber = profile.accountNumber?.trim();
	const hasBank = !!(
		accountNumber &&
		profile.bankCode?.trim() &&
		profile.accountName?.trim() &&
		!LEGACY_PLACEHOLDER_ACCOUNT_NUMBERS.has(accountNumber)
	);
	return hasPayOS || hasBank;
}

export async function ensureDefaultPaymentAccount(landlordId: string) {
	const activeAccounts = await db.query.paymentAccounts.findMany({
		where: and(eq(paymentAccounts.landlordId, landlordId), eq(paymentAccounts.isActive, true)),
		orderBy: [desc(paymentAccounts.isDefault), asc(paymentAccounts.createdAt)]
	});
	const configuredAccount = activeAccounts.find(
		(account) => paymentAccountConfigurationStatus(account) === 'ACTIVE'
	);
	if (configuredAccount?.isDefault) return configuredAccount;
	if (configuredAccount) {
		return db.transaction(async (tx) => {
			await tx
				.update(paymentAccounts)
				.set({ isDefault: false })
				.where(eq(paymentAccounts.landlordId, landlordId));
			const updated = await tx
				.update(paymentAccounts)
				.set({ isDefault: true })
				.where(eq(paymentAccounts.id, configuredAccount.id))
				.returning();
			return updated[0];
		});
	}

	const profile = await db.query.landlordProfiles.findFirst({
		where: eq(landlordProfiles.id, landlordId),
		columns: {
			id: true,
			companyName: true,
			bankName: true,
			bankCode: true,
			accountNumber: true,
			accountName: true,
			bankBranch: true,
			momoNumber: true,
			payosClientId: true,
			payosApiKeyEnc: true,
			payosChecksumKeyEnc: true,
			payosConnectedAt: true
		}
	});
	if (!profile) throw new Error('Không tìm thấy hồ sơ chủ trọ');
	if (!profileHasPaymentConfig(profile)) {
		throw new Error('Chưa cấu hình tài khoản nhận tiền');
	}

	const hasPayOS = !!(
		profile.payosClientId &&
		profile.payosApiKeyEnc &&
		profile.payosChecksumKeyEnc
	);
	const created = await db
		.insert(paymentAccounts)
		.values({
			landlordId,
			name: accountNameFromProfile(profile),
			provider: hasPayOS ? 'payos' : 'vietqr',
			isDefault: true,
			isActive: true,
			bankName: profile.bankName,
			bankCode: profile.bankCode,
			accountNumber: profile.accountNumber,
			accountName: profile.accountName,
			bankBranch: profile.bankBranch,
			momoNumber: profile.momoNumber,
			payosClientId: profile.payosClientId,
			payosApiKeyEnc: profile.payosApiKeyEnc,
			payosChecksumKeyEnc: profile.payosChecksumKeyEnc,
			payosConnectedAt: profile.payosConnectedAt
		})
		.returning();
	return created[0];
}

export async function listPaymentAccounts(landlordId: string) {
	return db.query.paymentAccounts.findMany({
		where: and(eq(paymentAccounts.landlordId, landlordId), eq(paymentAccounts.isActive, true)),
		orderBy: [desc(paymentAccounts.isDefault), asc(paymentAccounts.createdAt)]
	});
}

export async function getPaymentAccountForLandlord(
	landlordId: string,
	paymentAccountId?: string | null
) {
	if (paymentAccountId) {
		const account = await db.query.paymentAccounts.findFirst({
			where: and(
				eq(paymentAccounts.id, paymentAccountId),
				eq(paymentAccounts.landlordId, landlordId)
			)
		});
		if (!account) throw new Error('Tài khoản nhận tiền không thuộc chủ trọ này');
		if (!account.isActive || paymentAccountConfigurationStatus(account) !== 'ACTIVE') {
			throw new Error('Tài khoản nhận tiền chưa được cấu hình hoặc đã tắt');
		}
		return account;
	}
	const account = await ensureDefaultPaymentAccount(landlordId);
	return account;
}

export async function setDefaultPaymentAccount(landlordId: string, paymentAccountId: string) {
	const account = await getPaymentAccountForLandlord(landlordId, paymentAccountId);
	if (!account.isActive) throw new Error('Không thể đặt mặc định tài khoản đã tắt');
	await db.transaction(async (tx) => {
		await tx
			.update(paymentAccounts)
			.set({ isDefault: false })
			.where(eq(paymentAccounts.landlordId, landlordId));
		await tx
			.update(paymentAccounts)
			.set({ isDefault: true })
			.where(eq(paymentAccounts.id, paymentAccountId));
	});
	return getPaymentAccountForLandlord(landlordId, paymentAccountId);
}
