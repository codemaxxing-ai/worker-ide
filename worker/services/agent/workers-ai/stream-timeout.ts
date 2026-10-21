/** Bound provider inactivity without including time spent executing tools. */
export function withStreamTimeout<Value>(stream: ReadableStream<Value>, timeoutMs: number): ReadableStream<Value> {
	const reader = stream.getReader();
	return new ReadableStream<Value>({
		async pull(controller) {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					reader.read(),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error('The model stopped responding for two minutes. Please try again.')), timeoutMs);
					}),
				]);
				if (result.done) {
					controller.close();
					return;
				}
				controller.enqueue(result.value);
			} catch (error) {
				controller.error(error);
				void reader.cancel(error).catch(() => {});
			} finally {
				clearTimeout(timeout);
			}
		},
		cancel: (reason) => reader.cancel(reason),
	});
}
