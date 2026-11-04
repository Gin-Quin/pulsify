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
};
type PendingRow = {
	sid: number;
	time_start: number;
	time_end: number;
	dependencies: string;
};
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

export const SQLITE_PATCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS pulsify_op_rows (
 doc_id TEXT NOT NULL, sid INTEGER NOT NULL, time_start INTEGER NOT NULL,
 span INTEGER NOT NULL CHECK(span > 0), time_end INTEGER GENERATED ALWAYS AS (time_start + span) STORED,
 dependencies TEXT NOT NULL, operations BLOB NOT NULL, ready INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(doc_id, sid, time_start)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pulsify_rows_frontier ON pulsify_op_rows(doc_id, sid, time_end);
CREATE INDEX IF NOT EXISTS pulsify_rows_pending ON pulsify_op_rows(doc_id) WHERE ready = 0;
CREATE TABLE IF NOT EXISTS pulsify_doc_clocks (
 doc_id TEXT NOT NULL, sid INTEGER NOT NULL, clock INTEGER NOT NULL,
 PRIMARY KEY(doc_id, sid)
) WITHOUT ROWID;
CREATE VIEW IF NOT EXISTS pulsify_dangling_op_rows AS SELECT * FROM pulsify_op_rows WHERE ready = 0;
`;

/** Writes only indexed operation metadata and opaque bytes; never materializes a document. */
export class SqlitePatchStore implements PatchStore {
	constructor(private readonly db: SqliteConnection) {
		db.exec(SQLITE_PATCH_SCHEMA);
	}
	async appendEncoded(frame: Uint8Array): Promise<AppendResult> {
		return this.append(rowsFromFrame(frame));
	}
	async append(rows: readonly StoredPatchRow[]): Promise<AppendResult> {
		const docId = validateRows(rows);
		if (docId === undefined) return { inserted: 0, ready: 0, pending: 0 };
		return this.db
			.transaction(() => {
				const get = this.db.query(
					"SELECT * FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start=?",
				);
				const neighbours =
					this.db.query(`SELECT * FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND
 (time_start=(SELECT MAX(time_start) FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start<?)
 OR time_start=(SELECT MIN(time_start) FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start>?))`);
				const insert = this.db.query(
					"INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations) VALUES(?,?,?,?,?,?)",
				);
				let inserted = 0;
				for (const row of rows) {
					const existing = get.get(
						docId,
						row.sid,
						row.clock,
					) as RecordRow | null;
					if (existing) {
						if (!sameRow(unpack(existing), row))
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
					) as RecordRow[])
						assertCompatible(row, unpack(neighbour));
					insert.run(
						docId,
						row.sid,
						row.clock,
						row.span,
						JSON.stringify(row.dependencies),
						row.operations,
					);
					inserted++;
				}
				const frontier = new Map(this.readVector(docId));
				let pending = this.db
					.query(
						"SELECT sid,time_start,time_end,dependencies FROM pulsify_op_rows WHERE doc_id=? AND ready=0 ORDER BY sid,time_start",
					)
					.all(docId) as PendingRow[];
				if (
					new Set([...frontier.keys(), ...pending.map((row) => row.sid)]).size >
					MAX_VECTOR_ENTRIES
				)
					throw new PulseError(
						"LIMIT_EXCEEDED",
						"Document actor limit exceeded",
					);
				const update = this.db.query(
					"UPDATE pulsify_op_rows SET ready=1 WHERE doc_id=? AND sid=? AND time_start=?",
				);
				const clock = this.db.query(
					"INSERT INTO pulsify_doc_clocks(doc_id,sid,clock) VALUES(?,?,?) ON CONFLICT(doc_id,sid) DO UPDATE SET clock=MAX(clock,excluded.clock)",
				);
				let ready = 0,
					changed: boolean;
				const changedActors = new Set<number>();
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
				return { inserted, ready, pending: pending.length };
			})
			.immediate();
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
		return this.readVector(docId);
	}
	async missing(
		docId: string,
		remote: PulseVersionVector,
	): Promise<StoredPatchRow[]> {
		validateDocId(docId);
		validateVector(remote);
		const bindings: SqliteBinding[] = remote.flatMap(([sid, clock]) => [
			sid,
			clock,
		]);
		bindings.push(docId);
		const sql = remote.length
			? `WITH remote(sid,clock) AS (VALUES ${remote.map(() => "(?,?)").join(",")})
 SELECT o.* FROM pulsify_op_rows o LEFT JOIN remote r ON r.sid=o.sid
 WHERE o.doc_id=? AND o.ready=1 AND o.time_end>COALESCE(r.clock,0) ORDER BY o.sid,o.time_start`
			: "SELECT * FROM pulsify_op_rows WHERE doc_id=? AND ready=1 ORDER BY sid,time_start";
		return (this.db.query(sql).all(...bindings) as RecordRow[]).map(unpack);
	}
}
