import { describe, expect, it } from 'vitest';

import { ContainerLimitReachedError, readContainerCapacityError } from './container-capacity';
import { ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS, toEntitlementMap } from './entitlements';
import { resolveOrgLimits } from './limits';

describe('container entitlement', () => {
	it.each([
		['free', 3],
		['pro', 10],
		['enterprise', 100],
	])('resolves %s plan capacity', (plan, limit) => {
		expect(resolveOrgLimits(String(plan), new Map()).maxRunningContainers).toBe(limit);
	});
	it.each([0, 7, 200])('accepts a nonnegative integer override of %s', (value) => {
		expect(
			resolveOrgLimits(
				'free',
				toEntitlementMap([{ key: ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS, valueType: 'number', value: String(value) }]),
			).maxRunningContainers,
		).toBe(value);
	});
	it.each(['-1', '1.5', 'NaN', 'Infinity'])('rejects invalid override %s', (value) => {
		expect(
			resolveOrgLimits('free', toEntitlementMap([{ key: ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS, valueType: 'number', value }]))
				.maxRunningContainers,
		).toBe(3);
	});
	it('preserves capacity errors across RPC wrapping', () => {
		const capacity = { currentRunningContainers: 3, maxRunningContainers: 3 };
		expect(readContainerCapacityError(new Error(`Remote execution: ${new ContainerLimitReachedError(capacity).message}`))).toEqual(
			capacity,
		);
		expect(readContainerCapacityError(new Error('Build failed'))).toBeUndefined();
	});
});
