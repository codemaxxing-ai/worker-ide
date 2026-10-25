/** Bound provider inactivity without including time spent executing tools. */
export function withStreamTimeout<Value>(stream: ReadableStream<Value>, timeoutMs: number, signal?: AbortSignal): ReadableStream<Value> {
	const reader = stream.getReader();
	let abort: (() => void) | undefined;
	const detach = () => {
		if (abort) signal?.removeEventListener('abort', abort);
	};
	return new ReadableStream<Value>({
		start(controller) {
			abort = () => {
				detach();
				controller.error(signal?.reason ?? new DOMException('Cancelled by user', 'AbortError'));
				void reader.cancel(signal?.reason).catch(() => {});
			};
			if (signal?.aborted) abort();
			else signal?.addEventListener('abort', abort, { once: true });
		},
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
					detach();
					controller.close();
					return;
				}
				controller.enqueue(result.value);
			} catch (error) {
				detach();
				controller.error(error);
				void reader.cancel(error).catch(() => {});
			} finally {
				clearTimeout(timeout);
			}
		},
		cancel(reason) {
			detach();
			// A provider can ignore cancellation. Do not hold the consumer open
			// waiting for its cancellation acknowledgement.
			void reader.cancel(reason).catch(() => {});
		},
	});
}
