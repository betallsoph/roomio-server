function toIso(value: Date | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return value instanceof Date ? value.toISOString() : value;
}

export type AutomationJobDto = {
	id: string;
	type: string;
	status: string;
	scheduledFor: string;
	startedAt: string | null;
	completedAt: string | null;
	result: string | null;
	createdAt: string;
};

export type QueuedNotificationDto = {
	id: string;
	type: string;
	status: string;
	title: string;
	content: string;
	createdAt: string;
};

export type AutomationJobRowForDto = {
	id: string;
	type: string;
	status: string;
	scheduledFor: string;
	startedAt: Date | string | null;
	completedAt: Date | string | null;
	result: string | null;
	createdAt: Date | string;
};

export type QueuedNotificationRowForDto = {
	id: string;
	type: string;
	status: string;
	title: string;
	content: string;
	createdAt: Date | string;
};

export function toAutomationJobDto(row: AutomationJobRowForDto): AutomationJobDto {
	return {
		id: row.id,
		type: row.type,
		status: row.status,
		scheduledFor: row.scheduledFor,
		startedAt: toIso(row.startedAt),
		completedAt: toIso(row.completedAt),
		result: row.result,
		createdAt: toIso(row.createdAt) ?? ''
	};
}

export function toQueuedNotificationDto(row: QueuedNotificationRowForDto): QueuedNotificationDto {
	return {
		id: row.id,
		type: row.type,
		status: row.status,
		title: row.title,
		content: row.content,
		createdAt: toIso(row.createdAt) ?? ''
	};
}

export type AutomationOverviewDto = {
	jobs: AutomationJobDto[];
	queuedNotifications: QueuedNotificationDto[];
};

export function toAutomationOverviewDto(input: {
	jobs: AutomationJobRowForDto[];
	queuedNotifications: QueuedNotificationRowForDto[];
}): AutomationOverviewDto {
	return {
		jobs: input.jobs.map(toAutomationJobDto),
		queuedNotifications: input.queuedNotifications.map(toQueuedNotificationDto)
	};
}
