import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import { Agent, install } from 'undici';

// Keep fetch and its Web API constructors together across isolated Vitest files.
// Node's lazily cached fetch can retain a previous file's AbortSignal constructor.
install();

let dispatcher: Agent | undefined;

/** Trust only the generated local certificate and resolve local test hosts without changing their origin. */
export function localFetch(input: string | URL | Request, options: RequestInit = {}): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : input);
	if (url.protocol !== 'https:' || (url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost'))) return fetch(input, options);
	if (!dispatcher) {
		const certificate = new X509Certificate(readFileSync(path.resolve(import.meta.dirname, '../.local-certificates/_cert.pem'))).toString();
		setDefaultCACertificates([...getCACertificates('default'), certificate]);
		dispatcher = new Agent({
			connect: {
				ca: certificate,
				lookup: (_hostname, lookupOptions, callback) => {
					// eslint-disable-next-line unicorn/no-null -- Node's lookup callback requires a null success error
					if (lookupOptions.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
					// eslint-disable-next-line unicorn/no-null -- Node's lookup callback requires a null success error
					else callback(null, '127.0.0.1', 4);
				},
			},
		});
	}
	const localOptions = { ...options, dispatcher };
	return fetch(input, localOptions);
}
