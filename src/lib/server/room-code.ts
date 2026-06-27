type RoomCodeProfile = {
	normalize(value: unknown): string | null;
};

const codeProfiles: Record<string, RoomCodeProfile> = {
	hagl3: {
		normalize: normalizeHagl3Code
	}
};

export function normalizeRoomCodeForProperty(propertyId: string, value: unknown) {
	return codeProfiles[propertyId]?.normalize(value) ?? null;
}

export function normalizeRoomTextKey(value: unknown) {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

function normalizeHagl3Code(value: unknown) {
	const raw = String(value ?? '')
		.trim()
		.toUpperCase()
		.replace(/Đ/g, 'D');
	if (!raw) return null;

	const cleaned = raw.replace(/BLOCK|BLK|TANG|TẦNG|CAN|CĂN|PHONG|PHÒNG/g, '');
	const parts = cleaned.split(/[\s.\-_/]+/).filter(Boolean);
	const compact = parts.join('');

	const fromParts = normalizeHagl3Parts(parts);
	if (fromParts) return fromParts;

	const directCompact = compact.match(/^([A-D])(\d{1,2})(\d{2})$/);
	if (directCompact) {
		return buildHagl3Code(directCompact[1], directCompact[2], directCompact[3]);
	}

	const blockCompact = compact.match(/^([A-D])[12](\d{1,2})(\d{2})$/);
	if (blockCompact) {
		return buildHagl3Code(blockCompact[1], blockCompact[2], blockCompact[3]);
	}

	return null;
}

function normalizeHagl3Parts(parts: string[]) {
	if (parts.length === 3) {
		const towerFromBlock = parts[0].match(/^([A-D])(?:[12])?$/);
		if (towerFromBlock && /^\d{1,2}$/.test(parts[1]) && /^\d{1,2}$/.test(parts[2])) {
			return buildHagl3Code(towerFromBlock[1], parts[1], parts[2]);
		}
	}

	if (parts.length === 2) {
		const towerFloor = parts[0].match(/^([A-D])(\d{1,2})$/);
		if (towerFloor && /^\d{1,2}$/.test(parts[1])) {
			return buildHagl3Code(towerFloor[1], towerFloor[2], parts[1]);
		}

		const towerBlock = parts[0].match(/^([A-D])[12]$/);
		const floorUnit = parts[1].match(/^(\d{1,2})(\d{2})$/);
		if (towerBlock && floorUnit) {
			return buildHagl3Code(towerBlock[1], floorUnit[1], floorUnit[2]);
		}
	}

	return null;
}

function buildHagl3Code(tower: string, floor: string, unit: string) {
	return `${tower}${floor.padStart(2, '0')}-${unit.padStart(2, '0')}`;
}
