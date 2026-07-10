import crypto from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const DEFAULT_EXPIRES_SECONDS = 5 * 60;

const EXT_BY_TYPE: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'application/pdf': 'pdf'
};

const PURPOSE_PREFIX: Record<string, string> = {
	'meter-reading': 'meters',
	'maintenance-request': 'maintenance',
	'tenant-document': 'tenant-documents',
	'payment-proof': 'payment-proofs',
	contract: 'contracts',
	'room-asset': 'room-assets'
};

export const R2_UPLOAD_PURPOSES = Object.keys(PURPOSE_PREFIX);

interface R2Config {
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
	publicBaseUrl: string;
	maxUploadBytes: number;
	expiresIn: number;
}

interface CreatePresignedUploadInput {
	purpose: string;
	contentType: string;
	byteSize: number;
	actorId: string;
	actorRole: string;
}

interface UploadR2ObjectInput extends CreatePresignedUploadInput {
	body: Uint8Array;
}

let cachedClient: S3Client | null = null;

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Thiếu biến môi trường ${name}`);
	return value;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeAccountId(value: string): string {
	if (!/^[a-f0-9]{32}$/i.test(value)) {
		throw new Error('R2_ACCOUNT_ID không hợp lệ; chỉ nhập Account ID, không nhập URL endpoint');
	}
	return value;
}

function normalizePublicBaseUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
		return url.toString().replace(/\/+$/, '');
	} catch {
		throw new Error('R2_PUBLIC_BASE_URL phải là URL http/https hợp lệ');
	}
}

function r2Config(): R2Config {
	return {
		accountId: normalizeAccountId(requiredEnv('R2_ACCOUNT_ID')),
		accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
		secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
		bucket: requiredEnv('R2_BUCKET'),
		publicBaseUrl: normalizePublicBaseUrl(requiredEnv('R2_PUBLIC_BASE_URL')),
		maxUploadBytes: parsePositiveInt(process.env.R2_UPLOAD_MAX_BYTES, DEFAULT_MAX_UPLOAD_BYTES),
		expiresIn: Math.min(
			parsePositiveInt(process.env.R2_PRESIGN_EXPIRES_SECONDS, DEFAULT_EXPIRES_SECONDS),
			60 * 60
		)
	};
}

function r2Client(config: R2Config): S3Client {
	if (!cachedClient) {
		cachedClient = new S3Client({
			region: 'auto',
			endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
			requestChecksumCalculation: 'WHEN_REQUIRED',
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey
			}
		});
	}
	return cachedClient;
}

function normalizePurpose(value: unknown): string {
	const purpose = typeof value === 'string' ? value.trim() : '';
	if (!PURPOSE_PREFIX[purpose]) {
		throw new Error(`Loại upload không hợp lệ. Hỗ trợ: ${R2_UPLOAD_PURPOSES.join(', ')}`);
	}
	return purpose;
}

function normalizeContentType(value: unknown): string {
	const contentType = typeof value === 'string' ? value.trim().toLowerCase() : '';
	if (!EXT_BY_TYPE[contentType]) {
		throw new Error('Chỉ chấp nhận ảnh JPEG, PNG, WebP hoặc file PDF');
	}
	return contentType;
}

function createObjectKey(
	purpose: string,
	actorRole: string,
	actorId: string,
	contentType: string
): string {
	const now = new Date();
	const year = now.getUTCFullYear();
	const month = String(now.getUTCMonth() + 1).padStart(2, '0');
	const ext = EXT_BY_TYPE[contentType];
	const safeRole = actorRole.toLowerCase().replace(/[^a-z0-9-]/g, '-');

	return [
		'uploads',
		PURPOSE_PREFIX[purpose],
		safeRole,
		actorId,
		String(year),
		month,
		`${crypto.randomUUID()}.${ext}`
	].join('/');
}

export async function createR2PresignedUpload(input: CreatePresignedUploadInput) {
	const config = r2Config();
	const purpose = normalizePurpose(input.purpose);
	const contentType = normalizeContentType(input.contentType);
	const byteSize = Number(input.byteSize);

	if (!Number.isFinite(byteSize) || byteSize <= 0) {
		throw new Error('Dung lượng file không hợp lệ');
	}
	if (byteSize > config.maxUploadBytes) {
		throw new Error(`Ảnh vượt quá ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB`);
	}

	const objectKey = createObjectKey(purpose, input.actorRole, input.actorId, contentType);
	const command = new PutObjectCommand({
		Bucket: config.bucket,
		Key: objectKey,
		ContentType: contentType
	});

	const uploadUrl = await getSignedUrl(r2Client(config), command, { expiresIn: config.expiresIn });
	new URL(uploadUrl);
	const publicUrl = `${config.publicBaseUrl}/${objectKey}`;

	return {
		uploadUrl,
		method: 'PUT',
		headers: {
			'Content-Type': contentType
		},
		objectKey,
		publicUrl,
		url: publicUrl,
		expiresIn: config.expiresIn,
		maxSize: config.maxUploadBytes
	};
}

export async function uploadR2Object(input: UploadR2ObjectInput) {
	const config = r2Config();
	const purpose = normalizePurpose(input.purpose);
	const contentType = normalizeContentType(input.contentType);
	const byteSize = Number(input.byteSize);

	if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize !== input.body.byteLength) {
		throw new Error('Dung lượng file không hợp lệ');
	}
	if (byteSize > config.maxUploadBytes) {
		throw new Error(`Ảnh vượt quá ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB`);
	}

	const objectKey = createObjectKey(purpose, input.actorRole, input.actorId, contentType);
	const command = new PutObjectCommand({
		Bucket: config.bucket,
		Key: objectKey,
		ContentType: contentType,
		Body: input.body
	});

	await r2Client(config).send(command);
	const publicUrl = `${config.publicBaseUrl}/${objectKey}`;

	return {
		objectKey,
		publicUrl,
		url: publicUrl
	};
}
