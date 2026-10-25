import { WorkerEntrypoint } from 'cloudflare:workers';

import { importVapidKeyPair, sendNotification } from './push-core';
import { WebPushResult } from './web-push';

import type { ApplicationServerKeys } from './web-push';
import type { PushNotification, PushQueueMessage, PushSubscriptionInfo } from '@shared/notification-types';

const MAX_QUEUE_BATCH_MESSAGES = 100;
const MAX_QUEUE_BATCH_BYTES = 256_000;
const MAX_QUEUE_MESSAGE_BYTES = 128_000;

type PushQueueSendRequest = { body: PushQueueMessage };

function createQueueBatches(userIds: string[], notification: PushNotification, timestamp: number): PushQueueSendRequest[][] {
	const batches: PushQueueSendRequest[][] = [];
	const textEncoder = new TextEncoder();
	let currentBatch: PushQueueSendRequest[] = [];
	let currentBatchBytes = 2; // JSON array brackets

	for (const userId of userIds) {
		const request: PushQueueSendRequest = { body: { userId, notification, timestamp } };
		const requestBytes = textEncoder.encode(JSON.stringify(request)).byteLength;
		if (requestBytes > MAX_QUEUE_MESSAGE_BYTES) {
			throw new Error(`Push queue message exceeds the ${MAX_QUEUE_MESSAGE_BYTES} byte limit`);
		}

		const separatorBytes = currentBatch.length === 0 ? 0 : 1;
		const exceedsBatchLimit =
			currentBatch.length === MAX_QUEUE_BATCH_MESSAGES || currentBatchBytes + separatorBytes + requestBytes > MAX_QUEUE_BATCH_BYTES;
		if (exceedsBatchLimit) {
			batches.push(currentBatch);
			currentBatch = [];
			currentBatchBytes = 2;
		}

		currentBatch.push(request);
		currentBatchBytes += (currentBatch.length === 1 ? 0 : 1) + requestBytes;
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}

	return batches;
}

async function listAllKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;

	do {
		const result = await kv.list({ prefix, cursor });
		for (const key of result.keys) {
			keys.push(key.name);
		}
		cursor = result.list_complete ? undefined : result.cursor;
	} while (cursor);

	return keys;
}

export default class PushWorker extends WorkerEntrypoint<PushWorkerEnvironment> {
	// ---- Cached VAPID keys (initialized on first use) ----
	private applicationServerKeys: ApplicationServerKeys | undefined;

	private getApplicationServerKeys(): ApplicationServerKeys {
		if (!this.applicationServerKeys) {
			this.applicationServerKeys = importVapidKeyPair(this.env.VAPID_PUBLIC_KEY, this.env.VAPID_PRIVATE_KEY);
		}
		return this.applicationServerKeys;
	}

	// =========================================================================
	// RPC Methods
	// =========================================================================
	async getVapidPublicKey(): Promise<string> {
		return this.env.VAPID_PUBLIC_KEY;
	}
	async registerSubscription(userId: string, subscription: PushSubscriptionInfo): Promise<{ enabled: boolean }> {
		const endpointHash = await this.hashEndpoint(subscription.endpoint);
		const key = `${userId}/${endpointHash}`;
		const preference = await this.getNotificationPreference(userId, subscription.endpoint);
		const enabled = subscription.notificationsEnabled ?? preference?.enabled ?? true;
		const stored: PushSubscriptionInfo = { ...subscription, notificationsEnabled: enabled };
		await this.env.KV_PUSH_SUBSCRIPTION.put(key, JSON.stringify(stored));
		return { enabled };
	}
	async unregisterSubscription(userId: string, endpoint: string): Promise<void> {
		const endpointHash = await this.hashEndpoint(endpoint);
		const key = `${userId}/${endpointHash}`;
		await this.env.KV_PUSH_SUBSCRIPTION.delete(key);
	}
	async getNotificationPreference(userId: string, endpoint: string): Promise<{ enabled: boolean } | undefined> {
		const endpointHash = await this.hashEndpoint(endpoint);
		const key = `${userId}/${endpointHash}`;
		const raw = await this.env.KV_PUSH_SUBSCRIPTION.get(key);
		if (!raw) return undefined;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (
				!parsed ||
				typeof parsed !== 'object' ||
				!('endpoint' in parsed) ||
				typeof parsed.endpoint !== 'string' ||
				!parsed.endpoint ||
				!('key' in parsed) ||
				typeof parsed.key !== 'string' ||
				!parsed.key ||
				!('auth' in parsed) ||
				typeof parsed.auth !== 'string' ||
				!parsed.auth
			)
				return undefined;
			// Legacy subscriptions without a preference remain enabled.
			return { enabled: !('notificationsEnabled' in parsed) || parsed.notificationsEnabled !== false };
		} catch {
			return undefined;
		}
	}
	async setNotificationPreference(userId: string, endpoint: string, enabled: boolean): Promise<void> {
		const endpointHash = await this.hashEndpoint(endpoint);
		const key = `${userId}/${endpointHash}`;
		const raw = await this.env.KV_PUSH_SUBSCRIPTION.get(key);
		if (!raw) return;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed === 'object' && parsed !== null && 'endpoint' in parsed && 'key' in parsed && 'auth' in parsed) {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validated above
				const existing = parsed as PushSubscriptionInfo;
				const updated = { ...existing, notificationsEnabled: enabled };
				await this.env.KV_PUSH_SUBSCRIPTION.put(key, JSON.stringify(updated));
			}
		} catch {
			// Invalid JSON — ignore
		}
	}
	async notifyUser(userId: string, notification: PushNotification): Promise<void> {
		const message: PushQueueMessage = {
			userId,
			notification,
			timestamp: Date.now(),
		};
		const targetQueue = notification.urgency === 'high' && this.env.PUSH_HIGH_QUEUE ? this.env.PUSH_HIGH_QUEUE : this.env.PUSH_QUEUE;
		await targetQueue.send(message);
	}

	async notifyUsers(userIds: string[], notification: PushNotification): Promise<void> {
		const timestamp = Date.now();
		const targetQueue = notification.urgency === 'high' && this.env.PUSH_HIGH_QUEUE ? this.env.PUSH_HIGH_QUEUE : this.env.PUSH_QUEUE;
		for (const batch of createQueueBatches(userIds, notification, timestamp)) {
			await targetQueue.sendBatch(batch);
		}
	}

	// =========================================================================
	// Queue Consumer
	// =========================================================================

	async queue(batch: MessageBatch<PushQueueMessage>): Promise<void> {
		const applicationServerKeys = this.getApplicationServerKeys();

		// Collect unique user IDs
		const uniqueUserIds = new Set<string>();
		for (const message of batch.messages) {
			uniqueUserIds.add(message.body.userId);
		}

		// Batch-load subscriptions per user
		const userSubscriptions = new Map<string, Array<{ key: string; subscription: PushSubscriptionInfo }>>();
		await Promise.all(
			[...uniqueUserIds].map(async (userId) => {
				const keys = await listAllKeys(this.env.KV_PUSH_SUBSCRIPTION, `${userId}/`);
				const subscriptions: Array<{ key: string; subscription: PushSubscriptionInfo }> = [];

				await Promise.all(
					keys.map(async (kvKey) => {
						const raw = await this.env.KV_PUSH_SUBSCRIPTION.get(kvKey);
						if (!raw) return;
						try {
							const parsed: unknown = JSON.parse(raw);
							if (typeof parsed === 'object' && parsed !== null && 'endpoint' in parsed && 'key' in parsed && 'auth' in parsed) {
								// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validated above
								subscriptions.push({ key: kvKey, subscription: parsed as PushSubscriptionInfo });
							}
						} catch {
							// Invalid JSON — delete the key
							this.ctx.waitUntil(this.env.KV_PUSH_SUBSCRIPTION.delete(kvKey));
						}
					}),
				);

				userSubscriptions.set(userId, subscriptions);
			}),
		);

		// Send notifications — collect results per subscription, then make a
		// single ack/retry decision per message to avoid calling both on the
		// same queue message when a user has multiple push subscriptions.
		await Promise.all(
			batch.messages.map(async (message) => {
				const { userId, notification, timestamp } = message.body;
				const subscriptions = userSubscriptions.get(userId);

				if (!subscriptions || subscriptions.length === 0) {
					message.ack();
					return;
				}

				const { tag, title, body, path, deepLink, data } = notification;
				const payload = JSON.stringify({ tag, userId, timestamp, title, body, path, deepLink, data });

				let anySucceeded = false;
				let anyRetryableError = false;

				await Promise.all(
					subscriptions
						.filter(({ subscription }) => subscription.notificationsEnabled !== false)
						.map(async ({ key, subscription }) => {
							try {
								const { result, response } = await sendNotification(
									subscription,
									this.env.VAPID_SUBJECT,
									applicationServerKeys,
									payload,
									notification,
								);

								switch (result) {
									case WebPushResult.SUCCESS: {
										anySucceeded = true;
										break;
									}
									case WebPushResult.NOT_SUBSCRIBED: {
										console.log(`Invalid subscription, deleting: ${key}`);
										this.ctx.waitUntil(this.env.KV_PUSH_SUBSCRIPTION.delete(key));
										break;
									}
									case WebPushResult.ERROR: {
										console.error(`Web Push error: ${response.status} body: ${await response.text()}`);
										anyRetryableError = true;
										break;
									}
									// no default
								}
							} catch (error) {
								console.error('Error sending push notification', error);
								anyRetryableError = true;
							}
						}),
				);

				// Ack if at least one subscription received the notification
				// successfully, or if all subscriptions were invalid/expired.
				// Retry only if no subscription succeeded and there was a
				// retryable error (and we haven't exhausted attempts).
				if (anySucceeded || !anyRetryableError) {
					message.ack();
				} else if (message.attempts > 5) {
					console.error(`Push notification failed after 5 attempts for user ${userId}`);
					message.ack();
				} else {
					message.retry({ delaySeconds: 5 });
				}
			}),
		);
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private async hashEndpoint(endpoint: string): Promise<string> {
		const data = new TextEncoder().encode(endpoint);
		const hash = await crypto.subtle.digest('SHA-256', data);
		return [...new Uint8Array(hash)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
			.slice(0, 16);
	}
}
