/** §9 DTO allowlists for maintenance request API responses. */

export type MaintenanceRequestUserDto = {
	name: string;
	phone: string;
};

export type MaintenanceRequestDto = {
	id: string;
	tenantId: string;
	roomNumber: string;
	buildingName: string;
	category: string;
	title: string;
	description: string;
	imageUrl: string | null;
	status: string;
	priority: string;
	createdAt: Date;
	updatedAt: Date;
	response: string | null;
	assignedToId: string | null;
	managedTenantId: string | null;
	tenancyId: string | null;
	landlordId: string | null;
	propertyId: string | null;
	roomId: string | null;
	tenant: { id: string; user: MaintenanceRequestUserDto | null } | null;
	assignedTo: { id: string; user: MaintenanceRequestUserDto | null } | null;
};

function toMaintenanceRequestUserDto(
	row: { name: string; phone: string } | null | undefined
): MaintenanceRequestUserDto | null {
	if (!row) return null;
	return { name: row.name, phone: row.phone };
}

export function toMaintenanceRequestDto(row: {
	id: string;
	tenantId: string;
	roomNumber: string;
	buildingName: string;
	category: string;
	title: string;
	description: string;
	imageUrl: string | null;
	status: string;
	priority: string;
	createdAt: Date;
	updatedAt: Date;
	response: string | null;
	assignedToId: string | null;
	managedTenantId: string | null;
	tenancyId: string | null;
	landlordId: string | null;
	propertyId: string | null;
	roomId: string | null;
	tenant?: {
		id: string;
		user?: { name: string; phone: string } | null;
	} | null;
	assignedTo?: {
		id: string;
		user?: { name: string; phone: string } | null;
	} | null;
}): MaintenanceRequestDto {
	return {
		id: row.id,
		tenantId: row.tenantId,
		roomNumber: row.roomNumber,
		buildingName: row.buildingName,
		category: row.category,
		title: row.title,
		description: row.description,
		imageUrl: row.imageUrl,
		status: row.status,
		priority: row.priority,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		response: row.response,
		assignedToId: row.assignedToId,
		managedTenantId: row.managedTenantId,
		tenancyId: row.tenancyId,
		landlordId: row.landlordId,
		propertyId: row.propertyId,
		roomId: row.roomId,
		tenant: row.tenant
			? { id: row.tenant.id, user: toMaintenanceRequestUserDto(row.tenant.user) }
			: null,
		assignedTo: row.assignedTo
			? { id: row.assignedTo.id, user: toMaintenanceRequestUserDto(row.assignedTo.user) }
			: null
	};
}
