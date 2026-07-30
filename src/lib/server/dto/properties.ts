/** §9 DTO allowlists for property API responses. */

import { BLOCK_COLUMNS, type BlockDto, toBlockDto } from './rooms.js';

export const PROPERTY_COLUMNS = {
	id: true,
	landlordId: true,
	name: true,
	shortName: true,
	address: true,
	rentalType: true,
	operatingModel: true,
	createdAt: true
} as const;

export const PROPERTY_ROOM_SUMMARY_COLUMNS = {
	id: true,
	roomNumber: true,
	status: true,
	roomType: true,
	monthlyRent: true
} as const;

export type PropertyRoomSummaryDto = {
	id: string;
	roomNumber: string;
	status: string;
	roomType: string;
	monthlyRent: number;
};

export type PropertyDto = {
	id: string;
	landlordId: string;
	name: string;
	shortName: string;
	address: string;
	rentalType: string;
	operatingModel: string;
	createdAt: Date;
	blocks: BlockDto[];
	rooms: PropertyRoomSummaryDto[];
};

export function toPropertyRoomSummaryDto(row: {
	id: string;
	roomNumber: string;
	status: string;
	roomType: string;
	monthlyRent: number;
}): PropertyRoomSummaryDto {
	return {
		id: row.id,
		roomNumber: row.roomNumber,
		status: row.status,
		roomType: row.roomType,
		monthlyRent: row.monthlyRent
	};
}

export function toPropertyDto(row: {
	id: string;
	landlordId: string;
	name: string;
	shortName: string;
	address: string;
	rentalType: string;
	operatingModel: string;
	createdAt: Date;
	blocks?: Array<{ id: string; propertyId: string; name: string }>;
	rooms?: Array<{
		id: string;
		roomNumber: string;
		status: string;
		roomType: string;
		monthlyRent: number;
	}>;
}): PropertyDto {
	return {
		id: row.id,
		landlordId: row.landlordId,
		name: row.name,
		shortName: row.shortName,
		address: row.address,
		rentalType: row.rentalType,
		operatingModel: row.operatingModel,
		createdAt: row.createdAt,
		blocks: (row.blocks ?? []).map((block) => toBlockDto(block)!),
		rooms: (row.rooms ?? []).map(toPropertyRoomSummaryDto)
	};
}

export { BLOCK_COLUMNS };
