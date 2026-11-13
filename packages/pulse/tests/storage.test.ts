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
} from "../source/storage/sqlite.js";
import {
	encodeStoredRow,
	decodeStoredRow,
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
