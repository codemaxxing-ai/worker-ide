import { beforeEach, describe, expect, it } from 'vitest';

import { clearAgentDraftSession, loadAgentDraftSession, saveAgentDraftSession } from './agent-draft-session';

describe('agent-draft-session', () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it('stores drafts per project', () => {
		saveAgentDraftSession('project-1', {
			segments: [{ type: 'text', value: 'hello' }],
			cursorPosition: 5,
		});
		saveAgentDraftSession('project-2', {
			segments: [{ type: 'text', value: 'goodbye' }],
			cursorPosition: 7,
		});

		expect(loadAgentDraftSession('project-1')).toEqual({
			segments: [{ type: 'text', value: 'hello' }],
			cursorPosition: 5,
		});
		expect(loadAgentDraftSession('project-2')).toEqual({
			segments: [{ type: 'text', value: 'goodbye' }],
			cursorPosition: 7,
		});
	});

	it('clears empty drafts instead of leaving stale storage behind', () => {
		saveAgentDraftSession('project-1', {
			segments: [{ type: 'text', value: 'hello' }],
			cursorPosition: 5,
		});

		saveAgentDraftSession('project-1', {
			segments: [],
			cursorPosition: 0,
		});

		expect(loadAgentDraftSession('project-1')).toBeUndefined();
	});

	it('drops invalid draft payloads', () => {
		sessionStorage.setItem('think-draft:project-1', JSON.stringify({ segments: [{ type: 'text', value: 123 }] }));

		expect(loadAgentDraftSession('project-1')).toBeUndefined();
	});

	it('explicitly clears stored drafts', () => {
		saveAgentDraftSession('project-1', {
			segments: [{ type: 'text', value: 'hello' }],
			cursorPosition: 5,
		});

		clearAgentDraftSession('project-1');

		expect(loadAgentDraftSession('project-1')).toBeUndefined();
	});
});
