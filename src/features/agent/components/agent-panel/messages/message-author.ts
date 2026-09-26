import type { SessionParticipantProfile } from '@shared/agent-state';

export function resolveAuthorName(
	authorUserId: string | undefined,
	currentUserId: string | undefined,
	sessionParticipants: Record<string, SessionParticipantProfile>,
): string {
	if (authorUserId && currentUserId && authorUserId === currentUserId) {
		return 'You';
	}

	if (!authorUserId) {
		return 'Unknown';
	}

	return sessionParticipants[authorUserId]?.name ?? 'Unknown';
}

export function resolveAuthorColor(
	authorUserId: string | undefined,
	sessionParticipants: Record<string, SessionParticipantProfile>,
): string | undefined {
	if (!authorUserId) {
		return undefined;
	}

	return sessionParticipants[authorUserId]?.color;
}
