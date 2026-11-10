export function initializeReviewStorage(storage: DurableObjectStorage): void {
	storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session_pending_changes (
				session_id TEXT PRIMARY KEY NOT NULL,
				data TEXT DEFAULT '{}' NOT NULL
			)
		`);
	storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session_pending_change_index (
				session_id TEXT NOT NULL,
				path TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				latest_change_set_id TEXT,
				PRIMARY KEY(session_id, path)
			)
		`);
	storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS change_sets (
				id TEXT PRIMARY KEY NOT NULL,
				session_id TEXT NOT NULL,
				snapshot_id TEXT,
				created_at INTEGER NOT NULL
			)
		`);
	storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS change_set_files (
				change_set_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				path TEXT NOT NULL,
				action TEXT NOT NULL,
				before_content TEXT,
				after_content TEXT,
				snapshot_id TEXT,
				PRIMARY KEY(change_set_id, path)
			)
		`);
	storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS review_entries (
				id TEXT PRIMARY KEY NOT NULL,
				path TEXT NOT NULL,
				action TEXT NOT NULL,
				before_content TEXT,
				after_content TEXT,
				snapshot_id TEXT,
				status TEXT DEFAULT 'pending' NOT NULL,
				hunk_statuses TEXT DEFAULT '[]' NOT NULL,
				latest_session_id TEXT NOT NULL,
				session_ids TEXT DEFAULT '[]' NOT NULL,
				diff_signature TEXT DEFAULT '' NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
	storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS review_entry_sources (
				review_entry_id TEXT NOT NULL,
				change_set_id TEXT NOT NULL,
				order_index INTEGER NOT NULL,
				PRIMARY KEY(review_entry_id, change_set_id)
			)
		`);
	storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS review_resolutions (
				id TEXT PRIMARY KEY NOT NULL,
				review_entry_id TEXT NOT NULL,
				decision TEXT NOT NULL,
				hunk_statuses TEXT DEFAULT '[]' NOT NULL,
				resolved_at INTEGER NOT NULL
			)
		`);
	storage.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS review_entries_path_idx ON review_entries (path)');
}
