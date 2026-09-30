import { describe, expect, it } from 'vitest';

import { formatIpAddress } from './ip-address';

describe('formatIpAddress', () => {
	it.each([
		['203.0.113.8', '203.0.113.8'],
		['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
		['2001:db8::1', '2001:db8::1'],
		['0000:0000:0000:0000:0000:0000:0000:0000', '::'],
		['2001:0:0:1:0:0:1:1', '2001::1:0:0:1:1'],
		['2001:db8:0:1:2:3:4:5', '2001:db8:0:1:2:3:4:5'],
		['[2001:0DB8::0001]', '2001:db8::1'],
		[' 2001:db8::1 ', '2001:db8::1'],
		['2001:db8:abcd:ef12:3456:7890:abcd:ef12', '2001:db8:abcd:ef12:3456:7890:abcd:ef12'],
		['invalid:address', 'invalid:address'],
		['2001:::1', '2001:::1'],
		['fe80::1%en0', 'fe80::1%en0'],
		['Unknown IP', 'Unknown IP'],
	])('formats %s as %s', (input, expected) => {
		expect(formatIpAddress(input)).toBe(expected);
	});
});
