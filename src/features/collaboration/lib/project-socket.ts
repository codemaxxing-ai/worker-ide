import { serializeMessage, parseServerMessage, type ClientMessage, type ServerMessage } from '@shared/ws-messages';

export interface ProjectSocketConnection {
	cleanup: () => void;
	close: (code?: number, reason?: string) => void;
	send: (data: ClientMessage) => void;
}

export interface ProjectSocketCloseDetails {
	code: number;
	reason: string;
}

export function connectProjectSocket(
	projectId: string,
	onMessage: (message: ServerMessage) => void,
	onClose?: (details: ProjectSocketCloseDetails) => void,
	onOpen?: () => void,
): ProjectSocketConnection {
	const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const wsUrl = `${protocol}//${globalThis.location.host}/p/${projectId}/__ws`;

	let intentionalClose = false;
	const socket = new WebSocket(wsUrl);

	socket.addEventListener('open', () => {
		// Send collab-join immediately on connection (matching old behaviour)
		socket.send(serializeMessage({ type: 'collab-join' }));
		onOpen?.();
	});

	socket.addEventListener('message', (event) => {
		const result = parseServerMessage(String(event.data));
		if (result.success) {
			onMessage(result.data);
		} else {
			console.warn('Failed to parse WebSocket message:', result.error);
		}
	});

	socket.addEventListener('close', (event) => {
		// Only fire onClose for unexpected disconnects
		if (!intentionalClose) {
			onClose?.({ code: event.code, reason: event.reason });
		}
	});

	socket.addEventListener('error', () => {
		// Error events are always followed by close events, so we don't need
		// to do anything special here — just let the close handler fire.
	});

	const send = (data: ClientMessage) => {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(serializeMessage(data));
		}
	};

	return {
		cleanup: () => {
			intentionalClose = true;
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close(1000, 'cleanup');
			}
		},
		close: (code = 1000, reason = '') => {
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close(code, reason);
			}
		},
		send,
	};
}
