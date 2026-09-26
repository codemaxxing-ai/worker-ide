import { useEffect, useRef } from 'react';

import { useProjectDeepLinkApplier } from '@/lib/project-deep-link';
import { serializeProjectDeepLinkTarget, type ProjectDeepLinkTarget } from '@shared/project-deep-link';

export function ProjectDeepLinkHandler({
	projectId,
	deepLink,
	onHandled,
}: {
	projectId: string;
	deepLink?: ProjectDeepLinkTarget;
	onHandled?: () => void;
}) {
	const applyProjectDeepLink = useProjectDeepLinkApplier();
	const handledRequestReference = useRef<string | undefined>(undefined);

	useEffect(() => {
		if (!deepLink) {
			handledRequestReference.current = undefined;
			return;
		}

		const requestKey = `${projectId}:${serializeProjectDeepLinkTarget(deepLink)}`;
		if (handledRequestReference.current === requestKey) {
			return;
		}
		handledRequestReference.current = requestKey;
		applyProjectDeepLink(deepLink);
		onHandled?.();
	}, [applyProjectDeepLink, deepLink, onHandled, projectId]);

	return <></>;
}
