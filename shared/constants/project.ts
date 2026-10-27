/**
 * Number of days since creation after which an unused project is auto soft-deleted
 * by the daily cron job.
 */
export const PROJECT_INACTIVITY_DAYS = 365;
export const SOFT_DELETE_RETENTION_DAYS = 30;
export const MAX_PROJECT_NAME_LENGTH = 60;

/**
 * Maximum number of AI sessions retained per project.
 * Older sessions beyond this limit are pruned automatically.
 */
export const MAX_AI_SESSIONS_PER_PROJECT = 50;

/**
 * Cloudflare Workers compatibility date used for user-deployed workers,
 * preview isolates, and test runners.
 *
 * Keep in sync with the `compatibility_date` values in the wrangler.jsonc files.
 */
export const WORKERS_COMPATIBILITY_DATE = '2026-10-27';
