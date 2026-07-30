import type { DashboardStatsRow } from '$lib/server/aggregate-scope';

export type DashboardStatsDto = DashboardStatsRow;

export function toDashboardStatsDto(row: DashboardStatsRow): DashboardStatsDto {
	return { ...row };
}
