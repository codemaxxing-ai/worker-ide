/** Probe the manager without replaying any command or workspace mutation. */
export async function waitForNativeRuntime(request: () => Promise<Response>, timeoutMilliseconds = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (true) {
		try {
			const response = await request();
			await response.body?.cancel();
			// Running containers from the previous deployment have no health route.
			// Their 404 still proves that the manager is listening; /sync validates it.
			if (!response.ok && response.status !== 404) throw new Error(`Native preview manager health check failed (${response.status})`);
			return;
		} catch (error) {
			if (!(error instanceof Error) || !/Container is not listening to port 8788/.test(error.message) || Date.now() >= deadline)
				throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
		}
	}
}
