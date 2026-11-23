import {
	coversDocument,
	documentPrefixes,
	deletedDocument,
} from "./documents.js";
import { PulseError } from "../protocol/errors.js";
import { validateDocId } from "../protocol/validateDocId.js";
import {
	MAX_MESSAGE_ROWS,
	MAX_PATCH_BYTES,
	MAX_ROW_BATCH_NODES,
	MAX_VECTOR_ENTRIES,
} from "../protocol/limits.js";
import {
	validateVector,
	type PulseVersionVector,
} from "../connection/PulseVersionVector.js";
import { GAP_OPERATIONS, isGap, lastRegisterOf } from "../core/operations.js";
import { rowDependencies, rowOperations } from "../protocol/scalarRuns.js";
import {
	covered,
	decodePackedRows,
	encodePackedRow,
	MAX_PACKED_BYTES,
	ownClock,
	rowsFromFrame,
	validateRows,
	type AppendResult,
	type DocumentStore,
	type MissingPage,
	type MissingPageOptions,
	type StoredPatchRow,
} from "./rows.js";

export type SqliteBinding = string | number | Uint8Array | null;
export interface SqliteStatement {
	run(...bindings: SqliteBinding[]): unknown;
	get(...bindings: SqliteBinding[]): unknown;
	all(...bindings: SqliteBinding[]): unknown[];
}
/** Structural interface implemented by bun:sqlite and easily adapted to other drivers. */
export interface SqliteConnection {
	exec(sql: string): unknown;
	query(sql: string): SqliteStatement;
	transaction<T>(work: () => T): (() => T) & { immediate(): T };
}
type RecordRow = {
	doc_id: string;
	sid: number;
	time_start: number;
	span: number;
	dependencies: string;
	operations: Uint8Array;
	packed: number;
	ready: number;
};
/** An actor's newest write to a register without history. */
type ValueRow = {
	doc_id: string;
	sid: number;
	clock: number;
	dependencies: string;
	operations: Uint8Array;
};
type ScanMissingOpRow = Omit<RecordRow, "operations"> & {
	bytes: number;
	operations: Uint8Array | null;
};
type ScanMissingValueRow = Omit<ValueRow, "operations"> & {
	register: Uint8Array;
	bytes: number;
	operations: Uint8Array | null;
};
type CandidateRow = {
	clock: number;
	dependencies: PulseVersionVector;
	bytes: number;
	operations: Uint8Array | null;
	register?: Uint8Array;
};
type SqliteMissingCursor = {
	sid: number;
	from: number;
	straddle: boolean;
	vv: PulseVersionVector;
};
const MISSING_SCAN_BATCH = 128;
const MISSING_INLINE_BYTES = 16 * 1024;
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, i) => b[i] === byte);
const copyVector = (vector: PulseVersionVector): PulseVersionVector =>
	vector.map(([sid, clock]) => [sid, clock]);
function unpack(row: RecordRow): StoredPatchRow {
	return {
		docId: row.doc_id,
		sid: row.sid,
		clock: row.time_start,
		span: row.span,
		dependencies: JSON.parse(row.dependencies) as PulseVersionVector,
		operations: new Uint8Array(row.operations),
	};
}
/** The rows a stored row stands for: itself, or those packed inside it. */
function unpackAll(row: RecordRow): StoredPatchRow[] {
	if (!row.packed) return [unpack(row)];
	const rows = decodePackedRows(
		row.doc_id,
		row.sid,
		row.time_start,
		new Uint8Array(row.operations),
	);
	const last = rows.at(-1);
	if (!last || last.clock + last.span !== row.time_start + row.span)
		throw new PulseError("INVALID_MESSAGE", "Corrupt packed segment");
	return rows;
}

export const SQLITE_PATCH_SCHEMA: string = `
CREATE TABLE IF NOT EXISTS pulsify_tombstones (prefix TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pulsify_op_rows (
 doc_id TEXT NOT NULL, sid INTEGER NOT NULL, time_start INTEGER NOT NULL,
 span INTEGER NOT NULL CHECK(span > 0), time_end INTEGER GENERATED ALWAYS AS (time_start + span) STORED,
 dependencies TEXT NOT NULL, operations BLOB NOT NULL, ready INTEGER NOT NULL DEFAULT 0,
 packed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(doc_id, sid, time_start)
) WITHOUT ROWID;
DROP INDEX IF EXISTS pulsify_rows_frontier;
CREATE INDEX IF NOT EXISTS pulsify_rows_pending ON pulsify_op_rows(doc_id) WHERE ready = 0;
CREATE TABLE IF NOT EXISTS pulsify_doc_clocks (
 doc_id TEXT NOT NULL, sid INTEGER NOT NULL, clock INTEGER NOT NULL,
 PRIMARY KEY(doc_id, sid)
) WITHOUT ROWID;
CREATE VIEW IF NOT EXISTS pulsify_dangling_op_rows AS SELECT * FROM pulsify_op_rows WHERE ready = 0;
CREATE TABLE IF NOT EXISTS pulsify_values (
 doc_id TEXT NOT NULL, sid INTEGER NOT NULL, register BLOB NOT NULL, clock INTEGER NOT NULL,
 dependencies TEXT NOT NULL, operations BLOB NOT NULL,
 PRIMARY KEY(doc_id, sid, register)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pulsify_values_clock ON pulsify_values(doc_id, sid, clock);
`;

/**
 * Moves the last-value rows of a database written by an unreleased layout,
 * which indexed them in `pulsify_registers`, to `pulsify_values`. Its gap
 * rows are holes now: the frontier says how far the actor goes.
 */
export const SQLITE_REGISTERS_MIGRATION: string = `
INSERT OR REPLACE INTO pulsify_values(doc_id,sid,register,clock,dependencies,operations)
 SELECT o.doc_id,o.sid,r.register,o.time_start,o.dependencies,o.operations FROM pulsify_registers r
 JOIN pulsify_op_rows o ON o.doc_id=r.doc_id AND o.sid=r.sid AND o.time_start=r.clock
 WHERE o.ready=1 AND o.packed=0;
DELETE FROM pulsify_op_rows WHERE ready=1 AND packed=0 AND (operations=X'03010000' OR EXISTS(
 SELECT 1 FROM pulsify_registers r WHERE r.doc_id=pulsify_op_rows.doc_id AND r.sid=pulsify_op_rows.sid
 AND r.clock=pulsify_op_rows.time_start));
DROP TABLE pulsify_registers;
`;

/** Added to a `pulsify_op_rows` table created before packed segments existed. */
export const SQLITE_PACKED_MIGRATION: string =
	"ALTER TABLE pulsify_op_rows ADD COLUMN packed INTEGER NOT NULL DEFAULT 0";

/** Where a compaction stopped: the key of the last stored row it looked at. */
export type SqliteCompactCursor = readonly [
	docId: string,
	sid: number,
	clock: number,
];
export type SqliteCompactOptions = {
	/** Resume after this position, as returned by the previous call. */
	after?: SqliteCompactCursor | undefined;
	/** Stored rows read by this call, in one transaction. Default 4096. */
	maxRows?: number;
	/** Leave alone a run of fewer unpacked rows of one actor. Default 64. */
	minRows?: number;
};
export type SqliteCompactResult = {
	/** Rows that were folded into packed segments. */
	rows: number;
	/** Packed segments created or extended. */
	segments: number;
	/** Pass as `after` to continue; undefined once every row has been seen. */
	next: SqliteCompactCursor | undefined;
};
type ScanRow = Omit<RecordRow, "dependencies" | "operations"> & {
	ready: number;
	bytes: number;
	dependencies: string | null;
	operations: Uint8Array | null;
};
/** Bytes folded by one compaction call before it stops, whatever `maxRows` is. */
const COMPACT_CALL_BYTES = 16 * MAX_PACKED_BYTES;
/** Operations up to this size come with the scan; larger ones are read when packed. */
const COMPACT_INLINE_BYTES = 4096;

export type SqlitePatchStoreOptions = {
	/**
	 * Keep the version vectors of up to this many documents in memory, so
	 * appends and `vector` stop reading them back. Enable it only when this
	 * store is the single writer of its database, as in a Durable Object.
	 */
	vectorCacheSize?: number;
};

/** Writes only indexed operation metadata and opaque bytes; never materializes a document. */
export class SqlitePatchStore implements DocumentStore {
	private readonly vectors = new Map<string, PulseVersionVector>();
	private readonly vectorCacheSize: number;
	constructor(
		private readonly db: SqliteConnection,
		{ vectorCacheSize = 0 }: SqlitePatchStoreOptions = {},
	) {
		// Skip DDL and migration checks when the schema is already current.
		const objects = db
			.query(
				"SELECT name, sql FROM sqlite_master WHERE name IN ('pulsify_tombstones','pulsify_op_rows','pulsify_doc_clocks','pulsify_values','pulsify_dangling_op_rows','pulsify_rows_pending','pulsify_values_clock','pulsify_rows_frontier','pulsify_registers')",
			)
			.all() as { name: string; sql: string | null }[];
		const current =
			objects.length === 7 &&
			objects.every(
				({ name, sql }) =>
					name !== "pulsify_rows_frontier" &&
					name !== "pulsify_registers" &&
					(name !== "pulsify_op_rows" ||
						(sql !== null && /\bpacked\b/.test(sql))),
			);
		if (!current) {
			db.exec(SQLITE_PATCH_SCHEMA);
			// CREATE TABLE IF NOT EXISTS leaves an older table as it is.
			const packed = () =>
				/\bpacked\b/.test(
					(
						db
							.query(
								"SELECT sql FROM sqlite_master WHERE type='table' AND name='pulsify_op_rows'",
							)
							.get() as { sql: string }
					).sql,
				);
			if (!packed())
				try {
					db.exec(SQLITE_PACKED_MIGRATION);
				} catch (error) {
					// Another process that opened the file at the same time added it.
					if (!packed()) throw error;
				}
			const registers =
				"SELECT 1 FROM sqlite_master WHERE type='table' AND name='pulsify_registers'";
			if (db.query(registers).get())
				db.transaction(() => {
					// Another process may have moved them first.
					if (db.query(registers).get()) db.exec(SQLITE_REGISTERS_MIGRATION);
				}).immediate();
		}
		this.vectorCacheSize = vectorCacheSize;
	}
	async appendEncoded(frame: Uint8Array): Promise<AppendResult> {
		return this.append(rowsFromFrame(frame));
	}
	/**
	 * `added` is called inside the transaction, with the rows that were not
	 * held before, neither applied nor waiting: what it writes to the same
	 * database commits with them, and what it throws rolls them back. A row
	 * sent again is never among them.
	 */
	async append(
		rows: readonly StoredPatchRow[],
		added?: (rows: readonly StoredPatchRow[]) => void,
	): Promise<AppendResult> {
		return this.appendRows(rows, false, added);
	}
	private appendRows(
		rows: readonly StoredPatchRow[],
		recovery = false,
		added?: (rows: readonly StoredPatchRow[]) => void,
	): AppendResult {
		const docId = validateRows(rows);
		if (docId === undefined) return { inserted: 0, ready: 0, pending: 0 };
		const result = this.db
			.transaction(() => {
				if (!recovery) this.assertLive(docId);
				const get = this.db.query(
					"SELECT * FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start=?",
				);
				const after = this.db.query(
					"SELECT dependencies FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start>=? ORDER BY time_start LIMIT 1",
				);
				const insert = this.db.query(
					"INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready) VALUES(?,?,?,?,?,?,?)",
				);
				const frontier = new Map(
					this.vectors.get(docId) ?? this.readVector(docId),
				);
				// Pending rows are checked through the covering partial index without
				// reading or parsing every pending row on every append.
				const hasPendingStmt = this.db.query(
					"SELECT 1 FROM pulsify_op_rows INDEXED BY pulsify_rows_pending WHERE doc_id=? AND ready=0 LIMIT 1",
				);
				const actorPendingStmt = this.db.query(
					"SELECT 1 FROM pulsify_op_rows INDEXED BY pulsify_rows_pending WHERE doc_id=? AND sid=? AND ready=0 LIMIT 1",
				);
				let hasPending = !!hasPendingStmt.get(docId);
				const actorPending = new Map<number, boolean>();
				const isActorPending = (sid: number): boolean => {
					if (!hasPending) return false;
					let state = actorPending.get(sid);
					if (state === undefined) {
						state = !!actorPendingStmt.get(docId, sid);
						actorPending.set(sid, state);
					}
					return state;
				};
				const changedActors = new Set<number>();
				let inserted = 0,
					ready = 0;
				const fresh: StoredPatchRow[] = [];
				const before = this.db.query(
					"SELECT * FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start<? ORDER BY time_start DESC LIMIT 1",
				);
				const setSpan = this.db.query(
					"UPDATE pulsify_op_rows SET span=? WHERE doc_id=? AND sid=? AND time_start=?",
				);
				const remove = this.db.query(
					"DELETE FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start=?",
				);
				const removeWaiting = this.db.query(
					"DELETE FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND ready=0 AND time_start>=? AND time_start<?",
				);
				const setValue = this.db.query(
					"INSERT INTO pulsify_values(doc_id,sid,register,clock,dependencies,operations) VALUES(?,?,?,?,?,?) ON CONFLICT(doc_id,sid,register) DO UPDATE SET clock=excluded.clock,dependencies=excluded.dependencies,operations=excluded.operations",
				);
				const getValue = this.db.query(
					"SELECT operations FROM pulsify_values WHERE doc_id=? AND sid=? AND clock=? LIMIT 1",
				);
				/** Last decoded packed segment in this batch, so resending a packed run decodes once. */
				let packedSid = -1;
				let packedStart = -1;
				let packedEnd = -1;
				let packedMap: Map<number, Uint8Array> | undefined;
				const cachePacked = (row: RecordRow): Map<number, Uint8Array> => {
					const map = new Map<number, Uint8Array>();
					for (const each of unpackAll(row))
						map.set(each.clock, each.operations);
					packedSid = row.sid;
					packedStart = row.time_start;
					packedEnd = row.time_start + row.span;
					packedMap = map;
					return map;
				};
				/**
				 * Store a ready row: a last-value row as its actor's value of the
				 * register, replacing the older one; a gap row not at all, as the
				 * frontier says how far the actor goes.
				 */
				const keep = (
					sid: number,
					clock: number,
					dependencies: string,
					operations: Uint8Array,
				): boolean => {
					const last = lastRegisterOf(operations);
					if (last) {
						setValue.run(
							docId,
							sid,
							last.register,
							clock,
							dependencies,
							operations,
						);
					}
					return !last && !isGap(operations);
				};
				/** The row held at this sequence number: stored, packed or a value. */
				const heldAt = (sid: number, clock: number): Uint8Array | undefined => {
					if (sid === packedSid && clock >= packedStart && clock < packedEnd) {
						const cached = packedMap!.get(clock);
						if (cached) return cached;
					} else {
						const exact = get.get(docId, sid, clock) as RecordRow | null;
						if (exact)
							return exact.packed
								? cachePacked(exact).get(clock)
								: new Uint8Array(exact.operations);
						const previous = before.get(docId, sid, clock) as RecordRow | null;
						if (
							previous?.packed &&
							clock < previous.time_start + previous.span
						) {
							const cached = cachePacked(previous).get(clock);
							if (cached) return cached;
						}
					}
					const value = getValue.get(docId, sid, clock) as {
						operations: Uint8Array;
					} | null;
					return value ? new Uint8Array(value.operations) : undefined;
				};
				rows: for (const row of rows) {
					const operations = rowOperations(row);
					const deps = rowDependencies(row);
					const reached = frontier.get(row.sid) ?? 1;
					if (row.clock < reached) {
						// Known, or replaced here: only its contents can conflict, and
						// only its span can say that more writes were replaced.
						const held = heldAt(row.sid, row.clock);
						if (
							held &&
							!isGap(held) &&
							!isGap(operations) &&
							!sameBytes(held, operations)
						)
							throw new PulseError("CONFLICT", "Conflicting storage segment");
						const end = row.clock + row.span;
						if (end <= reached) continue;
						// Rows that waited below the new frontier were replaced.
						if (hasPending) {
							removeWaiting.run(docId, row.sid, reached, end);
							actorPending.delete(row.sid);
						}
						frontier.set(row.sid, end);
						changedActors.add(row.sid);
						inserted++;
						continue;
					}
					// A row that is ready on arrival (the common, in-order case) skips the
					// pending index and the promotion UPDATE.
					const readyNow = row.clock === reached && covered(frontier, deps);
					if (readyNow && !isActorPending(row.sid)) {
						// Ready rows of an actor start below the frontier and it has no
						// pending row, so no stored row starts at or after this one: it is
						// neither a duplicate nor overlapping. Only the fork check remains,
						// without reading anything.
						if (row.clock > 1 && ownClock(deps, row.sid) < row.clock)
							throw new PulseError("CONFLICT", "Actor history fork");
					} else {
						const existing = get.get(
							docId,
							row.sid,
							row.clock,
						) as RecordRow | null;
						if (existing) {
							// A waiting row with the same start: only contents conflict.
							const held = new Uint8Array(existing.operations);
							if (
								!isGap(held) &&
								!isGap(operations) &&
								!sameBytes(held, operations)
							)
								throw new PulseError("CONFLICT", "Conflicting storage segment");
							// The longer span knows of more replaced writes.
							if (row.span > existing.span) {
								const end = row.clock + row.span;
								setSpan.run(row.span, docId, row.sid, row.clock);
								// The waiting rows it now covers were replaced.
								removeWaiting.run(docId, row.sid, row.clock + 1, end);
							}
							continue;
						}
						const end = row.clock + row.span;
						const own = ownClock(deps, row.sid);
						const previous = before.get(
							docId,
							row.sid,
							row.clock,
						) as RecordRow | null;
						if (previous) {
							// It starts among the writes a waiting row has replaced.
							if (previous.time_start + previous.span > row.clock)
								continue rows;
							if (own < previous.time_start + previous.span)
								throw new PulseError("CONFLICT", "Actor history fork");
						}
						// The first row past its span builds on it, like the journal checks.
						const next = after.get(docId, row.sid, end) as {
							dependencies: string;
						} | null;
						if (
							next &&
							ownClock(
								JSON.parse(next.dependencies) as PulseVersionVector,
								row.sid,
							) < end
						)
							throw new PulseError("CONFLICT", "Actor history fork");
						// Rows still waiting that this row has replaced.
						if (hasPending) {
							removeWaiting.run(docId, row.sid, row.clock + 1, end);
							actorPending.delete(row.sid);
						}
					}
					const dependencies = JSON.stringify(deps);
					inserted++;
					fresh.push(row);
					if (readyNow) {
						if (keep(row.sid, row.clock, dependencies, operations))
							insert.run(
								docId,
								row.sid,
								row.clock,
								row.span,
								dependencies,
								operations,
								1,
							);
						frontier.set(row.sid, row.clock + row.span);
						changedActors.add(row.sid);
						ready++;
					} else {
						insert.run(
							docId,
							row.sid,
							row.clock,
							row.span,
							dependencies,
							operations,
							0,
						);
						hasPending = true;
						actorPending.set(row.sid, true);
					}
				}
				let pendingCount = 0;
				if (!hasPending) {
					if (frontier.size > MAX_VECTOR_ENTRIES)
						throw new PulseError(
							"LIMIT_EXCEEDED",
							"Document actor limit exceeded",
						);
				} else {
					const nextPendingActor = this.db.query(
						"SELECT sid,time_start FROM pulsify_op_rows INDEXED BY pulsify_rows_pending WHERE doc_id=? AND ready=0 AND sid>? ORDER BY sid,time_start LIMIT 1",
					);
					type PendingHead = {
						time_start: number;
						time_end?: number;
						deps?: PulseVersionVector;
						stored?: RecordRow;
					};
					const heads = new Map<number, PendingHead>();
					let extraActors = 0;
					for (let afterSid = -1; ;) {
						const next = nextPendingActor.get(docId, afterSid) as {
							sid: number;
							time_start: number;
						} | null;
						if (!next) break;
						heads.set(next.sid, { time_start: next.time_start });
						if (!frontier.has(next.sid)) extraActors++;
						afterSid = next.sid;
					}
					if (frontier.size + extraActors > MAX_VECTOR_ENTRIES)
						throw new PulseError(
							"LIMIT_EXCEEDED",
							"Document actor limit exceeded",
						);
					if (changedActors.size && heads.size) {
						const update = this.db.query(
							"UPDATE pulsify_op_rows SET ready=1 WHERE doc_id=? AND sid=? AND time_start=?",
						);
						const nextActorPending = this.db.query(
							"SELECT time_start FROM pulsify_op_rows INDEXED BY pulsify_rows_pending WHERE doc_id=? AND sid=? AND ready=0 AND time_start>? ORDER BY time_start LIMIT 1",
						);
						let changed: boolean;
						do {
							changed = false;
							for (const [sid, head] of [...heads]) {
								let current: PendingHead | undefined = head;
								while (
									current &&
									current.time_start === (frontier.get(sid) ?? 1)
								) {
									if (!current.stored) {
										const stored = get.get(
											docId,
											sid,
											current.time_start,
										) as RecordRow;
										current.stored = stored;
										current.time_end = stored.time_start + stored.span;
										current.deps = JSON.parse(
											stored.dependencies,
										) as PulseVersionVector;
									}
									if (!covered(frontier, current.deps!)) break;
									if (
										keep(
											sid,
											current.time_start,
											current.stored.dependencies,
											new Uint8Array(current.stored.operations),
										)
									)
										update.run(docId, sid, current.time_start);
									else remove.run(docId, sid, current.time_start);
									frontier.set(
										sid,
										Math.max(frontier.get(sid) ?? 0, current.time_end!),
									);
									changedActors.add(sid);
									ready++;
									changed = true;
									const next = nextActorPending.get(
										docId,
										sid,
										current.time_start,
									) as { time_start: number } | null;
									if (next) {
										current = { time_start: next.time_start };
										heads.set(sid, current);
									} else {
										current = undefined;
										heads.delete(sid);
									}
								}
							}
						} while (changed);
					}
					if (heads.size) {
						pendingCount = (
							this.db
								.query(
									"SELECT COUNT(*) AS n FROM pulsify_op_rows INDEXED BY pulsify_rows_pending WHERE doc_id=? AND ready=0",
								)
								.get(docId) as { n: number }
						).n;
					}
				}
				const clock = this.db.query(
					"INSERT INTO pulsify_doc_clocks(doc_id,sid,clock) VALUES(?,?,?) ON CONFLICT(doc_id,sid) DO UPDATE SET clock=MAX(clock,excluded.clock)",
				);
				// Apply the PostgreSQL batch optimization without a separate SQLite tuning campaign.
				for (const sid of changedActors)
					clock.run(docId, sid, frontier.get(sid)!);
				const vector = [...frontier].sort((a, b) => a[0] - b[0]);
				if (fresh.length) added?.(fresh);
				return { inserted, ready, pending: pendingCount, vector };
			})
			.immediate();
		// Only once committed: a rolled-back append never reaches the cache.
		this.remember(docId, result.vector);
		return result;
	}
	/** Cache a copy of a committed vector, evicting the least recently used. */
	private remember(docId: string, vector: PulseVersionVector): void {
		if (!this.vectorCacheSize) return;
		this.vectors.delete(docId);
		this.vectors.set(docId, copyVector(vector));
		if (this.vectors.size > this.vectorCacheSize)
			this.vectors.delete(this.vectors.keys().next().value!);
	}
	private readVector(docId: string): PulseVersionVector {
		return (
			this.db
				.query(
					"SELECT sid,clock FROM pulsify_doc_clocks WHERE doc_id=? ORDER BY sid",
				)
				.all(docId) as { sid: number; clock: number }[]
		).map(({ sid, clock }) => [sid, clock]);
	}
	async vector(docId: string): Promise<PulseVersionVector> {
		validateDocId(docId);
		this.assertLive(docId);
		const cached = this.vectors.get(docId);
		if (cached) {
			this.vectors.delete(docId);
			this.vectors.set(docId, cached);
			return copyVector(cached);
		}
		const vector = this.readVector(docId);
		this.remember(docId, vector);
		return vector;
	}
	/**
	 * Erase a document and its sub-documents (`docId/…`): their rows and
	 * vectors. Resolves to how many documents had rows.
	 */
	async deleteDocuments(
		docId: string,
		options: { preserveRows?: boolean } = {},
	): Promise<number> {
		validateDocId(docId);
		// TEXT compares bytewise: `docId/…` sorts between `docId/` and `docId0`.
		const where = "doc_id=? OR (doc_id>=? AND doc_id<?)";
		const bindings = [docId, `${docId}/`, `${docId}0`];
		const deleted = this.db
			.transaction(() => {
				if (!this.deleted(docId)) {
					this.db
						.query(
							`DELETE FROM pulsify_tombstones WHERE prefix=? OR (prefix>=? AND prefix<?)`,
						)
						.run(...bindings);
					this.db
						.query("INSERT INTO pulsify_tombstones(prefix) VALUES(?)")
						.run(docId);
				}
				if (options.preserveRows) return 0;
				const { documents } = this.db
					.query(
						`SELECT COUNT(*) AS documents FROM (SELECT doc_id FROM pulsify_op_rows WHERE ${where} UNION SELECT doc_id FROM pulsify_values WHERE ${where})`,
					)
					.get(...bindings, ...bindings) as { documents: number };
				for (const table of [
					"pulsify_op_rows",
					"pulsify_values",
					"pulsify_doc_clocks",
				])
					this.db.query(`DELETE FROM ${table} WHERE ${where}`).run(...bindings);
				return Number(documents);
			})
			.immediate();
		for (const cached of [...this.vectors.keys()])
			if (coversDocument(docId, cached)) this.vectors.delete(cached);
		return deleted;
	}
	/** Atomically retain an in-memory replica before marking its subtree deleted. */
	async markDeleted(
		docId: string,
		recovery: readonly StoredPatchRow[] = [],
	): Promise<void> {
		validateDocId(docId);
		const groups = new Map<string, StoredPatchRow[]>();
		try {
			for (const row of recovery) {
				if (!coversDocument(docId, row.docId))
					throw new PulseError(
						"INVALID_MESSAGE",
						"Recovery row outside deleted subtree",
					);
				const group = groups.get(row.docId) ?? [];
				group.push(row);
				groups.set(row.docId, group);
			}
			this.db
				.transaction(() => {
					for (const [id, rows] of groups) {
						// Recovery may add retained rows, but never clears an existing marker.
						this.vectors.delete(id);
						for (let i = 0; i < rows.length; i += 4096)
							this.appendRows(rows.slice(i, i + 4096), true);
					}
					if (!this.deleted(docId)) {
						this.db
							.query(
								"DELETE FROM pulsify_tombstones WHERE prefix>=? AND prefix<?",
							)
							.run(`${docId}/`, `${docId}0`);
						this.db
							.query("INSERT INTO pulsify_tombstones(prefix) VALUES(?)")
							.run(docId);
					}
				})
				.immediate();
		} finally {
			await this.deleteDocuments(docId, { preserveRows: true });
			for (const cached of [...this.vectors.keys()])
				if (coversDocument(docId, cached)) this.vectors.delete(cached);
		}
	}
	private deleted(docId: string): boolean {
		const get = this.db.query(
			"SELECT 1 FROM pulsify_tombstones WHERE prefix=?",
		);
		return documentPrefixes(docId).some((prefix) => !!get.get(prefix));
	}
	private assertLive(docId: string): void {
		if (this.deleted(docId)) throw deletedDocument(docId);
	}
	async isDeleted(docId: string): Promise<boolean> {
		return this.deleted(docId);
	}
	/** Read retained local data explicitly, without making a deleted ID live again. */
	async recoverRows(docId: string): Promise<StoredPatchRow[]> {
		this.vectors.delete(docId);
		return this.readMissingPage(
			docId,
			[],
			{ maxBytes: Infinity, maxRows: Infinity, maxNodes: Infinity },
			false,
		).rows;
	}
	async documents(docId: string, after = "", limit = 256): Promise<string[]> {
		this.assertLive(docId);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
			throw new RangeError("Invalid document limit");
		const result: string[] = [];
		if (
			this.db
				.query(
					"SELECT 1 FROM pulsify_doc_clocks WHERE doc_id=? AND doc_id>? LIMIT 1",
				)
				.get(docId, after)
		)
			result.push(docId);
		// Separate exact-ID and descendant ranges avoid scanning siblings. Seek
		// from the last candidate on every page, including retained/deleted IDs.
		const query = this.db.query(`SELECT DISTINCT doc_id FROM pulsify_doc_clocks
      WHERE doc_id>=MAX(?,?) AND doc_id<? AND doc_id>?
      ORDER BY doc_id LIMIT ?`);
		let cursor = after;
		while (result.length < limit) {
			const candidates = query.all(
				`${docId}/`,
				cursor,
				`${docId}0`,
				cursor,
				limit - result.length,
			) as { doc_id: string }[];
			if (!candidates.length) break;
			for (const { doc_id: id } of candidates)
				// Indexed point lookups per ancestor, independent of marker count.
				if (!this.deleted(id)) result.push(id);
			cursor = candidates.at(-1)!.doc_id;
		}
		return result;
	}
	async missing(
		docId: string,
		remote: PulseVersionVector,
	): Promise<StoredPatchRow[]> {
		return this.readMissingPage(
			docId,
			remote,
			{ maxBytes: Infinity, maxRows: Infinity, maxNodes: Infinity },
			true,
		).rows;
	}
	async missingPage(
		docId: string,
		remote: PulseVersionVector,
		options: MissingPageOptions = {},
	): Promise<MissingPage> {
		return this.readMissingPage(docId, remote, options, true);
	}
	private readMissingPage(
		docId: string,
		remote: PulseVersionVector,
		{
			after,
			maxBytes = 2 * MAX_PATCH_BYTES,
			maxRows = MAX_MESSAGE_ROWS,
			maxNodes = MAX_ROW_BATCH_NODES,
		}: MissingPageOptions,
		checkLive: boolean,
	): MissingPage {
		validateDocId(docId);
		validateVector(remote);
		const cursor = after as SqliteMissingCursor | undefined;
		const since = new Map(remote);
		return this.db.transaction((): MissingPage => {
			if (checkLive) this.assertLive(docId);
			const cached = this.vectors.get(docId);
			const liveVv = cached ? copyVector(cached) : this.readVector(docId);
			const vv: PulseVersionVector = cursor
				? [
						...cursor.vv.filter(([sid]) => sid < cursor.sid),
						...liveVv.filter(([sid]) => sid >= cursor.sid),
					]
				: liveVv;
			const behind = liveVv.filter(
				([sid, clock]) =>
					(!cursor || sid >= cursor.sid) && clock > (since.get(sid) ?? 0),
			);
			if (!behind.length) return { rows: [], vv, next: undefined };
			const opLowerStmt = this.db.query(
				"SELECT time_start FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start<=? ORDER BY time_start DESC LIMIT 1",
			);
			const valLowerStmt = this.db.query(
				"SELECT clock FROM pulsify_values WHERE doc_id=? AND sid=? AND clock<=? ORDER BY clock DESC LIMIT 1",
			);
			const opScanStmt = this.db.query(
				`SELECT doc_id,sid,time_start,span,dependencies,packed,ready,length(operations) AS bytes,
 CASE WHEN length(operations)<=${MISSING_INLINE_BYTES} THEN operations END AS operations
 FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start>=? AND time_start<? ORDER BY time_start LIMIT ?`,
			);
			const valScanStmt = this.db.query(
				`SELECT doc_id,sid,register,clock,dependencies,length(operations) AS bytes,
 CASE WHEN length(operations)<=${MISSING_INLINE_BYTES} THEN operations END AS operations
 FROM pulsify_values WHERE doc_id=? AND sid=? AND clock>=? AND clock<? ORDER BY clock LIMIT ?`,
			);
			const opBlobStmt = this.db.query(
				"SELECT operations FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start=?",
			);
			const valBlobStmt = this.db.query(
				"SELECT operations FROM pulsify_values WHERE doc_id=? AND sid=? AND register=?",
			);
			const page: StoredPatchRow[] = [];
			let pageBytes = 0;
			let pageNodes = 0;
			const tryEmit = (
				sid: number,
				candidate: CandidateRow,
				span: number,
			): boolean => {
				if (candidate.bytes > MAX_PATCH_BYTES)
					throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
				const size =
					candidate.bytes +
					candidate.dependencies.length * 16 +
					docId.length * 4 +
					64;
				const rowNodes = 7 + 3 * candidate.dependencies.length;
				if (
					page.length &&
					(pageBytes + size > maxBytes ||
						page.length >= maxRows ||
						pageNodes + rowNodes > maxNodes)
				)
					return false;
				let operations = candidate.operations;
				if (!operations) {
					const raw = candidate.register
						? (valBlobStmt.get(docId, sid, candidate.register) as {
								operations: Uint8Array;
							})
						: (opBlobStmt.get(docId, sid, candidate.clock) as {
								operations: Uint8Array;
							});
					operations = new Uint8Array(raw.operations);
				}
				page.push({
					docId,
					sid,
					clock: candidate.clock,
					span,
					dependencies: candidate.dependencies,
					operations,
				});
				pageBytes += size;
				pageNodes += rowNodes;
				return true;
			};
			for (const [sid, frontier] of behind) {
				const resuming = cursor !== undefined && sid === cursor.sid;
				const from = resuming ? cursor.from : Math.max(since.get(sid) ?? 0, 1);
				const straddle = resuming ? cursor.straddle : true;
				if (from >= frontier) continue;
				const opStart =
					from > 1
						? ((
								opLowerStmt.get(docId, sid, from) as {
									time_start: number;
								} | null
							)?.time_start ?? from)
						: 1;
				const valStart =
					straddle && from > 1
						? ((valLowerStmt.get(docId, sid, from) as { clock: number } | null)
								?.clock ?? from)
						: from;
				let opCursor = opStart;
				let opDone = false;
				const opQueue: CandidateRow[] = [];
				let opIndex = 0;
				const fillOps = () => {
					opQueue.length = 0;
					opIndex = 0;
					while (!opDone && !opQueue.length) {
						const batch = opScanStmt.all(
							docId,
							sid,
							opCursor,
							frontier,
							MISSING_SCAN_BATCH,
						) as ScanMissingOpRow[];
						if (batch.length < MISSING_SCAN_BATCH) opDone = true;
						if (!batch.length) break;
						opCursor = batch.at(-1)!.time_start + 1;
						for (const row of batch) {
							if (!row.ready) continue;
							if (row.packed) {
								if (!straddle && row.time_start + row.span <= from) continue;
								const raw =
									row.operations ??
									(
										opBlobStmt.get(docId, sid, row.time_start) as {
											operations: Uint8Array;
										}
									).operations;
								const unpacked = decodePackedRows(
									row.doc_id,
									row.sid,
									row.time_start,
									new Uint8Array(raw),
								);
								const last = unpacked.at(-1);
								if (
									!last ||
									last.clock + last.span !== row.time_start + row.span
								)
									throw new PulseError(
										"INVALID_MESSAGE",
										"Corrupt packed segment",
									);
								for (const inner of unpacked) {
									if (isGap(inner.operations)) continue;
									if (!straddle && inner.clock < from) continue;
									opQueue.push({
										clock: inner.clock,
										dependencies: inner.dependencies,
										bytes: inner.operations.length,
										operations: inner.operations,
									});
								}
							} else {
								if (!straddle && row.time_start < from) continue;
								const ops = row.operations
									? new Uint8Array(row.operations)
									: null;
								if (ops && isGap(ops)) continue;
								opQueue.push({
									clock: row.time_start,
									dependencies: JSON.parse(
										row.dependencies,
									) as PulseVersionVector,
									bytes: row.bytes,
									operations: ops,
								});
							}
						}
					}
				};
				let valCursor = valStart;
				let valDone = false;
				const valQueue: CandidateRow[] = [];
				let valIndex = 0;
				const fillVals = () => {
					valQueue.length = 0;
					valIndex = 0;
					while (!valDone && !valQueue.length) {
						const batch = valScanStmt.all(
							docId,
							sid,
							valCursor,
							frontier,
							MISSING_SCAN_BATCH,
						) as ScanMissingValueRow[];
						if (batch.length < MISSING_SCAN_BATCH) valDone = true;
						if (!batch.length) break;
						valCursor = batch.at(-1)!.clock + 1;
						for (const row of batch) {
							const ops = row.operations
								? new Uint8Array(row.operations)
								: null;
							if (ops && isGap(ops)) continue;
							valQueue.push({
								clock: row.clock,
								dependencies: JSON.parse(
									row.dependencies,
								) as PulseVersionVector,
								bytes: row.bytes,
								operations: ops,
								register: new Uint8Array(row.register),
							});
						}
					}
				};
				const nextHeld = (): CandidateRow | undefined => {
					if (opIndex >= opQueue.length && !opDone) fillOps();
					if (valIndex >= valQueue.length && !valDone) fillVals();
					const op = opQueue[opIndex];
					const val = valQueue[valIndex];
					if (!op) return val ? valQueue[valIndex++] : undefined;
					if (!val) return opQueue[opIndex++];
					return op.clock <= val.clock
						? opQueue[opIndex++]
						: valQueue[valIndex++];
				};
				let curr = nextHeld();
				let next = curr ? nextHeld() : undefined;
				if (straddle) {
					while (curr && next && next.clock <= from) {
						curr = next;
						next = nextHeld();
					}
				}
				if (!curr || curr.clock > from) {
					const gapEnd = curr ? curr.clock : frontier;
					if (gapEnd > from) {
						const gap: CandidateRow = {
							clock: from,
							dependencies: from > 1 ? [[sid, from]] : [],
							bytes: GAP_OPERATIONS.length,
							operations: GAP_OPERATIONS.slice(),
						};
						if (!tryEmit(sid, gap, gapEnd - from))
							return {
								rows: page,
								vv,
								next: {
									sid,
									from,
									straddle: false,
									vv,
								} satisfies SqliteMissingCursor,
							};
					}
				}
				while (curr) {
					const span = (next ? next.clock : frontier) - curr.clock;
					const isStraddling = straddle && curr.clock < from;
					if (!tryEmit(sid, curr, span))
						return {
							rows: page,
							vv,
							next: {
								sid,
								from: isStraddling ? from : curr.clock,
								straddle: isStraddling,
								vv,
							} satisfies SqliteMissingCursor,
						};
					curr = next;
					next = curr ? nextHeld() : undefined;
				}
			}
			return { rows: page, vv, next: undefined };
		})();
	}
	/**
	 * Fold runs of consecutive ready rows of one actor into packed segments, so
	 * that reading a long history costs a few rows. Nothing a peer can observe
	 * changes: `missing`, `vector` and `append` answer as before. One call reads
	 * at most `maxRows` stored rows in one transaction, across all documents;
	 * call again with `next` until it is undefined.
	 */
	async compact({
		after,
		maxRows = 4096,
		minRows = 64,
	}: SqliteCompactOptions = {}): Promise<SqliteCompactResult> {
		minRows = Math.max(2, minRows);
		// A run cut by the limit is read again from its start: it must then fit.
		const limit = Math.max(maxRows, minRows + 1);
		return this.db
			.transaction((): SqliteCompactResult => {
				const batch = this.db
					.query(
						`SELECT doc_id,sid,time_start,span,ready,packed,length(operations) AS bytes,
 CASE WHEN ready=1 AND packed=0 THEN dependencies END AS dependencies,
 CASE WHEN ready=1 AND packed=0 AND length(operations)<=${COMPACT_INLINE_BYTES} THEN operations END AS operations
 FROM pulsify_op_rows ${after ? "WHERE (doc_id,sid,time_start)>(?,?,?)" : ""} ORDER BY doc_id,sid,time_start LIMIT ?`,
					)
					.all(...(after ?? []), limit) as ScanRow[];
				const get = this.db.query(
					"SELECT operations FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start=?",
				);
				const previous = this.db.query(
					"SELECT time_start,span,packed,length(operations) AS bytes FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start<? ORDER BY time_start DESC LIMIT 1",
				);
				const write = this.db.query(
					"UPDATE pulsify_op_rows SET span=?,operations=?,packed=1 WHERE doc_id=? AND sid=? AND time_start=?",
				);
				const remove = this.db.query(
					"DELETE FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start>? AND time_start<?",
				);
				// The JSON text of dependencies is never shorter than their varuints.
				const packable = (row: ScanRow) =>
					row.ready === 1 &&
					row.packed === 0 &&
					row.bytes + row.dependencies!.length + 16 <= MAX_PACKED_BYTES;
				let rows = 0,
					segments = 0,
					bytes = 0;
				/** A packed row being built: a new one, or the one before the run. */
				type Segment = {
					docId: string;
					sid: number;
					clock: number;
					/** Where its last row's span ends. */
					end: number;
					/** Its bytes so far, those already stored included. */
					size: number;
					extended: boolean;
					/** Rows it takes, without the filler of a hole before them. */
					count: number;
					parts: Uint8Array[];
				};
				let segment: Segment | undefined;
				/** Store the segment in place of its rows. */
				const flush = (): boolean => {
					const { docId, sid, clock, end, extended, count, parts } = segment!;
					segment = undefined;
					// A row alone gains nothing from being packed.
					if (count < (extended ? 1 : 2)) return false;
					rows += count;
					if (extended)
						parts.unshift(
							new Uint8Array(
								(get.get(docId, sid, clock) as RecordRow).operations,
							),
						);
					const payload = new Uint8Array(
						parts.reduce((total, part) => total + part.length, 0),
					);
					let offset = 0;
					for (const part of parts) {
						payload.set(part, offset);
						offset += part.length;
					}
					remove.run(docId, sid, clock, end);
					write.run(end - clock, payload, docId, sid, clock);
					segments++;
					bytes += payload.length;
					return true;
				};
				let index = 0;
				let next: SqliteCompactCursor | undefined;
				const stopAt = (row: ScanRow) => {
					next = [row.doc_id, row.sid, row.time_start];
				};
				while (index < batch.length && !next) {
					const first = batch[index]!;
					if (!packable(first)) {
						index++;
						continue;
					}
					// Holes between the rows are writes replaced since: a row's span
					// runs to the next one, so that the clocks inside stay known.
					let stop = index + 1;
					for (; stop < batch.length; stop++) {
						const row = batch[stop]!;
						if (
							!packable(row) ||
							row.doc_id !== first.doc_id ||
							row.sid !== first.sid
						)
							break;
					}
					if (stop - index < minRows) {
						// Cut by the limit rather than ended: decide with the rest of it.
						if (stop === limit)
							next = [first.doc_id, first.sid, first.time_start - 1];
						index = stop;
						continue;
					}
					// The packed segment just before the run takes its rows while it
					// has room, so that short runs do not each leave a segment. A gap
					// row fills the hole between them.
					const inBatch = batch[index - 1];
					const before = inBatch
						? inBatch.doc_id === first.doc_id && inBatch.sid === first.sid
							? inBatch
							: undefined
						: first.time_start > 1
							? (previous.get(
									first.doc_id,
									first.sid,
									first.time_start,
								) as Pick<
									ScanRow,
									"time_start" | "span" | "packed" | "bytes"
								> | null)
							: undefined;
					if (before?.packed) {
						const end = before.time_start + before.span;
						const parts =
							end < first.time_start
								? [
										encodePackedRow({
											span: first.time_start - end,
											dependencies: [],
											operations: GAP_OPERATIONS,
										}),
									]
								: [];
						segment = {
							docId: first.doc_id,
							sid: first.sid,
							clock: before.time_start,
							end: first.time_start,
							size: before.bytes + (parts[0]?.length ?? 0),
							extended: true,
							count: 0,
							parts,
						};
					}
					for (; index < stop; index++) {
						const row = batch[index]!;
						const span =
							index + 1 < stop
								? batch[index + 1]!.time_start - row.time_start
								: row.span;
						const part = encodePackedRow({
							span,
							dependencies: JSON.parse(row.dependencies!) as PulseVersionVector,
							// Some drivers return an ArrayBuffer.
							operations: new Uint8Array(
								row.operations ??
									(get.get(row.doc_id, row.sid, row.time_start) as RecordRow)
										.operations,
							),
						});
						if (
							segment &&
							segment.size + part.length > MAX_PACKED_BYTES &&
							flush() &&
							bytes >= COMPACT_CALL_BYTES
						) {
							// Enough for one transaction: the rest is a run of the next call.
							stopAt(batch[index - 1]!);
							break;
						}
						segment ??= {
							docId: row.doc_id,
							sid: row.sid,
							clock: row.time_start,
							end: row.time_start,
							size: 0,
							extended: false,
							count: 0,
							parts: [],
						};
						segment.parts.push(part);
						segment.size += part.length;
						segment.end = row.time_start + span;
						segment.count++;
					}
					if (segment) flush();
				}
				if (!next && batch.length === limit) stopAt(batch[limit - 1]!);
				return { rows, segments, next };
			})
			.immediate();
	}
}
