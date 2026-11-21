import {
	rowsFromFrame,
	SqlitePatchStore,
	type DocumentStore,
	type PatchStore,
	type SqliteCompactCursor,
	type SqliteConnection,
	type StoredPatchRow,
} from "pulsify-core/storage";
import {
	isCloudRole,
	rootOf,
	type CloudGrant,
	type CloudReceivedRange,
	type CloudRole,
	type CloudSnapshot,
} from "pulsify-cloud";

/** A stored subscription of a connection to one document, with the role it was told. */
export type CloudSubscription = {
	readonly connection: string;
	readonly docId: string;
	readonly role: CloudRole;
};
/** A stored descendant watch of a connection on a prefix (`prefix/…`). */
export type CloudWatch = {
	readonly connection: string;
	readonly prefix: string;
};
export type CloudUsage = { documents: number; rows: number; bytes: number };
/** A snapshot as it is stored: its description, and frames a client applies. */
export type StoredSnapshot = Omit<CloudSnapshot, "docId">;

/**
 * Everything one root persists. Patch rows use the shared Pulsify stores;
 * grants are the root's access table. Subscriptions live with their socket
 * (`CloudPeer.keepSubscriptions`); only those that do not fit there are stored,
 * to survive a host that evicts the root while its sockets stay open (Durable
 * Object hibernation).
 */
export interface CloudRootStorage {
	readonly patches: DocumentStore;
	isDeleted(docId: string): Promise<boolean>;
	loadGrants(): Promise<CloudGrant[]>;
	putGrant(grant: CloudGrant): Promise<void>;
	deleteGrant(subject: string, prefix: string): Promise<boolean>;
	loadSubscriptions(): Promise<CloudSubscription[]>;
	saveSubscription(subscription: CloudSubscription): Promise<void>;
	deleteSubscription(connection: string, docId: string): Promise<void>;
	loadWatches?(): Promise<CloudWatch[]>;
	saveWatch?(watch: CloudWatch): Promise<void>;
	deleteWatch?(connection: string, prefix: string): Promise<void>;
	deleteConnection(connection: string): Promise<void>;
	/**
	 * Erase a document and its sub-documents (`docId/…`): their rows and the
	 * grants on them. Resolves to how many documents had rows.
	 */
	deleteDocuments(docId: string): Promise<number>;
	usage(): Promise<CloudUsage>;
	/**
	 * Bind each actor to `subject`, for good, unless an account has it
	 * already. Resolves to the actors that another account has.
	 */
	claimActors(subject: string, actors: readonly number[]): Promise<number[]>;
	/** The account each of these actors is bound to; unbound ones are absent. */
	actorSubjects(actors: readonly number[]): Promise<Map<number, string>>;
	/**
	 * The patch store as one account writes it: the rows an append adds are
	 * recorded as received from `subject` in the same commit, and a refused
	 * append records nothing. Rows the store already holds keep the account
	 * they were first received from.
	 */
	receivedFrom(subject: string): PatchStore;
	/** Which account each run of a document's writes was received from. */
	received(docId: string): Promise<CloudReceivedRange[]>;
	/** Since `cloud.expire`: how long the root may stay without sockets before it is erased. */
	expiry?(): Promise<number | undefined>;
	setExpiry?(idleMs: number): Promise<void>;
	/**
	 * Snapshots of a document: copies of its rows, as frames no larger than a
	 * row a host stores (a Durable Object stops at 2 MB). Erased with the
	 * document. A storage without them answers `BAD_REQUEST`.
	 *
	 * A snapshot saved without frames is its version alone: the rows below it
	 * are read from the document. `loadSnapshot` then resolves to an empty
	 * list, and to undefined for an unknown snapshot.
	 */
	saveSnapshot?(
		docId: string,
		snapshot: StoredSnapshot,
		/** Read once, a frame at a time: they need not all be in memory. */
		frames: Iterable<Uint8Array>,
	): Promise<void>;
	listSnapshots?(docId: string, since?: number): Promise<StoredSnapshot[]>;
	loadSnapshot?(docId: string, id: string): Promise<Uint8Array[] | undefined>;
	deleteSnapshot?(docId: string, id: string): Promise<boolean>;
	/**
	 * Whether no write of the document has replaced another so far: its rows
	 * are then kept as they are, and a version is enough to find them again.
	 */
	keepsEveryRow?(docId: string): Promise<boolean>;
	/**
	 * Pack the history of the root's documents so that loading them reads few
	 * rows, a bounded amount of work per call. Resolves to what to pass to the
	 * next call, or to undefined once nothing is left. Clients see no
	 * difference; the host decides when, typically once the root is idle.
	 */
	compact?(resume?: unknown): Promise<unknown>;
}

/** Tables added next to the patch schema in a root's own SQLite database. */
export const CLOUD_SQLITE_SCHEMA: string = `
CREATE TABLE IF NOT EXISTS pulsify_cloud_grants (
 subject TEXT NOT NULL, prefix TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('reader','editor','owner')),
 PRIMARY KEY(subject, prefix)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pulsify_cloud_subscriptions (
 connection TEXT NOT NULL, doc_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('reader','editor','owner')),
 PRIMARY KEY(connection, doc_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pulsify_cloud_watches (
 connection TEXT NOT NULL, prefix TEXT NOT NULL,
 PRIMARY KEY(connection, prefix)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pulsify_cloud_expiry (
 id INTEGER PRIMARY KEY CHECK(id = 1), idle_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pulsify_cloud_snapshots (
 doc_id TEXT NOT NULL, id TEXT NOT NULL, time INTEGER NOT NULL,
 label TEXT, subject TEXT, version TEXT NOT NULL,
 PRIMARY KEY(doc_id, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pulsify_cloud_actors (
 sid INTEGER PRIMARY KEY, subject TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pulsify_cloud_received (
 doc_id TEXT NOT NULL, sid INTEGER NOT NULL, clock INTEGER NOT NULL,
 clock_end INTEGER NOT NULL, subject TEXT NOT NULL,
 PRIMARY KEY(doc_id, sid, clock)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pulsify_cloud_snapshot_frames (
 doc_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
 frame BLOB NOT NULL,
 PRIMARY KEY(doc_id, id, seq)
);
`;

/** One SQLite database per root, as in a Durable Object. */
export class SqliteCloudStorage implements CloudRootStorage {
	readonly patches: SqlitePatchStore;
	constructor(private readonly db: SqliteConnection) {
		// A root is the only writer of its database: vectors can stay in memory.
		this.patches = new SqlitePatchStore(db, { vectorCacheSize: 128 });
		db.exec(CLOUD_SQLITE_SCHEMA);
	}
	async isDeleted(docId: string): Promise<boolean> {
		return this.patches.isDeleted(docId);
	}
	async loadGrants(): Promise<CloudGrant[]> {
		return (
			this.db
				.query("SELECT subject, prefix, role FROM pulsify_cloud_grants")
				.all() as CloudGrant[]
		).filter((grant) => isCloudRole(grant.role));
	}
	async putGrant(grant: CloudGrant): Promise<void> {
		this.db
			.query(
				"INSERT INTO pulsify_cloud_grants(subject, prefix, role) VALUES(?, ?, ?) ON CONFLICT(subject, prefix) DO UPDATE SET role = excluded.role",
			)
			.run(grant.subject, grant.prefix, grant.role);
	}
	async deleteGrant(subject: string, prefix: string): Promise<boolean> {
		const existing = this.db
			.query(
				"SELECT 1 AS found FROM pulsify_cloud_grants WHERE subject = ? AND prefix = ?",
			)
			.get(subject, prefix);
		if (!existing) return false;
		this.db
			.query(
				"DELETE FROM pulsify_cloud_grants WHERE subject = ? AND prefix = ?",
			)
			.run(subject, prefix);
		return true;
	}
	async loadSubscriptions(): Promise<CloudSubscription[]> {
		return (
			this.db
				.query(
					"SELECT connection, doc_id, role FROM pulsify_cloud_subscriptions",
				)
				.all() as { connection: string; doc_id: string; role: CloudRole }[]
		).map(({ connection, doc_id, role }) => ({
			connection,
			docId: doc_id,
			role,
		}));
	}
	async saveSubscription({
		connection,
		docId,
		role,
	}: CloudSubscription): Promise<void> {
		this.db
			.query(
				"INSERT INTO pulsify_cloud_subscriptions(connection, doc_id, role) VALUES(?, ?, ?) ON CONFLICT(connection, doc_id) DO UPDATE SET role = excluded.role",
			)
			.run(connection, docId, role);
	}
	async deleteSubscription(connection: string, docId: string): Promise<void> {
		this.db
			.query(
				"DELETE FROM pulsify_cloud_subscriptions WHERE connection = ? AND doc_id = ?",
			)
			.run(connection, docId);
	}
	async loadWatches(): Promise<CloudWatch[]> {
		return this.db
			.query("SELECT connection, prefix FROM pulsify_cloud_watches")
			.all() as CloudWatch[];
	}
	async saveWatch({ connection, prefix }: CloudWatch): Promise<void> {
		this.db
			.query(
				"INSERT OR IGNORE INTO pulsify_cloud_watches(connection, prefix) VALUES(?, ?)",
			)
			.run(connection, prefix);
	}
	async deleteWatch(connection: string, prefix: string): Promise<void> {
		this.db
			.query(
				"DELETE FROM pulsify_cloud_watches WHERE connection = ? AND prefix = ?",
			)
			.run(connection, prefix);
	}
	async deleteConnection(connection: string): Promise<void> {
		this.db
			.query("DELETE FROM pulsify_cloud_subscriptions WHERE connection = ?")
			.run(connection);
		this.db
			.query("DELETE FROM pulsify_cloud_watches WHERE connection = ?")
			.run(connection);
	}
	async deleteDocuments(docId: string): Promise<number> {
		// Commit the tombstone before removing grants or notifying clients.
		const count = await this.patches.deleteDocuments(docId);
		this.db
			.query(
				"DELETE FROM pulsify_cloud_grants WHERE prefix = ? OR (prefix >= ? AND prefix < ?)",
			)
			.run(docId, `${docId}/`, `${docId}0`);
		for (const table of ["snapshots", "snapshot_frames", "received"])
			this.db
				.query(
					`DELETE FROM pulsify_cloud_${table} WHERE doc_id = ? OR (doc_id >= ? AND doc_id < ?)`,
				)
				.run(docId, `${docId}/`, `${docId}0`);
		// Actors belong to the root: they go with its last document.
		if (rootOf(docId) === docId)
			this.db.query("DELETE FROM pulsify_cloud_actors").run();
		return count;
	}
	async claimActors(
		subject: string,
		actors: readonly number[],
	): Promise<number[]> {
		const claim = this.db.query(
			"INSERT OR IGNORE INTO pulsify_cloud_actors(sid, subject) VALUES(?, ?)",
		);
		const owner = this.db.query(
			"SELECT subject FROM pulsify_cloud_actors WHERE sid = ?",
		);
		return this.db.transaction(() =>
			actors.filter((sid) => {
				claim.run(sid, subject);
				return (owner.get(sid) as { subject: string }).subject !== subject;
			}),
		)();
	}
	async actorSubjects(actors: readonly number[]): Promise<Map<number, string>> {
		// One JSON parameter: a Durable Object binds at most 100 values.
		return new Map(
			(
				this.db
					.query(
						"SELECT sid, subject FROM pulsify_cloud_actors WHERE sid IN (SELECT value FROM json_each(?)) ORDER BY sid",
					)
					.all(JSON.stringify(actors)) as { sid: number; subject: string }[]
			).map(({ sid, subject }) => [Number(sid), subject]),
		);
	}
	receivedFrom(subject: string): PatchStore {
		const { patches } = this;
		const append = (rows: readonly StoredPatchRow[]) =>
			patches.append(rows, (added) => this.record(subject, added));
		return {
			append,
			appendEncoded: async (frame) => append(rowsFromFrame(frame)),
			vector: (docId) => patches.vector(docId),
			missing: (docId, remote) => patches.missing(docId, remote),
		};
	}
	/**
	 * Inside an append: note that these rows, new to one document, came from
	 * `subject`. Runs that follow each other are one range, so a client that
	 * uploads as it writes costs one row per actor and document.
	 */
	private record(subject: string, rows: readonly StoredPatchRow[]): void {
		const docId = rows[0]!.docId;
		const before = this.db.query(
			"SELECT clock FROM pulsify_cloud_received WHERE doc_id = ? AND sid = ? AND clock_end = ? AND subject = ?",
		);
		const extend = this.db.query(
			"UPDATE pulsify_cloud_received SET clock_end = ? WHERE doc_id = ? AND sid = ? AND clock = ?",
		);
		// Never over a range that is there: a write keeps its first sender.
		const insert = this.db.query(
			"INSERT OR IGNORE INTO pulsify_cloud_received(doc_id, sid, clock, clock_end, subject) VALUES(?, ?, ?, ?, ?)",
		);
		const sorted = [...rows].sort((a, b) => a.sid - b.sid || a.clock - b.clock);
		for (let index = 0; index < sorted.length;) {
			const { sid, clock } = sorted[index]!;
			let end = clock;
			for (
				let row = sorted[index];
				row && row.sid === sid && row.clock <= end;
				row = sorted[++index]
			)
				end = Math.max(end, row.clock + row.span);
			const held = before.get(docId, sid, clock, subject) as {
				clock: number;
			} | null;
			if (held) extend.run(end, docId, sid, held.clock);
			else insert.run(docId, sid, clock, end, subject);
		}
	}
	async received(docId: string): Promise<CloudReceivedRange[]> {
		return (
			this.db
				.query(
					"SELECT sid, clock, clock_end, subject FROM pulsify_cloud_received WHERE doc_id = ? ORDER BY sid, clock",
				)
				.all(docId) as {
				sid: number;
				clock: number;
				clock_end: number;
				subject: string;
			}[]
		).map(({ sid, clock, clock_end, subject }) => ({
			actor: Number(sid),
			clock: Number(clock),
			end: Number(clock_end),
			subject,
		}));
	}
	async saveSnapshot(
		docId: string,
		{ id, time, label, subject, version }: StoredSnapshot,
		frames: Iterable<Uint8Array>,
	): Promise<void> {
		this.db.transaction(() => {
			this.db
				.query(
					"INSERT INTO pulsify_cloud_snapshots(doc_id, id, time, label, subject, version) VALUES(?, ?, ?, ?, ?, ?)",
				)
				.run(
					docId,
					id,
					time,
					label ?? null,
					subject ?? null,
					JSON.stringify(version),
				);
			let seq = 0;
			for (const frame of frames)
				this.db
					.query(
						"INSERT INTO pulsify_cloud_snapshot_frames(doc_id, id, seq, frame) VALUES(?, ?, ?, ?)",
					)
					.run(docId, id, seq++, frame);
		})();
	}
	async listSnapshots(docId: string, since = 0): Promise<StoredSnapshot[]> {
		return (
			this.db
				.query(
					"SELECT id, time, label, subject, version FROM pulsify_cloud_snapshots WHERE doc_id = ? AND time >= ? ORDER BY time, id",
				)
				.all(docId, since) as {
				id: string;
				time: number;
				label: string | null;
				subject: string | null;
				version: string;
			}[]
		).map(({ id, time, label, subject, version }) => ({
			id,
			time: Number(time),
			...(label === null ? {} : { label }),
			...(subject === null ? {} : { subject }),
			version: JSON.parse(version),
		}));
	}
	async loadSnapshot(
		docId: string,
		id: string,
	): Promise<Uint8Array[] | undefined> {
		const frames = this.db
			.query(
				"SELECT frame FROM pulsify_cloud_snapshot_frames WHERE doc_id = ? AND id = ? ORDER BY seq",
			)
			.all(docId, id) as { frame: Uint8Array | ArrayBuffer }[];
		if (frames.length) return frames.map(({ frame }) => new Uint8Array(frame));
		return this.db
			.query(
				"SELECT 1 AS found FROM pulsify_cloud_snapshots WHERE doc_id = ? AND id = ?",
			)
			.get(docId, id)
			? []
			: undefined;
	}
	async keepsEveryRow(docId: string): Promise<boolean> {
		// A register without history keeps its last write there, and nowhere
		// else: a document without any has only rows that are never replaced.
		return !this.db
			.query("SELECT 1 AS found FROM pulsify_values WHERE doc_id = ? LIMIT 1")
			.get(docId);
	}
	async deleteSnapshot(docId: string, id: string): Promise<boolean> {
		const found = this.db
			.query(
				"SELECT 1 AS found FROM pulsify_cloud_snapshots WHERE doc_id = ? AND id = ?",
			)
			.get(docId, id);
		for (const table of ["snapshots", "snapshot_frames"])
			this.db
				.query(`DELETE FROM pulsify_cloud_${table} WHERE doc_id = ? AND id = ?`)
				.run(docId, id);
		return !!found;
	}
	async expiry(): Promise<number | undefined> {
		const row = this.db
			.query("SELECT idle_ms FROM pulsify_cloud_expiry")
			.get() as { idle_ms: number } | null;
		return row ? Number(row.idle_ms) : undefined;
	}
	async setExpiry(idleMs: number): Promise<void> {
		this.db
			.query("INSERT OR REPLACE INTO pulsify_cloud_expiry VALUES (1, ?)")
			.run(idleMs);
	}
	async compact(resume?: unknown): Promise<SqliteCompactCursor | undefined> {
		const { next } = await this.patches.compact({
			after: resume as SqliteCompactCursor | undefined,
		});
		return next;
	}
	async usage(): Promise<CloudUsage> {
		const row = this.db
			.query(
				"SELECT COUNT(DISTINCT doc_id) AS documents, COUNT(*) AS rows, COALESCE(SUM(length(operations)), 0) AS bytes FROM (SELECT doc_id, operations FROM pulsify_op_rows UNION ALL SELECT doc_id, operations FROM pulsify_values)",
			)
			.get() as { documents: number; rows: number; bytes: number };
		const snapshots = this.db
			.query(
				"SELECT COALESCE(SUM(length(frame)), 0) AS bytes FROM pulsify_cloud_snapshot_frames",
			)
			.get() as { bytes: number };
		return {
			documents: Number(row.documents),
			rows: Number(row.rows),
			// Snapshots are stored bytes like any other, and no document's rows.
			bytes: Number(row.bytes) + Number(snapshots.bytes),
		};
	}
}
