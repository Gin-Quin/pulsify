import { deletionStoreConformance } from "./deletion-store.js";
import { object } from "@gin-quin/codec";
import {
	createPulse,
	definePulse,
	createPulseScope,
	getPulseMeta,
	destroyPulse,
	exportPulseUpdates,
	versioned,
} from "../source/index.js";
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { PostgresPatchStore } from "../source/storage/postgres.js";
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
import { lastRegisterOf } from "../source/core/operations.js";
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
					versioned(object({ count: "float64" })),
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
			// A row that starts among the writes another row replaced is ignored.
			expect(await store.append([row(docId, 3)])).toMatchObject({
				inserted: 0,
			});
			expect(await store.missing(docId, [])).toEqual([first]);
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
				versioned(object({ value: "float64" })),
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
				versioned(object({ value: "string" })),
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
		test("a row replaces the waiting rows that its span covers", async () => {
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
			// Its span says the writes that followed it were replaced.
			const long = { ...row(docId, 1, other), span: 3 };
			expect(await store.append([long])).toMatchObject({
				ready: 1,
				pending: 0,
			});
			expect(await store.missing(docId, [[actor, 3]])).toEqual([long]);
			// Waiting rows inserted earlier in the same batch are replaced too.
			const mine = row(docId, 4, actor, [[actor, 4]]);
			const wide = { ...row(docId, 3), span: 2 };
			expect(await store.append([mine, wide])).toMatchObject({
				ready: 1,
				pending: 0,
			});
			expect(await store.vector(docId)).toEqual([
				[actor, 5],
				[other, 4],
			]);
			expect(await store.missing(docId, [[other, 4]])).toEqual([
				row(docId),
				row(docId, 2),
				wide,
			]);
		});
		test("a waiting row that learns a longer span replaces the rows it covers", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const fifth = row(docId, 5),
				sixth = row(docId, 6);
			expect(await store.append([fifth, sixth])).toMatchObject({ pending: 2 });
			expect(await store.append([{ ...fifth, span: 3 }])).toMatchObject({
				pending: 1,
			});
			const first = { ...row(docId), span: 4 };
			expect(await store.append([first])).toMatchObject({
				ready: 2,
				pending: 0,
			});
			expect(await store.vector(docId)).toEqual([[actor, 8]]);
			expect(await store.missing(docId, [])).toEqual([
				first,
				{ ...fifth, span: 3 },
			]);
			// What it replaced is ignored when it comes again, whatever it holds.
			expect(
				await store.append([{ ...sixth, operations: Uint8Array.of(9) }]),
			).toMatchObject({ inserted: 0 });
		});
		test("the first row past a span must build on it", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			// Waiting rows: the second one says its actor's history ended at 7.
			await store.append([row(docId, 6), row(docId, 9, actor, [[actor, 7]])]);
			await expect(
				store.append([{ ...row(docId, 5), span: 3 }]),
			).rejects.toMatchObject({ code: "CONFLICT" });
			// The refused batch left the waiting rows as they were.
			expect(await store.append([row(docId, 6)])).toMatchObject({
				inserted: 0,
				pending: 2,
			});
		});
		test("a known row with a longer span only moves the frontier", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			const first = row(docId),
				second = row(docId, 2);
			await store.append([first, second]);
			// The sender replaced two writes after the second one.
			const result = await store.append([{ ...second, span: 3 }]);
			expect(result).toMatchObject({ pending: 0 });
			expect(result.inserted).toBeGreaterThan(0);
			expect(await store.vector(docId)).toEqual([[actor, 5]]);
			expect(await store.missing(docId, [])).toEqual([
				first,
				{ ...second, span: 3 },
			]);
			// Sent again, or shorter, it changes nothing; other contents conflict.
			for (const span of [1, 2, 3])
				expect(await store.append([{ ...second, span }])).toMatchObject({
					inserted: 0,
				});
			await expect(
				store.append([{ ...second, operations: Uint8Array.of(9) }]),
			).rejects.toMatchObject({ code: "CONFLICT" });
			const next = row(docId, 5, actor, [[actor, 5]]);
			expect(await store.append([next])).toMatchObject({ ready: 1 });
			expect(await store.missing(docId, [[actor, 3]])).toEqual([
				{ ...second, span: 3 },
				next,
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
// Set PULSIFY_TEST_POSTGRES to a database URL to run the same against PostgreSQL.
if (process.env["PULSIFY_TEST_POSTGRES"]) {
	const sql = new SQL(process.env["PULSIFY_TEST_POSTGRES"]);
	const postgres = new PostgresPatchStore((query, parameters) =>
		sql.unsafe(query, parameters as never[]),
	);
	const ready = postgres.initialize();
	conformance("PostgreSQL", async () => {
		await ready;
		return postgres;
	});
}
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
	/**
	 * A causally valid history of several actors, in an order that could be
	 * appended as is. With `values`, some rows are writes to one of a few
	 * registers without history, so that the stores keep holes in it.
	 */
	function history(
		docId: string,
		seed: number,
		length: number,
		values = false,
	) {
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
			const operations = new Uint8Array(values ? Math.max(size, 10) : size);
			for (let byte = 0; byte < Math.min(size, 64); byte++)
				operations[byte] = below(256);
			operations[operations.length - 1] = index & 255;
			if (values && next() < 0.4) {
				// Version 3, a Lamport time, no schema, one kind 7 write to
				// target `t`, field `f`: a row of the register `t.f`.
				const register = below(4);
				operations.set([
					3,
					1 + below(100),
					0,
					1,
					7,
					1,
					register,
					0,
					1,
					register,
				]);
			}
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
		// Starts where the next row does, with other contents and without
		// building on the actor's previous row: a conflict, or a fork.
		{ ...row, clock: row.clock + row.span, dependencies: [] },
	];

	for (const values of [false, true])
		for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
			test(`random history ${seed}${values ? " with values" : ""} reads and appends like its uncompacted twin`, async () => {
				const { next, below } = random(seed * 7919);
				const docId = `compaction-${seed}`;
				const plainDb = new Database(":memory:"),
					packedDb = new Database(":memory:");
				const plain = new SqlitePatchStore(plainDb),
					packed = new SqlitePatchStore(
						packedDb,
						seed % 2 ? { vectorCacheSize: 4 } : {},
					);
				const rows = history(docId, seed, 500 + below(400), values);
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
					expect(await both(sample.slice(0, 50))).toMatchObject({
						inserted: 0,
					});
					for (const row of sample.slice(0, 40))
						for (const conflict of altered(row)) {
							const result = await both([conflict]);
							// A write replaced since is no longer there to conflict with.
							if (!values) expect(typeof result).toBe("string");
						}
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
				const kept = rows.filter(
					(row) => !values || !lastRegisterOf(row.operations),
				);
				if (!values)
					expect(await plain.missing(docId, [])).toEqual(
						[...rows].sort((a, b) => a.sid - b.sid || a.clock - b.clock),
					);

				// Packing happened, on ready rows only, and a second pass finds nothing.
				expect(storedRows(plainDb)).toBe(kept.length);
				expect(storedRows(packedDb)).toBeLessThan(kept.length / 8);
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

deletionStoreConformance(
	"SQLite",
	async () =>
		new SqlitePatchStore(new Database(":memory:"), { vectorCacheSize: 128 }),
);

describe("storage performance and snapshot regressions", () => {
	// Build a valid varuint-encoded v3 kind-7 last-value write for arbitrary register index.
	const encodeValueOp = (registerId: number, lamport: number): Uint8Array => {
		const out: number[] = [];
		const pushUint = (n: number) => {
			for (; n >= 128; n = Math.floor(n / 128)) out.push((n % 128) | 128);
			out.push(n);
		};
		pushUint(3);
		pushUint(lamport);
		pushUint(0); // schema
		pushUint(1); // 1 op
		pushUint(7); // kind 7
		pushUint(1);
		out.push(114); // target "r"
		pushUint(1); // numeric field tag
		pushUint(registerId);
		pushUint(0); // layout
		pushUint(1);
		out.push(1);
		return Uint8Array.from(out);
	};

	test("S1: SQLite missing uses clock index and stays sub-quadratic in an actor's values", async () => {
		const measure = async (count: number) => {
			const db = new Database(":memory:");
			const store = new SqlitePatchStore(db);
			const docId = `s1-${count}`;
			const rows: StoredPatchRow[] = Array.from({ length: count }, (_, i) => ({
				docId,
				sid: actor,
				clock: i + 1,
				span: 1,
				dependencies: i === 0 ? [] : [[actor, i + 1]],
				operations: encodeValueOp(i + 1, i + 1),
			}));
			for (let i = 0; i < rows.length; i += 500)
				await store.append(rows.slice(i, i + 500));
			const start = performance.now();
			const result = await store.missing(docId, [[actor, count]]);
			const elapsed = performance.now() - start;
			expect(result).toHaveLength(1);
			expect(result[0]!.clock).toBe(count);
			const plan = db
				.query(
					"EXPLAIN QUERY PLAN SELECT clock FROM pulsify_values WHERE doc_id=? AND sid=? AND clock<=? ORDER BY clock DESC LIMIT 1",
				)
				.all(docId, actor, count)
				.map((r) => (r as { detail: string }).detail)
				.join(" ");
			expect(plan).toContain("pulsify_values_clock");
			db.close();
			return elapsed;
		};
		const t1 = await measure(400);
		const t4 = await measure(1600);
		// Quadratic scaling would be ~16x; indexed lookup is O(log V).
		expect(t4).toBeLessThan(Math.max(t1 * 8, 25));
	});

	test("S2: SQLite missing scales with behind actors, not actors x remote vector", async () => {
		const measure = async (actorsCount: number) => {
			const db = new Database(":memory:");
			const store = new SqlitePatchStore(db);
			const docId = `s2-${actorsCount}`;
			const rows: StoredPatchRow[] = [];
			for (let i = 0; i < actorsCount; i++) {
				const sid = actor + i;
				rows.push(row(docId, 1, sid), row(docId, 2, sid));
			}
			for (let i = 0; i < rows.length; i += 500)
				await store.append(rows.slice(i, i + 500));
			const remote: Array<[number, number]> = Array.from(
				{ length: actorsCount },
				(_, i) => [actor + i, i === actorsCount - 1 ? 2 : 3],
			);
			const start = performance.now();
			const result = await store.missing(docId, remote);
			const elapsed = performance.now() - start;
			expect(result).toHaveLength(1);
			expect(result[0]!.sid).toBe(actor + actorsCount - 1);
			db.close();
			return elapsed;
		};
		const t1 = await measure(200);
		const t4 = await measure(800);
		expect(t4).toBeLessThan(Math.max(t1 * 8, 25));
	});

	test("S3: SQLite missing and missingPage read vector, op rows and values from one WAL snapshot", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pulsify-s3-"));
		const file = join(dir, "wal.sqlite");
		const dbA = new Database(file);
		const dbB = new Database(file);
		try {
			dbA.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
			dbB.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
			const writer = new SqlitePatchStore(dbA);
			const docId = "wal-snap";
			await writer.append([row(docId, 1, actor), row(docId, 2, actor)]);
			// Inject a committed write on connection A right after connection B reads pulsify_doc_clocks.
			let injected = false;
			const reader = new SqlitePatchStore({
				exec: (sql) => dbB.exec(sql),
				transaction: (work) => dbB.transaction(work),
				query: (sql) => {
					const stmt = dbB.query(sql);
					return {
						run: (...args) => stmt.run(...args),
						get: (...args) => stmt.get(...args),
						all: (...args) => {
							const out = stmt.all(...args);
							if (!injected && sql.includes("FROM pulsify_doc_clocks")) {
								injected = true;
								void writer.append([
									row(docId, 3, actor),
									row(docId, 4, actor),
								]);
							}
							return out;
						},
					};
				},
			});
			const page = await reader.missingPage(docId, [[actor, 2]]);
			expect(injected).toBe(true);
			// Because reader holds a single WAL read transaction, it sees the snapshot before the concurrent append.
			expect(page.vv).toEqual([[actor, 3]]);
			expect(page.rows.map((r) => [r.clock, r.span])).toEqual([[2, 1]]);
			// Subsequent read sees the committed rows cleanly.
			const after = await reader.missingPage(docId, [[actor, 2]]);
			expect(after.vv).toEqual([[actor, 5]]);
			expect(after.rows.map((r) => [r.clock, r.span])).toEqual([
				[2, 1],
				[3, 1],
				[4, 1],
			]);
		} finally {
			dbA.close();
			dbB.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("S4: SQLite resending packed rows decodes each segment once and value lookups stay indexed", async () => {
		const measurePackedResend = async (count: number) => {
			const db = new Database(":memory:");
			const store = new SqlitePatchStore(db);
			const docId = `s4-${count}`;
			const rows: StoredPatchRow[] = Array.from({ length: count }, (_, i) => ({
				...row(docId, i + 1, actor),
				operations: new Uint8Array(40).fill(i & 255),
			}));
			await store.append(rows);
			await store.compact({ maxRows: count + 10, minRows: 2 });
			expect(storedRows(db, "packed=1")).toBe(1);
			const start = performance.now();
			const res = await store.append(rows);
			const elapsed = performance.now() - start;
			expect(res.inserted).toBe(0);
			db.close();
			return elapsed;
		};
		const t1 = await measurePackedResend(400);
		const t4 = await measurePackedResend(1600);
		// Linear in row count (<= ~4x), never quadratic (~16x).
		expect(t4).toBeLessThan(Math.max(t1 * 8, 30));

		// Resending values mixed with new values must not reload all actor values per write.
		const db = new Database(":memory:");
		const store = new SqlitePatchStore(db);
		const docId = "s4-values";
		const initial: StoredPatchRow[] = Array.from({ length: 1000 }, (_, i) => ({
			docId,
			sid: actor,
			clock: i + 1,
			span: 1,
			dependencies: i === 0 ? [] : [[actor, i + 1]],
			operations: encodeValueOp(i + 1, i + 1),
		}));
		await store.append(initial);
		const mixed: StoredPatchRow[] = [];
		for (let i = 1; i <= 100; i++) {
			mixed.push(initial[i]!);
			mixed.push({
				docId,
				sid: actor,
				clock: 1000 + i,
				span: 1,
				dependencies: [[actor, 1000 + i]],
				operations: encodeValueOp(1000 + i, 1000 + i),
			});
		}
		const start = performance.now();
		expect((await store.append(mixed)).inserted).toBe(100);
		expect(performance.now() - start).toBeLessThan(50);
		db.close();
	});

	test("S5: SQLite in-order appends do not read or JSON-parse unrelated pending rows", async () => {
		const measure = async (pendingCount: number) => {
			const db = new Database(":memory:");
			const store = new SqlitePatchStore(db);
			const docId = `s5-${pendingCount}`;
			const deps: Array<[number, number]> = Array.from(
				{ length: 10 },
				(_, k) => [70100 + k, 1],
			);
			const pendingRows = Array.from({ length: pendingCount }, (_, i) =>
				row(docId, i + 2, other, [[other, i + 2], ...deps]),
			);
			await store.append(pendingRows);
			let fullPendingReads = 0;
			const wrappedStore = new SqlitePatchStore({
				exec: (sql) => db.exec(sql),
				transaction: (work) => db.transaction(work),
				query: (sql) => {
					if (sql.includes("SELECT sid,time_start,time_end,dependencies"))
						fullPendingReads++;
					return db.query(sql);
				},
			});
			const start = performance.now();
			for (let i = 1; i <= 50; i++)
				expect(await wrappedStore.append([row(docId, i, actor)])).toMatchObject(
					{
						inserted: 1,
						ready: 1,
						pending: pendingCount,
					},
				);
			const elapsed = performance.now() - start;
			expect(fullPendingReads).toBe(0);
			db.close();
			return elapsed;
		};
		const t1 = await measure(400);
		const t4 = await measure(1600);
		expect(t4).toBeLessThan(Math.max(t1 * 8, 40));
	});

	test("S8: rowsFromFrame and storage validation avoid re-copying RunRow buffers", async () => {
		const { rowsFromFrame, validateRows } =
			await import("../source/storage/rows.js");
		const { decodeMessage } =
			await import("../source/connection/PulseMessage.js");
		const D = definePulse(
			"RunRowMemo",
			versioned(object({ value: "string" })),
		).materialize();
		const makeFrame = (count: number) => {
			const p = createPulse(
				D,
				{ id: `s8-${count}`, value: "" },
				{ scope: createPulseScope(), sessionId: actor },
			);
			try {
				const base = getPulseMeta(p).log.vector;
				for (let i = 1; i <= count; i++) p.value = `v-${i}-${"a".repeat(64)}`;
				return exportPulseUpdates(p, base, { peerVersion: 2 })[0]!;
			} finally {
				destroyPulse(p);
			}
		};
		const frame = makeFrame(500);
		const materialized = rowsFromFrame(frame);
		expect(materialized[0]!.operations).toBe(materialized[0]!.operations);
		expect(materialized[0]!.dependencies).toBe(materialized[0]!.dependencies);
		const decoded = decodeMessage(frame);
		if (!("rows" in decoded)) throw new Error("expected rows");
		// Calling validateRows repeatedly on RunRows reuses internal memoized views.
		validateRows(decoded.rows);
		const start = performance.now();
		for (let i = 0; i < 10; i++) validateRows(decoded.rows);
		expect(performance.now() - start).toBeLessThan(50);
	});

	test("S10: SqlitePatchStore skips DDL when schema is already current", async () => {
		const db = new Database(":memory:");
		new SqlitePatchStore(db);
		let execCalls = 0;
		const wrapped = {
			exec(sql: string) {
				execCalls++;
				return db.exec(sql);
			},
			query: (sql: string) => db.query(sql),
			transaction: <T>(work: () => T) => db.transaction(work),
		};
		for (let i = 0; i < 10; i++) new SqlitePatchStore(wrapped);
		expect(execCalls).toBe(0);
		// Dropping pulsify_values_clock simulates an older database: reopening recreates it.
		db.exec("DROP INDEX pulsify_values_clock");
		new SqlitePatchStore(wrapped);
		expect(execCalls).toBeGreaterThan(0);
		expect(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE name='pulsify_values_clock'",
				)
				.all(),
		).toHaveLength(1);
		db.close();
	});

	if (process.env["PULSIFY_TEST_POSTGRES"]) {
		test("S1 & S9: PostgreSQL drops pulsify_rows_frontier and indexes pulsify_values by clock", async () => {
			const sql = new SQL(process.env["PULSIFY_TEST_POSTGRES"]!);
			try {
				const pg = new PostgresPatchStore((q, p) =>
					sql.unsafe(q, p as never[]),
				);
				await pg.initialize();
				// Simulate a legacy DB that still carries pulsify_rows_frontier.
				await sql.unsafe(
					"CREATE INDEX IF NOT EXISTS pulsify_rows_frontier ON pulsify_op_rows(doc_id,sid,time_end)",
				);
				await pg.initialize();
				const indexes = (
					await sql.unsafe(
						"SELECT indexname FROM pg_indexes WHERE tablename IN ('pulsify_op_rows','pulsify_values')",
					)
				).map((r: { indexname: string }) => r.indexname);
				expect(indexes).not.toContain("pulsify_rows_frontier");
				expect(indexes).toContain("pulsify_values_clock");

				const measure = async (count: number) => {
					const docId = `pg-s1-${crypto.randomUUID()}`;
					const rows: StoredPatchRow[] = Array.from(
						{ length: count },
						(_, i) => ({
							docId,
							sid: actor,
							clock: i + 1,
							span: 1,
							dependencies: i === 0 ? [] : [[actor, i + 1]],
							operations: encodeValueOp(i + 1, i + 1),
						}),
					);
					for (let i = 0; i < rows.length; i += 500)
						await pg.append(rows.slice(i, i + 500));
					const start = performance.now();
					const res = await pg.missing(docId, [[actor, count]]);
					const elapsed = performance.now() - start;
					expect(res).toHaveLength(1);
					expect(res[0]!.clock).toBe(count);
					return elapsed;
				};
				const t1 = await measure(250);
				const t4 = await measure(1000);
				expect(t4).toBeLessThan(Math.max(t1 * 8, 50));
			} finally {
				await sql.close();
			}
		});
	}
});
