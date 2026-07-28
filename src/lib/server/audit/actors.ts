import type { MachineChannel, UserActor } from '$lib/server/authorization/actor.js';

export type AuditActorType = 'USER' | 'MACHINE' | 'SYSTEM';

export type AuditActorRef = {
	actorType: AuditActorType;
	actorUserId: string | null;
	actorRole: string | null;
	landlordIdHint?: string | null;
};

export function auditActorFromUserActor(
	actor: UserActor,
	landlordId?: string | null
): AuditActorRef {
	let landlordIdHint: string | null | undefined = landlordId;

	if (landlordIdHint === undefined) {
		if (actor.role === 'LANDLORD') {
			landlordIdHint = actor.landlordId;
		} else if (actor.role === 'STAFF') {
			landlordIdHint = actor.landlordId;
		}
	}

	return {
		actorType: 'USER',
		actorUserId: actor.userId,
		actorRole: actor.role,
		landlordIdHint: landlordIdHint ?? undefined
	};
}

export function auditActorMachine(channel: MachineChannel): AuditActorRef {
	return {
		actorType: 'MACHINE',
		actorUserId: null,
		actorRole: channel,
		landlordIdHint: undefined
	};
}

export function auditActorSystem(label?: string | null): AuditActorRef {
	return {
		actorType: 'SYSTEM',
		actorUserId: null,
		actorRole: label?.trim() || 'SYSTEM',
		landlordIdHint: undefined
	};
}
