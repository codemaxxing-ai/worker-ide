import type { ModelMessage } from 'ai';
const estimateTokens = (text: string) => Math.ceil(text.length / 4);
export function estimateMessagesTokens(messages: ModelMessage[]): number {
	let total = 0;
	for (const message of messages) {
		if (typeof message.content === 'string') {
			total += estimateTokens(message.content);
		} else if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if ('text' in part && typeof part.text === 'string') {
					total += estimateTokens(part.text);
				}
				if ('input' in part && part.input) {
					total += estimateTokens(typeof part.input === 'string' ? part.input : JSON.stringify(part.input));
				}
				if ('output' in part && part.output) {
					total += estimateTokens(typeof part.output === 'string' ? part.output : JSON.stringify(part.output));
				}
			}
		}
	}
	return total;
}
