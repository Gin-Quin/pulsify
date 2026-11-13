import { PulseError } from "../protocol/errors.js";
import { validateDocId } from "../protocol/validateDocId.js";
import { MAX_VECTOR_ENTRIES } from "../protocol/limits.js";
import {
	validateVector,
	type PulseVersionVector,
} from "../connection/PulseVersionVector.js";
import {
	assertCompatible,
	covered,
	decodePackedRows,
	encodePackedRow,
	MAX_PACKED_BYTES,
	rowsFromFrame,
	sameRow,
	validateRows,
	type AppendResult,
	type PatchStore,
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
};
/** A stored row without its bytes: all that neighbour checks need. */
type EnvelopeRow = Omit<RecordRow, "doc_id" | "operations">;
type PendingRow = {
	sid: number;
	time_start: number;
	time_end: number;
	dependencies: string;
};
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
export class SqlitePatchStore implements PatchStore {
	private readonly vectors = new Map<string, PulseVersionVector>();
	private readonly vectorCacheSize: number;
	constructor(
		private readonly db: SqliteConnection,
		{ vectorCacheSize = 0 }: SqlitePatchStoreOptions = {},
	) {
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
		this.vectorCacheSize = vectorCacheSize;
	}
	async appendEncoded(frame: Uint8Array): Promise<AppendResult> {
		return this.append(rowsFromFrame(frame));
	}
	async append(rows: readonly StoredPatchRow[]): Promise<AppendResult> {
		const docId = validateRows(rows);
		if (docId === undefined) return { inserted: 0, ready: 0, pending: 0 };
		const result = this.db
			.transaction(() => {
				const get = this.db.query(
					"SELECT * FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start=?",
				);
				const neighbours = this.db
					.query(`SELECT sid,time_start,span,dependencies,packed FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND
 (time_start=(SELECT MAX(time_start) FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start<?)
 OR time_start=(SELECT MIN(time_start) FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start>?))`);
				const insert = this.db.query(
					"INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready) VALUES(?,?,?,?,?,?,?)",
				);
				const frontier = new Map(
					this.vectors.get(docId) ?? this.readVector(docId),
				);
				// Pending rows are few: read them through the partial index, which the
				// planner would otherwise skip for the primary key and read the whole
				// document. Its entries end with the primary key, so they come sorted.
				let pending = this.db
					.query(
						"SELECT sid,time_start,time_end,dependencies FROM pulsify_op_rows INDEXED BY pulsify_rows_pending WHERE doc_id=? AND ready=0 ORDER BY sid,time_start",
					)
					.all(docId) as PendingRow[];
				const pendingActors = new Set(pending.map((row) => row.sid));
				const changedActors = new Set<number>();
				let inserted = 0,
					ready = 0;
				rows: for (const row of rows) {
					// A row that is ready on arrival (the common, in-order case) skips the
					// pending index and the promotion UPDATE: 3 billed rows instead of 5.
					const readyNow =
						row.clock === (frontier.get(row.sid) ?? 1) &&
						covered(frontier, row.dependencies);
					if (readyNow && !pendingActors.has(row.sid)) {
						// Ready rows of an actor tile [1, frontier) and it has no pending
						// row, so no stored row starts at or after this one: it is neither
						// a duplicate nor overlapping, and the previous row ends exactly
						// at the frontier. Only the fork check remains, without reading it.
						if (
							row.clock > 1 &&
							(new Map(row.dependencies).get(row.sid) ?? 0) < row.clock
						)
							throw new PulseError("CONFLICT", "Actor history fork");
					} else {
						const existing = get.get(
							docId,
							row.sid,
							row.clock,
						) as RecordRow | null;
						if (existing) {
							// A packed segment starts with the row that had its key.
							if (!sameRow(unpackAll(existing)[0]!, row))
								throw new PulseError("CONFLICT", "Conflicting storage segment");
							continue;
						}
						for (const neighbour of neighbours.all(
							docId,
							row.sid,
							docId,
							row.sid,
							row.clock,
							docId,
							row.sid,
							row.clock,
						) as EnvelopeRow[]) {
							let other: StoredPatchRow = {
								docId,
								sid: neighbour.sid,
								clock: neighbour.time_start,
								span: neighbour.span,
								dependencies: JSON.parse(
									neighbour.dependencies,
								) as PulseVersionVector,
								operations: row.operations,
							};
							// Seen from outside, a packed segment checks like its rows: it
							// starts with the dependencies of its first and ends with its
							// last. A row that starts inside is compared to the row it hits.
							if (
								neighbour.packed &&
								other.clock < row.clock &&
								row.clock < other.clock + other.span
							) {
								const inner = unpackAll(
									get.get(docId, row.sid, other.clock) as RecordRow,
								);
								const same = inner.find((each) => each.clock === row.clock);
								if (same) {
									if (!sameRow(same, row))
										throw new PulseError(
											"CONFLICT",
											"Conflicting storage segment",
										);
									continue rows;
								}
								other = inner.findLast((each) => each.clock < row.clock)!;
							}
							assertCompatible(row, other);
						}
					}
					const dependencies = JSON.stringify(row.dependencies);
					insert.run(
						docId,
						row.sid,
						row.clock,
						row.span,
						dependencies,
						row.operations,
						readyNow ? 1 : 0,
					);
					inserted++;
					if (readyNow) {
						frontier.set(row.sid, row.clock + row.span);
						changedActors.add(row.sid);
						ready++;
					} else {
						pending.push({
							sid: row.sid,
							time_start: row.clock,
							time_end: row.clock + row.span,
							dependencies,
						});
						pendingActors.add(row.sid);
					}
				}
				if (
					new Set([...frontier.keys(), ...pendingActors]).size >
					MAX_VECTOR_ENTRIES
				)
					throw new PulseError(
						"LIMIT_EXCEEDED",
						"Document actor limit exceeded",
					);
				pending.sort((a, b) => a.sid - b.sid || a.time_start - b.time_start);
				const update = this.db.query(
					"UPDATE pulsify_op_rows SET ready=1 WHERE doc_id=? AND sid=? AND time_start=?",
				);
				const clock = this.db.query(
					"INSERT INTO pulsify_doc_clocks(doc_id,sid,clock) VALUES(?,?,?) ON CONFLICT(doc_id,sid) DO UPDATE SET clock=MAX(clock,excluded.clock)",
				);
				let changed: boolean;
				do {
					changed = false;
					const waiting: PendingRow[] = [];
					for (const row of pending) {
						if (
							row.time_start !== (frontier.get(row.sid) ?? 1) ||
							!covered(
								frontier,
								JSON.parse(row.dependencies) as PulseVersionVector,
							)
						) {
							waiting.push(row);
							continue;
						}
						update.run(docId, row.sid, row.time_start);
						frontier.set(
							row.sid,
							Math.max(frontier.get(row.sid) ?? 0, row.time_end),
						);
						changedActors.add(row.sid);
						ready++;
						changed = true;
					}
					pending = waiting;
				} while (changed);
				// Apply the PostgreSQL batch optimization without a separate SQLite tuning campaign.
				for (const sid of changedActors)
					clock.run(docId, sid, frontier.get(sid)!);
				const vector = [...frontier].sort((a, b) => a[0] - b[0]);
				return { inserted, ready, pending: pending.length, vector };
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
	async deleteDocuments(docId: string): Promise<number> {
		validateDocId(docId);
		// TEXT compares bytewise: `docId/…` sorts between `docId/` and `docId0`.
		const where = "doc_id=? OR (doc_id>=? AND doc_id<?)";
		const bindings = [docId, `${docId}/`, `${docId}0`];
		const deleted = this.db
			.transaction(() => {
				const { documents } = this.db
					.query(
						`SELECT COUNT(DISTINCT doc_id) AS documents FROM pulsify_op_rows WHERE ${where}`,
					)
					.get(...bindings) as { documents: number };
				this.db
					.query(`DELETE FROM pulsify_op_rows WHERE ${where}`)
					.run(...bindings);
				this.db
					.query(`DELETE FROM pulsify_doc_clocks WHERE ${where}`)
					.run(...bindings);
				return Number(documents);
			})
			.immediate();
		for (const cached of [...this.vectors.keys()])
			if (cached === docId || cached.startsWith(`${docId}/`))
				this.vectors.delete(cached);
		return deleted;
	}
	async missing(
		docId: string,
		remote: PulseVersionVector,
	): Promise<StoredPatchRow[]> {
		validateDocId(docId);
		validateVector(remote);
		// One JSON parameter: some hosts (Durable Objects) bind at most 100 values.
		const bindings: SqliteBinding[] = remote.length
			? [JSON.stringify(remote), docId, docId, docId]
			: [docId];
		// Ready actors are exactly those in pulsify_doc_clocks. Rows of one actor never
		// overlap, so every row ending after the remote clock starts at or after the
		// last row starting at or before it: one primary key seek per behind actor.
		// CROSS JOIN keeps that loop order; without statistics SQLite would scan the doc.
		const sql = remote.length
			? `WITH remote(sid,clock) AS (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)),
 actors(sid,since) AS (SELECT c.sid,COALESCE(r.clock,0) FROM pulsify_doc_clocks c LEFT JOIN remote r ON r.sid=c.sid
  WHERE c.doc_id=? AND c.clock>COALESCE(r.clock,0))
 SELECT o.* FROM actors a CROSS JOIN pulsify_op_rows o WHERE o.doc_id=? AND o.sid=a.sid
 AND o.time_start>=COALESCE((SELECT MAX(time_start) FROM pulsify_op_rows WHERE doc_id=? AND sid=a.sid AND time_start<=a.since),0)
 AND o.ready=1 AND o.time_end>a.since ORDER BY o.sid,o.time_start`
			: "SELECT * FROM pulsify_op_rows WHERE doc_id=? AND ready=1 ORDER BY sid,time_start";
		const stored = this.db.query(sql).all(...bindings) as RecordRow[];
		if (!stored.some((row) => row.packed)) return stored.map(unpack);
		// Packed segments never reach a peer: it gets the rows inside, as stored.
		const since = new Map(remote);
		return stored.flatMap((row) =>
			row.packed
				? unpackAll(row).filter(
						(inner) => inner.clock + inner.span > (since.get(row.sid) ?? 0),
					)
				: unpack(row),
		);
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
				const end = (row: ScanRow) => row.time_start + row.span;
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
					/** Its bytes so far, those already stored included. */
					size: number;
					extended: boolean;
					parts: Uint8Array[];
				};
				let segment: Segment | undefined;
				/** Store the segment, which now ends with `last`, in place of its rows. */
				const flush = (last: ScanRow): boolean => {
					const { docId, sid, clock, extended, parts } = segment!;
					segment = undefined;
					// A row alone gains nothing from being packed.
					if (parts.length < (extended ? 1 : 2)) return false;
					rows += parts.length;
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
					remove.run(docId, sid, clock, end(last));
					write.run(end(last) - clock, payload, docId, sid, clock);
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
					let stop = index + 1;
					for (; stop < batch.length; stop++) {
						const row = batch[stop]!;
						if (
							!packable(row) ||
							row.doc_id !== first.doc_id ||
							row.sid !== first.sid ||
							row.time_start !== end(batch[stop - 1]!)
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
					// The packed segment that ends where the run starts takes its rows
					// while it has room, so that short runs do not each leave a segment.
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
					if (
						before?.packed &&
						before.time_start + before.span === first.time_start
					)
						segment = {
							docId: first.doc_id,
							sid: first.sid,
							clock: before.time_start,
							size: before.bytes,
							extended: true,
							parts: [],
						};
					for (; index < stop; index++) {
						const row = batch[index]!;
						const part = encodePackedRow({
							span: row.span,
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
							flush(batch[index - 1]!) &&
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
							size: 0,
							extended: false,
							parts: [],
						};
						segment.parts.push(part);
						segment.size += part.length;
					}
					if (segment) flush(batch[stop - 1]!);
				}
				if (!next && batch.length === limit) stopAt(batch[limit - 1]!);
				return { rows, segments, next };
			})
			.immediate();
	}
}
