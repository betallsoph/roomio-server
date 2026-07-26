import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { landlordProfiles, paymentAccounts } from '$lib/server/db/schema';
import { isPayosConfigured } from './env';

export type PaymentAccountRow = typeof paymentAccounts.$inferSelect;

function hasConfiguredPayos(account: PaymentAccountRow): boolean {
	return !!(
		account.provider === 'payos' &&
		account.payosClientId &&
		account.payosApiKeyEnc &&
		account.payosChecksumKeyEnc
	);
}

function hasConfiguredBank(account: PaymentAccountRow): boolean {
	return !!(account.accountNumber?.trim() && account.accountName?.trim());
}

function configurationStatus(account: PaymentAccountRow): 'NOT_CONFIGURED' | 'ACTIVE' {
	if (hasConfiguredPayos(account) || hasConfiguredBank(account)) return 'ACTIVE';
	return 'NOT_CONFIGURED';
}

export function publicPaymentAccount(account: PaymentAccountRow) {
	const status = configurationStatus(account);
	const payosConnected = hasConfiguredPayos(account) && isPayosConfigured();
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
	accountNumber: string;
	accountName: string;
	payosClientId: string | null;
	payosApiKeyEnc: string | null;
	payosChecksumKeyEnc: string | null;
}) {
	const hasPayOS = !!(
		profile.payosClientId &&
		profile.payosApiKeyEnc &&
		profile.payosChecksumKeyEnc
	);
	const hasBank = !!(profile.accountNumber?.trim() && profile.accountName?.trim());
	return hasPayOS || hasBank;
}

export async function ensureDefaultPaymentAccount(landlordId: string) {
	const existingDefault = await db.query.paymentAccounts.findFirst({
		where: and(
			eq(paymentAccounts.landlordId, landlordId),
			eq(paymentAccounts.isDefault, true),
			eq(paymentAccounts.isActive, true)
		)
	});
	if (existingDefault) return existingDefault;

	const existingActive = await db.query.paymentAccounts.findFirst({
		where: and(eq(paymentAccounts.landlordId, landlordId), eq(paymentAccounts.isActive, true)),
		orderBy: [asc(paymentAccounts.createdAt)]
	});
	if (existingActive) {
		const updated = await db
			.update(paymentAccounts)
			.set({ isDefault: true })
			.where(eq(paymentAccounts.id, existingActive.id))
			.returning();
		return updated[0];
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
