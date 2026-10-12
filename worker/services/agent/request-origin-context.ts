import { createDomainConfiguration } from '@shared/domain';

import type { DomainConfiguration } from '@shared/domain';

export type RequestOriginContext = DomainConfiguration;

export function isRequestOriginContext(value: unknown): value is RequestOriginContext {
	if (!value || typeof value !== 'object' || !('appOrigin' in value) || !('contentOrigin' in value)) return false;
	if (typeof value.appOrigin !== 'string' || typeof value.contentOrigin !== 'string') return false;
	try {
		createDomainConfiguration(value.appOrigin, value.contentOrigin);
		return true;
	} catch {
		return false;
	}
}
