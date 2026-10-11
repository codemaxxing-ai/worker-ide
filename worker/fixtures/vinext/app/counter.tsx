'use client';

import { useState, useSyncExternalStore } from 'react';

const unsubscribeFromHydration = () => {};

function subscribeToHydration() {
	return unsubscribeFromHydration;
}

export function Counter() {
	const [count, setCount] = useState(0);
	const ready = useSyncExternalStore(
		subscribeToHydration,
		() => true,
		() => false,
	);
	return (
		<button id="vinext-counter" type="button" className="counter" disabled={!ready} onClick={() => setCount((value) => value + 1)}>
			Count: {count}
		</button>
	);
}
