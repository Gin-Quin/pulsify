import { object } from "@gin-quin/codec";
import {
	createPulse,
	definePulse,
	createPulseScope,
	getPulseMeta,
	destroyPulse,
	exportPulseUpdates,
} from "../source/index.js";
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	SQLITE_PATCH_SCHEMA,
	SqlitePatchStore,
	type SqliteCompactCursor,
} from "../source/storage/sqlite.js";
import {
	encodeStoredRow,
	decodeStoredRow,
	MAX_PACKED_BYTES,
	type PatchStore,
	type StoredPatchRow,
} from "../source/storage/rows.js";
import { encodeMessage } from "../source/connection/PulseMessage.js";
import { MAX_VECTOR_ENTRIES } from "../source/protocol/limits.js";

const actor = 70001,
	other = 70002;
function row(
	docId: string,
	clock = 1,
	sid = actor,
	dependencies: Array<[number, number]> = clock === 1 ? [] : [[sid, clock]],
): StoredPatchRow {
	return {
		docId,
		sid,
		clock,
		span: 1,
		dependencies,
		operations: new Uint8Array([clock, 0, 255]),
	};
}
function conformance(name: string, create: () => Promise<PatchStore>): void {
	describe(name, () => {
		test("state-only transport cannot be persisted as exact operation history", async () => {
			const store = await create(),
				docId = crypto.randomUUID(),
				D = definePulse(
					"StorageState",
					object({ count: "float64" }),
				).materialize();
			const pulse = createPulse(
				D,
				{ id: docId, count: 0 },
				{ scope: createPulseScope(), sessionId: actor },
			);
			try {
				const base = getPulseMeta(pulse).log.vector;
				for (let i = 1; i <= 100; i++) pulse.count = i;
				const delta = exportPulseUpdates(pulse, base, { peerVersion: 3 })[0]!;
				await expect(store.appendEncoded(delta)).rejects.toMatchObject({
					code: "HISTORY_UNAVAILABLE",
				});
				expect(await store.vector(docId)).toEqual([]);
				for (const frame of exportPulseUpdates(pulse, [], {
					peerVersion: 2,
					mode: "history",
				}))
					await store.appendEncoded(frame);
				expect((await store.missing(docId, [])).length).toBe(101);
			} finally {
				destroyPulse(pulse);
			}
		});

		test("append is opaque, idempotent, isolated and queryable from a vector", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const first = row(docId),
				second = row(docId, 2),
				another = row(docId, 1, other);
			expect(await store.append([first, second, another])).toMatchObject({
				inserted: 3,
				ready: 3,
				pending: 0,
			});
			expect(await store.append([first, second])).toMatchObject({
				inserted: 0,
				ready: 0,
				pending: 0,
			});
			expect(await store.vector(docId)).toEqual([
				[actor, 3],
				[other, 2],
			]);
			expect(
				await store.missing(docId, [
					[actor, 2],
					[other, 2],
				]),
			).toEqual([second]);
			expect(await store.missing(docId, [[actor, 3]])).toEqual([another]);
			expect(await store.missing(crypto.randomUUID(), [])).toEqual([]);
		});
		test("gaps and cross-actor dependencies remain dangling until satisfied", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const first = row(docId),
				second = row(docId, 2),
				third = row(docId, 3);
			const dependent = row(docId, 1, other, [[actor, 4]]);
			expect(await store.append([third, dependent, second])).toMatchObject({
				inserted: 3,
				ready: 0,
				pending: 3,
			});
			expect(await store.vector(docId)).toEqual([]);
			expect(await store.missing(docId, [])).toEqual([]);
			expect(await store.append([first])).toMatchObject({
				inserted: 1,
				ready: 4,
				pending: 0,
			});
			expect(await store.vector(docId)).toEqual([
				[actor, 4],
				[other, 2],
			]);
			expect(
				(await store.missing(docId, [])).map((r) => [r.sid, r.clock]),
			).toEqual([
				[actor, 1],
				[actor, 2],
				[actor, 3],
				[other, 1],
			]);
		});
		test("conflicting duplicates, partial overlaps and forks reject atomically", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const first = row(docId);
			first.span = 3;
			await store.append([first]);
			await expect(
				store.append([
					row(docId, 1, other),
					{ ...first, operations: new Uint8Array([9]) },
				]),
			).rejects.toThrow();
			expect(await store.vector(docId)).toEqual([[actor, 4]]);
			await expect(store.append([row(docId, 3)])).rejects.toThrow();
			await expect(store.append([row(docId, 7, actor, [])])).rejects.toThrow();
			const next = row(docId, 4, actor, [[actor, 4]]);
			await store.append([next]);
			expect(await store.missing(docId, [[actor, 2]])).toEqual([first, next]);
		});
		test("undeclared initial and later gaps never advance the contiguous frontier", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const jump = row(docId, 10, actor, []);
			expect(await store.append([jump])).toMatchObject({
				inserted: 1,
				ready: 0,
				pending: 1,
			});
			expect(await store.vector(docId)).toEqual([]);
			expect(await store.missing(docId, [])).toEqual([]);
			// A future row that omits its own predecessor is a fork; it cannot make
			// the claimed history appear complete when earlier rows are received.
			await expect(store.append([row(docId)])).rejects.toThrow();
			expect(await store.vector(docId)).toEqual([]);
			const batchDoc = crypto.randomUUID();
			expect(
				await store.append([
					row(batchDoc, 10, actor, []),
					row(batchDoc, 1, other),
				]),
			).toMatchObject({ inserted: 2, ready: 1, pending: 1 });
			expect(await store.vector(batchDoc)).toEqual([[other, 2]]);
			const laterDoc = crypto.randomUUID(),
				first = row(laterDoc);
			await store.append([first]);
			const later = row(laterDoc, 10, actor, [[actor, 2]]);
			expect(await store.append([later])).toMatchObject({
				inserted: 1,
				ready: 0,
				pending: 1,
			});
			expect(await store.vector(laterDoc)).toEqual([[actor, 2]]);
			expect(await store.missing(laterDoc, [[actor, 2]])).toEqual([]);
		});
		test("a declared out-of-order row still needs every earlier sequence number", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const second = row(docId, 2, actor, [[actor, 1]]);
			expect(await store.append([second])).toMatchObject({
				inserted: 1,
				ready: 0,
				pending: 1,
			});
			expect(await store.vector(docId)).toEqual([]);
			await expect(store.append([row(docId)])).rejects.toThrow();
			expect(await store.vector(docId)).toEqual([]);
			const recoverableDoc = crypto.randomUUID(),
				future = row(recoverableDoc, 10);
			await store.append([future]);
			const prefix = Array.from({ length: 9 }, (_, index) =>
				row(recoverableDoc, index + 1),
			);
			expect(await store.append(prefix)).toMatchObject({
				inserted: 9,
				ready: 10,
				pending: 0,
			});
			expect(await store.vector(recoverableDoc)).toEqual([[actor, 11]]);
		});
		test("accepts the normal encoded update without decoding its operation bytes", async () => {
			const store = await create(),
				docId = crypto.randomUUID(),
				first = row(docId);
			const frame = encodeMessage({
				kind: 4,
				docId,
				requestId: 1,
				vv: [],
				rows: [first],
			});
			expect(await store.appendEncoded(frame)).toMatchObject({
				inserted: 1,
				ready: 1,
				pending: 0,
			});
			expect(await store.missing(docId, [])).toEqual([first]);
		});
		test("grouped encoded ingress stores every exact row without an application schema", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const definition = definePulse(
				"StoredRun",
				object({ value: "float64" }),
			).materialize();
			const pulse = createPulse(
				definition,
				{ id: docId, value: 0 },
				{ scope: createPulseScope(), sessionId: 70001 },
			);
			try {
				const log = getPulseMeta(pulse).log;
				await store.append(log.missing([]));
				const vv = log.vector;
				for (let i = 1; i <= 100; i++) pulse.value = i;
				const frame = exportPulseUpdates(pulse, vv, { peerVersion: 2 })[0]!;
				expect(frame[0]).toBe(2);
				expect((await store.appendEncoded(frame)).inserted).toBe(100);
				expect(await store.missing(docId, [])).toEqual(log.missing([]));
				expect(await store.missing(docId, [[70001, 51]])).toEqual(
					log.missing([[70001, 51]]),
				);
				expect((await store.appendEncoded(frame)).inserted).toBe(0);
			} finally {
				destroyPulse(pulse);
			}
		});

		test("grouped large string payloads cross native chunks and remain idempotent", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const definition = definePulse(
				"StoredLargeRun",
				object({ value: "string" }),
			).materialize();
			const pulse = createPulse(
				definition,
				{ id: docId, value: "" },
				{ scope: createPulseScope(), sessionId: 70001 },
			);
			try {
				const log = getPulseMeta(pulse).log;
				await store.append(log.missing([]));
				const vv = log.vector;
				pulse.value = "a".repeat(70000);
				pulse.value = "é".repeat(70000);
				const frame = exportPulseUpdates(pulse, vv, { peerVersion: 2 })[0]!;
				expect(frame[0]).toBe(2);
				expect((await store.appendEncoded(frame)).inserted).toBe(2);
				expect((await store.appendEncoded(frame)).inserted).toBe(0);
				expect(await store.missing(docId, vv)).toEqual(log.missing(vv));
			} finally {
				destroyPulse(pulse);
			}
		});

		test("handles large binary payloads", async () => {
			const store = await create(),
				docId = crypto.randomUUID(),
				first = row(docId);
			first.operations = new Uint8Array(180_000);
			first.operations.fill(239);
			first.operations[0] = 31;
			await store.append([first]);
			expect((await store.missing(docId, []))[0]).toEqual(first);
		});
		test("parallel appends preserve the complete frontier", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			await Promise.all([
				store.append([row(docId, 2)]),
				store.append([row(docId)]),
				store.append([row(docId, 1, other)]),
			]);
			expect(await store.vector(docId)).toEqual([
				[actor, 3],
				[other, 2],
			]);
		});
		test("invalid batches and vectors fail before writing", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			await expect(
				store.append([row(docId), row("different-document", 1, other)]),
			).rejects.toThrow();
			await expect(
				store.append([{ ...row(docId), span: -1 }]),
			).rejects.toThrow();
			await expect(store.missing(docId, [[actor, 0]])).rejects.toThrow();
			expect(await store.vector(docId)).toEqual([]);
		});
		test("document IDs remain distinct through UTF-8 storage and reject lossy strings", async () => {
			const store = await create(),
				docId = `${crypto.randomUUID()}/\ufffd/🌍`;
			const first = row(docId);
			await store.append([first]);
			for (const invalid of ["", "\ud800", "\udc00", "document\0suffix"]) {
				await expect(store.append([row(invalid)])).rejects.toThrow(
					"Invalid document ID",
				);
				await expect(store.vector(invalid)).rejects.toThrow(
					"Invalid document ID",
				);
				await expect(store.missing(invalid, [])).rejects.toThrow(
					"Invalid document ID",
				);
			}
			expect(await store.missing(docId, [])).toEqual([first]);
		});
		test("actor capacity is enforced atomically for both ready and dangling history", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const rows = Array.from({ length: MAX_VECTOR_ENTRIES }, (_, i) =>
				row(docId, 1, actor + i),
			);
			for (let i = 0; i < rows.length; i += 128)
				await store.append(rows.slice(i, i + 128));
			const frontier = await store.vector(docId);
			expect(frontier).toHaveLength(MAX_VECTOR_ENTRIES);
			const overflow = row(docId, 2, actor + MAX_VECTOR_ENTRIES);
			await expect(store.append([row(docId, 2), overflow])).rejects.toThrow();
			expect(await store.vector(docId)).toEqual(frontier);
			expect(await store.missing(docId, frontier)).toEqual([]);
		}, 15000);
		test("in-order batches store every row and resends stay idempotent", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const rows = [1, 2, 3, 4, 5].map((clock) => row(docId, clock));
			expect(await store.append(rows)).toMatchObject({
				inserted: 5,
				ready: 5,
				pending: 0,
			});
			expect(await store.vector(docId)).toEqual([[actor, 6]]);
			expect(await store.append([rows[4]!])).toMatchObject({
				inserted: 0,
				ready: 0,
				pending: 0,
			});
			expect(await store.append([rows[0]!, rows[4]!])).toMatchObject({
				inserted: 0,
			});
			await expect(
				store.append([{ ...rows[4]!, operations: new Uint8Array([9]) }]),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: "Conflicting storage segment",
			});
			expect(await store.missing(docId, [])).toEqual(rows);
		});
		test("an in-order row that does not depend on its predecessor forks", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			await store.append([row(docId), row(docId, 2)]);
			for (const dependencies of [[], [[actor, 2]]] as Array<
				Array<[number, number]>
			>)
				await expect(
					store.append([
						row(docId, 1, other),
						row(docId, 3, actor, dependencies),
					]),
				).rejects.toMatchObject({
					code: "CONFLICT",
					message: "Actor history fork",
				});
			expect(await store.vector(docId)).toEqual([[actor, 3]]);
			expect(await store.append([row(docId, 3)])).toMatchObject({ ready: 1 });
		});
		test("in-order rows are checked against pending rows of their actor", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			// The other actor's gap keeps its row pending beside in-order appends.
			const gap = row(docId, 3, other, [[other, 3]]);
			expect(await store.append([gap])).toMatchObject({ pending: 1 });
			expect(await store.append([row(docId), row(docId, 2)])).toMatchObject({
				inserted: 2,
				ready: 2,
				pending: 1,
			});
			const long = { ...row(docId, 1, other), span: 3 };
			await expect(store.append([long])).rejects.toMatchObject({
				code: "CONFLICT",
				message: "Overlapping immutable storage segments",
			});
			// Pending rows inserted earlier in the same batch count too.
			const mine = row(docId, 4, actor, [[actor, 4]]);
			await expect(
				store.append([mine, { ...row(docId, 3), span: 2 }]),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: "Overlapping immutable storage segments",
			});
			expect(await store.vector(docId)).toEqual([[actor, 3]]);
			expect(
				await store.append([row(docId, 1, other), row(docId, 2, other)]),
			).toMatchObject({ inserted: 2, ready: 3, pending: 0 });
			expect(await store.vector(docId)).toEqual([
				[actor, 3],
				[other, 4],
			]);
		});
	});
}

test("encoded storage requests reject document IDs that cannot round-trip through UTF-8 or SQL", () => {
	for (const docId of ["\ud800", "\udc00", "document\0suffix"]) {
		expect(() =>
			encodeMessage({
				kind: 4,
				docId,
				requestId: 1,
				vv: [],
				rows: [row(docId)],
			}),
		).toThrow("Invalid document ID");
		expect(() => encodeStoredRow(row(docId))).toThrow("Invalid document ID");
	}
	const valid = row("replacement/\ufffd/🌍");
	expect(decodeStoredRow(encodeStoredRow(valid))).toEqual(valid);
});

const sqlite = new Database(":memory:");
conformance("SQLite actual database", async () => new SqlitePatchStore(sqlite));
conformance(
	"SQLite with a vector cache",
	async () => new SqlitePatchStore(sqlite, { vectorCacheSize: 2 }),
);
afterAll(() => sqlite.close());

test("SQLite vector cache only keeps committed vectors", async () => {
	const database = new Database(":memory:");
	let rollback = false;
	// Runs the whole append, then aborts it as a failed commit would.
	const store = new SqlitePatchStore(
		{
			exec: (sql) => database.exec(sql),
			query: (sql) => database.query(sql),
			transaction: (work) => {
				const run = database.transaction(() => {
					const result = work();
					if (rollback) throw new Error("rolled back");
					return result;
				});
				return Object.assign(() => run(), { immediate: () => run.immediate() });
			},
		},
		{ vectorCacheSize: 1 },
	);
	const docId = crypto.randomUUID();
	const { vector } = await store.append([row(docId), row(docId, 2)]);
	expect(vector).toEqual([[actor, 3]]);
	expect(await store.vector(docId)).toEqual(vector!);
	rollback = true;
	await expect(store.append([row(docId, 1, other)])).rejects.toThrow();
	rollback = false;
	expect(await store.vector(docId)).toEqual([[actor, 3]]);
	await store.append([row(crypto.randomUUID())]); // evicts docId
	const next = await store.append([row(docId, 1, other)]);
	expect(next.vector).toEqual([
		[actor, 3],
		[other, 2],
	]);
	expect(await store.vector(docId)).toEqual(next.vector!);
	database.close();
});

test("SQLite batch path deduplicates identical input and rolls back equivocation", async () => {
	const store = new SqlitePatchStore(sqlite);
	const docId = crypto.randomUUID(),
		first = row(docId),
		second = row(docId, 2);
	expect(await store.append([first, first, second, second])).toMatchObject({
		inserted: 2,
		ready: 2,
		pending: 0,
	});
	const fresh = row(docId, 1, other);
	await expect(
		store.append([fresh, { ...fresh, operations: new Uint8Array([9]) }]),
	).rejects.toThrow();
	expect(await store.vector(docId)).toEqual([[actor, 3]]);
});
test("SQLite causal batch promotion agrees with an independent dependency closure", async () => {
	const store = new SqlitePatchStore(sqlite);
	const docId = crypto.randomUUID(),
		actors = [70001, 70002, 70003];
	const generated: StoredPatchRow[] = [],
		frontier = new Map<number, number>();
	let seed = 19937;
	const random = (): number => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	for (let i = 0; i < 60; i++) {
		const sid = actors[random() % actors.length]!,
			clock = frontier.get(sid) ?? 1;
		const dependencies = [...frontier]
			.filter(([peer]) => peer === sid || random() % 2 === 0)
			.sort((a, b) => a[0] - b[0]) as Array<[number, number]>;
		generated.push(row(docId, clock, sid, dependencies));
		frontier.set(sid, clock + 1);
	}
	const shuffled = generated.slice();
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = random() % (i + 1);
		[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
	}
	const received: StoredPatchRow[] = [],
		expected = new Map<number, number>();
	for (let i = 0; i < shuffled.length; i += 7) {
		const batch = shuffled.slice(i, i + 7);
		received.push(...batch);
		await store.append(batch);
		const waiting = received.slice();
		let changed: boolean;
		do {
			changed = false;
			for (let j = waiting.length - 1; j >= 0; j--) {
				const candidate = waiting[j]!;
				if (
					candidate.dependencies.every(
						([sid, clock]) => (expected.get(sid) ?? 0) >= clock,
					)
				) {
					expected.set(
						candidate.sid,
						Math.max(
							expected.get(candidate.sid) ?? 0,
							candidate.clock + candidate.span,
						),
					);
					waiting.splice(j, 1);
					changed = true;
				}
			}
		} while (changed);
		expect(await store.vector(docId)).toEqual(
			[...expected].sort((a, b) => a[0] - b[0]),
		);
	}
	expect(await store.vector(docId)).toEqual(
		[...frontier].sort((a, b) => a[0] - b[0]),
	);
});
test("SQLite missing seeks each actor from the row holding the remote clock", async () => {
	const db = new Database(":memory:");
	// Databases created before the frontier index was dropped still carry it.
	db.exec(
		SQLITE_PATCH_SCHEMA.replace(
			"DROP INDEX IF EXISTS pulsify_rows_frontier;",
			"CREATE INDEX pulsify_rows_frontier ON pulsify_op_rows(doc_id, sid, time_end);",
		),
	);
	const index =
		"SELECT name FROM sqlite_master WHERE name='pulsify_rows_frontier'";
	expect(db.query(index).all()).toHaveLength(1);
	const store = new SqlitePatchStore(db);
	expect(db.query(index).all()).toEqual([]);
	const docId = crypto.randomUUID(),
		third = 70003;
	const span = (
		sid: number,
		clock: number,
		length: number,
	): StoredPatchRow => ({
		...row(docId, clock, sid),
		span: length,
	});
	const ready = [
		span(actor, 1, 1),
		span(actor, 2, 3),
		span(actor, 5, 1),
		span(other, 1, 2),
		span(third, 1, 1),
		span(third, 2, 2),
	];
	// The gap keeps this row pending: it is never returned.
	await store.append([...ready, span(actor, 7, 1)]);
	expect(await store.vector(docId)).toEqual([
		[actor, 6],
		[other, 3],
		[third, 4],
	]);
	const expected = (remote: Array<[number, number]>) =>
		ready.filter(
			(stored) =>
				stored.clock + stored.span >
				(remote.find(([sid]) => sid === stored.sid)?.[1] ?? 0),
		);
	// Before, inside (straddling), at the end of and past the multi-span row.
	for (const clock of [1, 2, 3, 4, 5, 6, 9])
		for (const remote of [
			[[actor, clock]],
			[
				[actor, clock],
				[other, 3],
			],
			[
				[actor, clock],
				[other, 2],
				[third, clock],
				[70009, 5],
			],
		] as Array<Array<[number, number]>>)
			expect(await store.missing(docId, remote)).toEqual(expected(remote));
	expect(await store.missing(docId, [])).toEqual(ready);
	db.close();
});

/** A deterministic generator, so a failing history can be replayed from its seed. */
function random(seed: number) {
	const next = () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return { next, below: (limit: number) => Math.floor(next() * limit) };
}
/** What a peer can observe of an append: its result, or how it was refused. */
async function outcome(store: SqlitePatchStore, rows: StoredPatchRow[]) {
	try {
		return await store.append(rows);
	} catch (error) {
		return `${(error as { code?: string }).code}: ${(error as Error).message}`;
	}
}
const storedRows = (db: Database, where = "1") =>
	(
		db
			.query(`SELECT COUNT(*) AS count FROM pulsify_op_rows WHERE ${where}`)
			.get() as { count: number }
	).count;
async function compactAll(
	store: SqlitePatchStore,
	options: { maxRows?: number; minRows?: number } = {},
	calls = Infinity,
) {
	let after: SqliteCompactCursor | undefined;
	let rows = 0;
	do {
		const result = await store.compact({ ...options, after });
		rows += result.rows;
		after = result.next;
	} while (after && --calls > 0);
	return rows;
}

describe("SQLite compaction is invisible to peers", () => {
	const actors = [70001, 70002, 70003, 70004];
	/** A causally valid history of several actors, in an order that could be appended as is. */
	function history(docId: string, seed: number, length: number) {
		const { next, below } = random(seed);
		const frontier = new Map<number, number>();
		const rows: StoredPatchRow[] = [];
		for (let index = 0; index < length; index++) {
			// The first actor writes most rows, as one person typing does.
			const sid = next() < 0.6 ? actors[0]! : actors[1 + below(3)]!;
			const clock = frontier.get(sid) ?? 1;
			const span = next() < 0.8 ? 1 : 2 + below(3);
			const dependencies = new Map<number, number>();
			if (clock > 1) dependencies.set(sid, clock);
			for (const [other, end] of frontier)
				if (other !== sid && next() < 0.3)
					dependencies.set(other, 1 + below(end));
			const size =
				next() < 0.02
					? // Rarely too large for any segment, or large enough to fill one.
						next() < 0.2
						? MAX_PACKED_BYTES + 1
						: 20_000 + below(60_000)
					: next() < 0.1
						? 4000 + below(400)
						: 1 + below(40);
			const operations = new Uint8Array(size);
			for (let byte = 0; byte < Math.min(size, 64); byte++)
				operations[byte] = below(256);
			operations[size - 1] = index & 255;
			rows.push({
				docId,
				sid,
				clock,
				span,
				dependencies: [...dependencies].sort((a, b) => a[0] - b[0]),
				operations,
			});
			frontier.set(sid, clock + span);
		}
		return rows;
	}
	const altered = (row: StoredPatchRow): StoredPatchRow[] => [
		{ ...row, operations: Uint8Array.of(...row.operations.slice(0, 8), 7) },
		{ ...row, span: row.span + 1 },
		{
			...row,
			dependencies: [
				...row.dependencies.filter(([sid]) => sid < 80000),
				[80000, 1],
			],
		},
		// Starts inside the row, or inside the one before: an overlap.
		...(row.span > 1
			? [
					{
						...row,
						clock: row.clock + 1,
						dependencies: [[row.sid, row.clock + 1]] as [number, number][],
					},
				]
			: []),
		{
			...row,
			clock: row.clock - 1,
			span: row.span + 1,
			dependencies: row.clock > 2 ? [[row.sid, row.clock - 1]] : [],
		},
		// Starts where it does, without building on the actor's previous row: a fork.
		{ ...row, clock: row.clock + row.span, dependencies: [] },
	];

	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
		test(`random history ${seed} reads and appends like its uncompacted twin`, async () => {
			const { next, below } = random(seed * 7919);
			const docId = `compaction-${seed}`;
			const plainDb = new Database(":memory:"),
				packedDb = new Database(":memory:");
			const plain = new SqlitePatchStore(plainDb),
				packed = new SqlitePatchStore(
					packedDb,
					seed % 2 ? { vectorCacheSize: 4 } : {},
				);
			const rows = history(docId, seed, 500 + below(400));
			const cut = Math.floor(rows.length * 0.7);
			// Some rows arrive late: what follows them waits, dangling.
			const late = new Set<StoredPatchRow>();
			for (let count = 3 + below(4); count > 0; count--)
				late.add(rows[100 + below(cut - 100)]!);
			const both = async (batch: StoredPatchRow[]) => {
				const expected = await outcome(plain, batch);
				expect(await outcome(packed, batch)).toEqual(expected);
				return expected;
			};
			const deliver = async (queue: StoredPatchRow[]) => {
				for (let start = 0; start < queue.length;) {
					const batch = queue.slice(start, (start += 1 + below(40)));
					if (next() < 0.3) batch.reverse();
					expect(typeof (await both(batch))).toBe("object");
					// Sleep cycles of every size, some interrupted before the end.
					if (next() < 0.25)
						await compactAll(
							packed,
							{ maxRows: 2 + below(300), minRows: 2 + below(30) },
							next() < 0.5 ? 1 + below(3) : Infinity,
						);
				}
			};
			const same = async () => {
				const vector = await plain.vector(docId);
				expect(await packed.vector(docId)).toEqual(vector);
				const remotes: [number, number][][] = [[], vector];
				for (let count = 0; count < 60; count++)
					remotes.push(
						[...actors, 80000]
							.filter(() => next() < 0.7)
							.map((sid): [number, number] => {
								const end = new Map(vector).get(sid) ?? 3;
								// Mostly behind, anywhere in the history; sometimes ahead.
								return [sid, 1 + below(next() < 0.9 ? end : end + 5)];
							}),
					);
				for (const remote of remotes)
					expect(await packed.missing(docId, remote)).toEqual(
						await plain.missing(docId, remote),
					);
			};
			const resend = async (sent: StoredPatchRow[]) => {
				const sample = sent.filter(() => next() < 0.2);
				for (const row of sample)
					expect(await both([row])).toMatchObject({ inserted: 0 });
				expect(await both(sample.slice(0, 50))).toMatchObject({ inserted: 0 });
				for (const row of sample.slice(0, 40))
					for (const conflict of altered(row))
						if (conflict.clock > 0)
							expect(typeof (await both([conflict]))).toBe("string");
			};

			const sent = rows.slice(0, cut).filter((row) => !late.has(row));
			await deliver(sent);
			expect(storedRows(plainDb, "ready=0")).toBeGreaterThan(0);
			await compactAll(packed, { maxRows: 50 + below(200), minRows: 8 });
			await same();
			await resend(sent);
			await same();

			// The rest of the history, the late rows last: everything becomes ready.
			await deliver(rows.slice(cut).filter((row) => !late.has(row)));
			await same();
			await deliver(rows.filter((row) => late.has(row)));
			expect(storedRows(plainDb, "ready=0")).toBe(0);
			expect(await compactAll(packed, { minRows: 2 })).toBeGreaterThan(0);
			await same();
			await resend(rows);
			await same();
			expect(await plain.missing(docId, [])).toEqual(
				[...rows].sort((a, b) => a.sid - b.sid || a.clock - b.clock),
			);

			// Packing happened, on ready rows only, and a second pass finds nothing.
			expect(storedRows(plainDb)).toBe(rows.length);
			expect(storedRows(packedDb)).toBeLessThan(rows.length / 10);
			expect(storedRows(packedDb, "packed=1")).toBeGreaterThan(0);
			expect(storedRows(packedDb, "packed=1 AND ready=0")).toBe(0);
			expect(
				storedRows(packedDb, `length(operations) > ${MAX_PACKED_BYTES}`),
			).toBe(storedRows(plainDb, `length(operations) > ${MAX_PACKED_BYTES}`));
			expect(await compactAll(packed, { minRows: 2 })).toBe(0);
			plainDb.close();
			packedDb.close();
		});

	test("an untouched store keeps one row per update, and tiny documents are left alone", async () => {
		const db = new Database(":memory:");
		const store = new SqlitePatchStore(db);
		const small = "compaction-small",
			large = "compaction-large";
		await store.append(Array.from({ length: 63 }, (_, i) => row(small, i + 1)));
		await store.append(Array.from({ length: 64 }, (_, i) => row(large, i + 1)));
		expect(storedRows(db, "packed=1")).toBe(0);
		expect(await store.compact()).toEqual({
			rows: 64,
			segments: 1,
			next: undefined,
		});
		expect(storedRows(db, `doc_id='${small}'`)).toBe(63);
		expect(storedRows(db, `doc_id='${large}'`)).toBe(1);
		db.close();
	});

	test("each call reads a bounded number of rows and says where to resume", async () => {
		const db = new Database(":memory:");
		const store = new SqlitePatchStore(db);
		const docId = "compaction-budget";
		const rows = Array.from({ length: 1000 }, (_, i) => row(docId, i + 1));
		await store.append(rows);
		const first = await store.compact({ maxRows: 300 });
		expect(first).toEqual({
			rows: 300,
			segments: 1,
			next: [docId, actor, 300],
		});
		expect(storedRows(db)).toBe(701);
		expect(await store.missing(docId, [])).toEqual(rows);
		// The following calls extend the segment instead of starting new ones.
		expect(await compactAll(store, { maxRows: 300 })).toBe(700);
		expect(storedRows(db)).toBe(1);
		expect(await store.missing(docId, [[actor, 998]])).toEqual(rows.slice(-3));
		db.close();
	});

	test("sleep cycles extend the last segment up to its size limit", async () => {
		const db = new Database(":memory:");
		const store = new SqlitePatchStore(db);
		const docId = "compaction-cycles";
		const wide = (clock: number): StoredPatchRow => ({
			...row(docId, clock),
			operations: new Uint8Array(1000).fill(clock),
		});
		const rows = Array.from({ length: 700 }, (_, i) => wide(i + 1));
		for (let start = 0; start < rows.length; start += 100) {
			await store.append(rows.slice(start, start + 100));
			expect(await compactAll(store)).toBe(100);
			// 100 KB per cycle: a segment holds two cycles and most of a third.
			expect(storedRows(db)).toBe(
				Math.ceil(((start + 100) * 1008.8) / MAX_PACKED_BYTES),
			);
		}
		expect(storedRows(db)).toBe(3);
		const { bytes } = db
			.query("SELECT MAX(length(operations)) AS bytes FROM pulsify_op_rows")
			.get() as { bytes: number };
		expect(bytes).toBeLessThanOrEqual(MAX_PACKED_BYTES);
		expect(bytes).toBeGreaterThan(MAX_PACKED_BYTES - 1010);
		expect(await store.missing(docId, [])).toEqual(rows);
		// An in-order append after a packed segment reads no row of it.
		expect(await store.append([wide(701)])).toMatchObject({ inserted: 1 });
		expect(await store.append([wide(701)])).toMatchObject({ inserted: 0 });
		db.close();
	});

	test("a database created before packed segments is migrated in place", async () => {
		const db = new Database(":memory:");
		db.exec(
			SQLITE_PATCH_SCHEMA.replace(" packed INTEGER NOT NULL DEFAULT 0,\n", ""),
		);
		const insert = db.query(
			"INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready) VALUES(?,?,?,1,?,?,1)",
		);
		const docId = "compaction-migrated";
		const rows = Array.from({ length: 100 }, (_, i) => row(docId, i + 1));
		for (const each of rows)
			insert.run(
				docId,
				actor,
				each.clock,
				JSON.stringify(each.dependencies),
				each.operations,
			);
		db.query("INSERT INTO pulsify_doc_clocks VALUES(?,?,101)").run(
			docId,
			actor,
		);
		const columns = () =>
			db
				.query("SELECT name FROM pragma_table_info('pulsify_op_rows')")
				.all()
				.map((column) => (column as { name: string }).name);
		expect(columns()).not.toContain("packed");
		const store = new SqlitePatchStore(db);
		expect(columns()).toContain("packed");
		expect(await store.missing(docId, [])).toEqual(rows);
		expect(await compactAll(store)).toBe(100);
		expect(storedRows(db)).toBe(1);
		// Opening it again changes nothing.
		const again = new SqlitePatchStore(db);
		expect(await again.missing(docId, [])).toEqual(rows);
		expect(await again.append([row(docId, 101)])).toMatchObject({ ready: 1 });
		expect(storedRows(db, "ready=0")).toBe(0);
		db.close();
	});
});
