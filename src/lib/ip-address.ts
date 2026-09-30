export function formatIpAddress(value: string): string {
	const address = value.trim();
	if (!address.includes(':')) return address;
	const host = address.replaceAll(/^\[|\]$/g, '');
	if (!/^[\da-f:.]+$/i.test(host)) return address;
	try {
		return new URL(`http://[${host}]/`).hostname.slice(1, -1);
	} catch {
		return address;
	}
}
