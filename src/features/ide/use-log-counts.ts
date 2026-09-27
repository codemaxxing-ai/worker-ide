import { useEffect, useMemo, useRef } from 'react';

import { useLogs } from '@/features/output/lib/log-buffer';
import { useStore } from '@/lib/store';

import type { LogCounts } from '@/features/output/index';

export function useLogCounts() {
	const logs = useLogs();
	const utilityPanelVisible = useStore((state) => state.utilityPanelVisible);
	const toggleUtilityPanel = useStore((state) => state.toggleUtilityPanel);

	const logCounts = useMemo<LogCounts>(() => {
		let errors = 0;
		let warnings = 0;
		let logCount = 0;
		for (const entry of logs) {
			if (entry.level === 'error') errors++;
			else if (entry.level === 'warning') warnings++;
			else logCount++;
		}
		return { errors, warnings, logs: logCount };
	}, [logs]);

	// Auto-open utility panel when errors arrive
	const previousErrorCount = useRef(0);
	useEffect(() => {
		if (logCounts.errors > previousErrorCount.current && !utilityPanelVisible) {
			toggleUtilityPanel();
		}
		previousErrorCount.current = logCounts.errors;
	}, [logCounts.errors, utilityPanelVisible, toggleUtilityPanel]);

	return logCounts;
}
