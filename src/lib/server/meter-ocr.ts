import { GoogleGenerativeAI } from '@google/generative-ai';
import { getEnv } from './env';
const METER_PHOTO_PREFIX = 'uploads/meters/';

export interface MeterOcrResult {
	value: number | null;
	rawText?: string;
	error?: string;
}

function googleAiApiKey(): string | null {
	const ocr = getEnv().ocr;
	return ocr.status === 'CONFIGURED' ? ocr.apiKey : null;
}

function geminiMeterModel(): string {
	const ocr = getEnv().ocr;
	return ocr.status === 'CONFIGURED' ? ocr.meterModel : 'gemini-2.5-flash';
}

function r2PublicBaseUrl(): string | null {
	const r2 = getEnv().r2;
	if (r2.status !== 'CONFIGURED') return null;
	try {
		return new URL(r2.publicBaseUrl).toString().replace(/\/+$/, '');
	} catch {
		return null;
	}
}

export function isR2MeterPhotoUrl(url: string): boolean {
	const baseUrl = r2PublicBaseUrl();
	if (!baseUrl) return false;

	try {
		const parsed = new URL(url);
		const base = new URL(baseUrl);
		if (parsed.origin !== base.origin) return false;
		const path = parsed.pathname.replace(/^\/+/, '');
		return path.startsWith(METER_PHOTO_PREFIX);
	} catch {
		return false;
	}
}

/** Trích số chỉ số đồng hồ từ phản hồi Gemini (JSON hoặc văn bản tự do). */
export function extractMeterValueFromText(text: string): number | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as { value?: unknown; reading?: unknown };
			const candidate = parsed.value ?? parsed.reading;
			const num = Number(candidate);
			if (Number.isFinite(num) && num >= 0) return Math.round(num);
		} catch {
			// fall through to digit extraction
		}
	}

	const digits = trimmed.match(/\d[\d.,]*/g);
	if (!digits?.length) return null;

	let best: number | null = null;
	for (const token of digits) {
		const normalized = token.replace(/[.,](?=\d{3}\b)/g, '').replace(/[.,]$/, '');
		const num = Number(normalized.replace(/[^\d]/g, ''));
		if (!Number.isFinite(num) || num < 0) continue;
		if (best === null || num > best) best = num;
	}
	return best;
}

async function fetchImageBytes(photoUrl: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
	const response = await fetch(photoUrl, { redirect: 'manual' });
	if (response.status >= 300 && response.status < 400) {
		throw new Error('URL ảnh không được chuyển hướng ra nguồn khác');
	}
	if (!response.ok) {
		throw new Error(`Không tải được ảnh (${response.status})`);
	}

	const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
	if (!mimeType.startsWith('image/')) {
		throw new Error('URL không phải ảnh hợp lệ');
	}

	const buffer = await response.arrayBuffer();
	if (!buffer.byteLength) {
		throw new Error('Ảnh rỗng');
	}

	return { bytes: new Uint8Array(buffer), mimeType };
}

const METER_OCR_PROMPT = `Bạn đang đọc ảnh chụp đồng hồ điện tại Việt Nam (công tơ điện).
Nhiệm vụ: trích số chỉ số hiện tại trên màn hình/cơ quay (kWh), chỉ lấy phần số nguyên chính, bỏ đơn vị và số thập phân phụ nếu có.
Trả lời DUY NHẤT một JSON hợp lệ, không markdown, dạng: {"value":12345}
Nếu không đọc được, trả: {"value":null}`;

export async function parseMeterReadingFromImageUrl(photoUrl: string): Promise<MeterOcrResult> {
	const apiKey = googleAiApiKey();
	if (!apiKey) {
		return { value: null, error: 'OCR chưa được cấu hình' };
	}

	if (!isR2MeterPhotoUrl(photoUrl)) {
		return { value: null, error: 'URL ảnh không hợp lệ' };
	}

	try {
		const { bytes, mimeType } = await fetchImageBytes(photoUrl);
		const genAI = new GoogleGenerativeAI(apiKey);
		const model = genAI.getGenerativeModel({ model: geminiMeterModel() });

		const result = await model.generateContent([
			{ text: METER_OCR_PROMPT },
			{
				inlineData: {
					mimeType,
					data: Buffer.from(bytes).toString('base64')
				}
			}
		]);

		const rawText = result.response.text()?.trim() ?? '';
		const value = extractMeterValueFromText(rawText);

		if (value === null) {
			return {
				value: null,
				rawText: rawText || undefined,
				error: 'Không đọc được chỉ số từ ảnh'
			};
		}

		return { value, rawText: rawText || undefined };
	} catch (error) {
		return {
			value: null,
			error: error instanceof Error ? error.message : 'Lỗi OCR không xác định'
		};
	}
}
