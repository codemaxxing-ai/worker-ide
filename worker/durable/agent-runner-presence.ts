import { COLLAB_COLORS } from '@shared/constants';

import type { SessionParticipantProfile } from '@shared/agent-state';

interface ConnectionIdentityAttachment extends SessionParticipantProfile {
	userId: string;
}

function isConnectionIdentityAttachment(value: unknown): value is ConnectionIdentityAttachment {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}

	return (
		'userId' in value &&
		typeof value.userId === 'string' &&
		'name' in value &&
		typeof value.name === 'string' &&
		'color' in value &&
		typeof value.color === 'string' &&
		(!('image' in value) || typeof value.image === 'string' || value.image === undefined)
	);
}

function hashString(value: string): number {
	let hash = 0;
	for (const character of value) {
		hash = (hash << 5) - hash + (character.codePointAt(0) ?? 0);
		hash = Math.trunc(hash);
	}
	return Math.abs(hash);
}

function getParticipantColor(userId: string): string {
	return COLLAB_COLORS[hashString(userId) % COLLAB_COLORS.length] ?? COLLAB_COLORS[0];
}

function getParticipantProfile(identity: ConnectionIdentityAttachment): SessionParticipantProfile {
	return {
		name: identity.name,
		image: identity.image,
		color: identity.color,
	};
}

export { getParticipantColor, getParticipantProfile, isConnectionIdentityAttachment, type ConnectionIdentityAttachment };
