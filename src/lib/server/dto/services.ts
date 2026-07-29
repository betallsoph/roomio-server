/** §9 DTO allowlists for service catalog API responses. */

import { SERVICE_COLUMNS, type ServiceDto, toServiceDto } from './rooms.js';

export { SERVICE_COLUMNS, type ServiceDto, toServiceDto };

export function toServiceListDto(
	rows: Array<{
		id: string;
		landlordId: string;
		name: string;
		type: string;
		defaultRate: number;
		isActive: boolean;
	}>
): ServiceDto[] {
	return rows.map((row) => toServiceDto(row)!);
}
