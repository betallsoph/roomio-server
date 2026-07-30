import type { MeterOcrResult } from '$lib/server/meter-ocr';

export type MeterOcrDto = {
	value: number | null;
	error?: string;
};

/** AUTH-013/017 — strip raw OCR debug text from client responses. */
export function toMeterOcrDto(result: MeterOcrResult): MeterOcrDto {
	return {
		value: result.value,
		...(result.error ? { error: result.error } : {})
	};
}
