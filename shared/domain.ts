import { PREVIEW_TOKEN_PATTERN } from './preview-token';
import { isValidProjectId } from './project-id';

export interface DomainConfiguration {
	appOrigin: string;
	contentOrigin: string;
}
export type ParsedOrigin = { type: 'preview'; projectId: string; token: string } | { type: 'git' | 'app' | 'content' | 'unknown' };

function readOrigin(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
		throw new Error('Hosting origins must be HTTPS origins without credentials or paths');
	}
	return url;
}
export function createDomainConfiguration(appOrigin: string, contentOrigin: string): DomainConfiguration {
	const app = readOrigin(appOrigin);
	const content = readOrigin(contentOrigin);
	if (app.hostname === content.hostname) throw new Error('Application and content hosts must be separate');
	return { appOrigin: app.origin, contentOrigin: content.origin };
}
export function buildGitOrigin(appOrigin: string): string {
	const url = readOrigin(appOrigin);
	url.hostname = `git.${url.hostname}`;
	return url.origin;
}
export function buildPreviewOrigin(projectId: string, token: string, contentOrigin: string): string {
	if (!isValidProjectId(projectId) || !PREVIEW_TOKEN_PATTERN.test(token)) throw new Error('Invalid preview identity');
	const label = `${projectId}-${token}`;
	if (label.length > 63) throw new Error('Preview identity exceeds the DNS label limit');
	const url = readOrigin(contentOrigin);
	url.hostname = `${label}.${url.hostname}`;
	return url.origin;
}
/** DNS suffixes never confer application authority. */
export function classifyOrigin(origin: string, configuration: DomainConfiguration): ParsedOrigin {
	try {
		const url = readOrigin(origin);
		if (url.origin === configuration.appOrigin) return { type: 'app' };
		if (url.origin === buildGitOrigin(configuration.appOrigin)) return { type: 'git' };
		if (url.origin === configuration.contentOrigin) return { type: 'content' };
		const content = readOrigin(configuration.contentOrigin);
		const suffix = `.${content.hostname}`;
		if (url.port !== content.port || !url.hostname.endsWith(suffix)) return { type: 'unknown' };
		const label = url.hostname.slice(0, -suffix.length);
		if (label.includes('.')) return { type: 'unknown' };
		const separator = label.lastIndexOf('-');
		const projectId = label.slice(0, separator);
		const token = label.slice(separator + 1);
		if (separator <= 0 || !isValidProjectId(projectId) || !PREVIEW_TOKEN_PATTERN.test(token)) return { type: 'unknown' };
		return { type: 'preview', projectId, token };
	} catch {
		return { type: 'unknown' };
	}
}
