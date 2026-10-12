import { createDomainConfiguration } from '@shared/domain';

export function getDomainConfiguration(environment: Pick<Env, 'APP_ORIGIN' | 'CONTENT_ORIGIN'>) {
	return createDomainConfiguration(environment.APP_ORIGIN, environment.CONTENT_ORIGIN);
}
