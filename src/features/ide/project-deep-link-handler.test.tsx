import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const applyProjectDeepLink = vi.fn();

	return {
		applyProjectDeepLink,
	};
});

vi.mock('@/lib/project-deep-link', () => ({
	useProjectDeepLinkApplier: () => mocks.applyProjectDeepLink,
}));

import { ProjectDeepLinkHandler } from './project-deep-link-handler';

describe('ProjectDeepLinkHandler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('opens an agent session deep link once per unique target', () => {
		const onHandled = vi.fn();
		const view = render(
			<ProjectDeepLinkHandler projectId="project-1" deepLink={{ kind: 'agent-session', sessionId: 'session-2' }} onHandled={onHandled} />,
		);

		expect(mocks.applyProjectDeepLink).toHaveBeenCalledWith({ kind: 'agent-session', sessionId: 'session-2' });
		expect(onHandled).toHaveBeenCalledTimes(1);
		expect(mocks.applyProjectDeepLink).toHaveBeenCalledTimes(1);

		view.rerender(
			<ProjectDeepLinkHandler projectId="project-1" deepLink={{ kind: 'agent-session', sessionId: 'session-2' }} onHandled={onHandled} />,
		);
		expect(mocks.applyProjectDeepLink).toHaveBeenCalledTimes(1);
		expect(onHandled).toHaveBeenCalledTimes(1);

		view.rerender(
			<ProjectDeepLinkHandler projectId="project-1" deepLink={{ kind: 'agent-session', sessionId: 'session-3' }} onHandled={onHandled} />,
		);
		expect(mocks.applyProjectDeepLink).toHaveBeenCalledTimes(2);
		expect(onHandled).toHaveBeenCalledTimes(2);
		expect(mocks.applyProjectDeepLink).toHaveBeenLastCalledWith({ kind: 'agent-session', sessionId: 'session-3' });
	});
});
