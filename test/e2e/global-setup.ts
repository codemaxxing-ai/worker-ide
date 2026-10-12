import { localFetch as fetch } from '../local-https';
const BASE_URL = process.env.TEST_BASE_URL || 'https://localhost:3000';

async function cleanupServer(): Promise<void> {
	try {
		await fetch(`${BASE_URL}/__test/cleanup`, { method: 'POST' });
	} catch {
		// Server may not be reachable yet (setup) or already stopped (teardown)
	}
}

export default async function globalSetup(): Promise<() => Promise<void>> {
	// Clean up leftover projects from prior interrupted runs
	await cleanupServer();

	// Return teardown function
	return async () => {
		await cleanupServer();
	};
}
