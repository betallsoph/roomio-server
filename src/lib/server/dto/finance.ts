import type { FinanceSummary } from '$lib/server/aggregate-scope';

export type FinanceSummaryDto = FinanceSummary;

export function toFinanceSummaryDto(row: FinanceSummary): FinanceSummaryDto {
	return { ...row };
}
