import { SQL } from "bun";
import { Database } from "bun:sqlite";
import type {
	Segment,
	SegmentRepository,
	SegmentTransaction,
	Vector,
} from "../types.js";

type Query = (
	sql: string,
	values?: unknown[],
) => Promise<Record<string, unknown>[]>;
function decode(row: Record<string, unknown>): Segment {
	return {
		docId: String(row["doc_id"]),
		sid: Number(row["sid"]),
		start: Number(row["time_start"]),
		end: Number(row["time_end"]),
		dependencies: JSON.parse(String(row["dependencies"])) as Vector,
		codec: row["codec"] as Segment["codec"],
		payload: new Uint8Array(row["payload"] as Uint8Array),
		fingerprint: String(row["fingerprint"]),
	};
}
function transaction(
	docId: string,
	query: Query,
	postgres: boolean,
): SegmentTransaction {
	const marks = (n: number) =>
		Array.from({ length: n }, (_, i) => (postgres ? `$${i + 1}` : "?"));
	const p = marks(9);
	return {
		vector: async () => {
			const rows = await query(
				`SELECT vector FROM bench_clocks WHERE doc_id=${p[0]}`,
				[docId],
			);
			return rows[0] ? (JSON.parse(String(rows[0]["vector"])) as Vector) : [];
		},
		setVector: async (vector) => {
			await query(
				`INSERT INTO bench_clocks(doc_id,vector) VALUES(${p[0]},${p[1]})
 ON CONFLICT(doc_id) DO UPDATE SET vector=excluded.vector`,
				[docId, JSON.stringify(vector)],
			);
		},
		get: async (sid, start) => {
			const rows = await query(
				`SELECT * FROM bench_segments WHERE doc_id=${p[0]} AND sid=${p[1]} AND time_start=${p[2]}`,
				[docId, sid, start],
			);
			return rows[0] ? decode(rows[0]) : undefined;
		},
		read: async (remote) => {
			if (!remote.length)
				return (
					await query(
						`SELECT * FROM bench_segments WHERE doc_id=${p[0]} ORDER BY sid,time_start`,
						[docId],
					)
				).map(decode);
			const bindings: unknown[] = remote.flatMap(([sid, clock]) => [
				sid,
				clock,
			]);
			bindings.push(docId);
			const placeholders = marks(bindings.length);
			const values = remote
				.map(
					(_, i) =>
						`(${placeholders[i * 2]}${postgres ? "::bigint" : ""},${placeholders[i * 2 + 1]}${postgres ? "::bigint" : ""})`,
				)
				.join(",");
			return (
				await query(
					`WITH remote(sid,clock) AS (VALUES ${values})
 SELECT s.* FROM bench_segments s LEFT JOIN remote r ON r.sid=s.sid
 WHERE s.doc_id=${placeholders.at(-1)} AND s.time_end>COALESCE(r.clock,0) ORDER BY s.sid,s.time_start`,
					bindings,
				)
			).map(decode);
		},
		put: async (s) => {
			await query(
				`INSERT INTO bench_segments(doc_id,sid,time_start,time_end,dependencies,codec,payload,fingerprint)
 VALUES(${p.slice(0, 8).join(",")})`,
				[
					docId,
					s.sid,
					s.start,
					s.end,
					JSON.stringify(s.dependencies),
					s.codec,
					s.payload,
					s.fingerprint,
				],
			);
		},
		remove: async (s) => {
			await query(
				`DELETE FROM bench_segments WHERE doc_id=${p[0]} AND sid=${p[1]} AND time_start=${p[2]}`,
				[docId, s.sid, s.start],
			);
		},
	};
}
function schema(postgres: boolean): string {
	return `CREATE TABLE IF NOT EXISTS bench_segments (
 doc_id TEXT NOT NULL, sid BIGINT NOT NULL, time_start BIGINT NOT NULL, time_end BIGINT NOT NULL,
 dependencies TEXT NOT NULL, codec TEXT NOT NULL, payload ${postgres ? "BYTEA" : "BLOB"} NOT NULL,
 fingerprint TEXT NOT NULL, PRIMARY KEY(doc_id,sid,time_start)
)${postgres ? "" : " WITHOUT ROWID"};
 CREATE INDEX IF NOT EXISTS bench_segments_end ON bench_segments(doc_id,sid,time_end);
 CREATE TABLE IF NOT EXISTS bench_clocks (doc_id TEXT PRIMARY KEY, vector TEXT NOT NULL)${postgres ? "" : " WITHOUT ROWID"};`;
}

export async function postgresRepository(
	url: string,
): Promise<SegmentRepository> {
	const sql = new SQL(url, { max: 1 });
	await sql.unsafe(schema(true));
	const version = await sql.unsafe("SHOW server_version");
	const settings = await sql.unsafe(
		"SELECT name,setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes')",
	);
	return {
		name: "postgres",
		metadata: {
			version: version[0]?.server_version,
			settings,
			transport: "Bun SQL / TCP",
		},
		transact: async (docId, work) =>
			sql.begin(async (connection) => {
				await connection.unsafe(
					"SELECT pg_advisory_xact_lock(hashtextextended($1,1933))",
					[docId],
				);
				return work(
					transaction(
						docId,
						async (statement, values = []) =>
							connection.unsafe(statement, values as never[]),
						true,
					),
				);
			}),
		close: async () => {
			await sql.close();
		},
	};
}

export function sqliteRepository(path: string): SegmentRepository {
	const db = new Database(path);
	db.exec(
		"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000;",
	);
	db.exec(schema(false));
	let serial: Promise<unknown> = Promise.resolve();
	return {
		name: "sqlite",
		metadata: {
			version: (
				db.query("SELECT sqlite_version() AS version").get() as {
					version: string;
				}
			).version,
			journalMode: db.query("PRAGMA journal_mode").get(),
			synchronous: db.query("PRAGMA synchronous").get(),
			transport: "bun:sqlite / file inside Docker",
		},
		transact: (docId, work) => {
			const task = serial.then(async () => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const result = await work(
						transaction(
							docId,
							async (statement, values = []) => {
								const prepared = db.query(statement);
								const bindings = values as (
									| string
									| number
									| Uint8Array
									| null
								)[];
								if (/^\s*(SELECT|WITH)/i.test(statement))
									return prepared.all(...bindings) as Record<string, unknown>[];
								prepared.run(...bindings);
								return [];
							},
							false,
						),
					);
					db.exec("COMMIT");
					return result;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			});
			serial = task.catch(() => undefined);
			return task;
		},
		close: async () => {
			await serial;
			db.close();
		},
	};
}
