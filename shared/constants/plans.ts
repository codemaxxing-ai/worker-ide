export const PLAN_FREE = 'free';
export const PLAN_PRO = 'pro';
export const PLAN_ENTERPRISE = 'enterprise';

export type PlanId = typeof PLAN_FREE | typeof PLAN_PRO | typeof PLAN_ENTERPRISE;

export interface PlanLimits {
	maxProjects: number;
	maxMembers: number;
	maxRunningContainers: number;
	maxPendingInvitations: number;
	monthlyCredits: number;
	storageQuotaBytes: number;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
	[PLAN_FREE]: {
		maxProjects: 10,
		maxMembers: 10,
		maxRunningContainers: 3,
		maxPendingInvitations: 10,
		monthlyCredits: 100,
		storageQuotaBytes: 50 * 1024 * 1024, // 50 MB
	},
	[PLAN_PRO]: {
		maxProjects: 50,
		maxMembers: 25,
		maxRunningContainers: 10,
		maxPendingInvitations: 25,
		monthlyCredits: 1000,
		storageQuotaBytes: 500 * 1024 * 1024, // 500 MB
	},
	[PLAN_ENTERPRISE]: {
		maxProjects: 500,
		maxMembers: 100,
		maxRunningContainers: 100,
		maxPendingInvitations: 100,
		monthlyCredits: 5000,
		storageQuotaBytes: 5 * 1024 * 1024 * 1024, // 5 GB
	},
};

function isPlanId(plan: string): plan is PlanId {
	return plan in PLAN_LIMITS;
}

export function getOrgLimits(plan: string): PlanLimits {
	return isPlanId(plan) ? PLAN_LIMITS[plan] : PLAN_LIMITS[PLAN_FREE];
}

export const CREDITS_PER_AI_SESSION = 1;
