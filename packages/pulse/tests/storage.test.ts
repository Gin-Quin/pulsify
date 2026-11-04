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
import { SQL } from "bun";
import { PostgresPatchStore } from "../source/storage/postgres.js";
import { SqlitePatchStore } from "../source/storage/sqlite.js";
import { FoundationDBPatchStore } from "../source/storage/foundationdb.js";
import {
	encodeStoredRow,
	decodeStoredRow,
	type PatchStore,
	type StoredPatchRow,
} from "../source/storage/rows.js";
import { encodeMessage } from "../source/connection/PulseMessage.js";
import { MAX_VECTOR_ENTRIES } from "../source/protocol/limits.js";
import { DockerFoundationDB } from "./storage-fdb-helper.js";

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
			expect(await store.append([first, second, another])).toEqual({
				inserted: 3,
				ready: 3,
				pending: 0,
			});
			expect(await store.append([first, second])).toEqual({
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
			expect(await store.append([third, dependent, second])).toEqual({
				inserted: 3,
				ready: 0,
				pending: 3,
			});
			expect(await store.vector(docId)).toEqual([]);
			expect(await store.missing(docId, [])).toEqual([]);
			expect(await store.append([first])).toEqual({
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
			expect(await store.append([jump])).toEqual({
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
			).toEqual({ inserted: 2, ready: 1, pending: 1 });
			expect(await store.vector(batchDoc)).toEqual([[other, 2]]);
			const laterDoc = crypto.randomUUID(),
				first = row(laterDoc);
			await store.append([first]);
			const later = row(laterDoc, 10, actor, [[actor, 2]]);
			expect(await store.append([later])).toEqual({
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
			expect(await store.append([second])).toEqual({
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
			expect(await store.append(prefix)).toEqual({
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
			expect(await store.appendEncoded(frame)).toEqual({
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

		test("handles payloads larger than the FoundationDB single-value limit", async () => {
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

test("FoundationDB budgets UTF-8 document keys and conflict ranges before starting a transaction", async () => {
	let transactions = 0;
	const store = new FoundationDBPatchStore({
		transact: async () => {
			transactions++;
			throw new Error("Unexpected transaction");
		},
	});
	const docId = "界".repeat(1024);
	const rows = Array.from({ length: 512 }, (_, i) => row(docId, i + 1));
	await expect(store.append(rows)).rejects.toMatchObject({
		code: "LIMIT_EXCEEDED",
	});
	expect(transactions).toBe(0);
});

const sqlite = new Database(":memory:");
conformance("SQLite actual database", async () => new SqlitePatchStore(sqlite));
afterAll(() => sqlite.close());

const postgresUrl = process.env["PULSIFY_POSTGRES_URL"];
if (postgresUrl) {
	const sql = new SQL(postgresUrl);
	const store = new PostgresPatchStore((statement, values) =>
		sql.unsafe(statement, values as never[]),
	);
	const initialized = store.initialize();
	conformance("PostgreSQL actual database", async () => {
		await initialized;
		return store;
	});
	test("PostgreSQL batch path deduplicates identical input and rolls back equivocation", async () => {
		await initialized;
		const docId = crypto.randomUUID(),
			first = row(docId),
			second = row(docId, 2);
		expect(await store.append([first, first, second, second])).toEqual({
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
	test("PostgreSQL causal batch promotion agrees with an independent dependency closure", async () => {
		await initialized;
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
	afterAll(() => sql.close());
} else test.skip("PostgreSQL integration: set PULSIFY_POSTGRES_URL", () => {});

const fdbContainer = process.env["PULSIFY_FDB_DOCKER"];
if (fdbContainer) {
	const db = new DockerFoundationDB(fdbContainer);
	const store = new FoundationDBPatchStore(
		db,
		`pulsify-test-${crypto.randomUUID()}/`,
	);
	conformance("FoundationDB actual database", async () => store);
	test("FoundationDB namespaces cannot alias payload and pending metadata prefixes", async () => {
		const prefix = `namespace-${crypto.randomUUID()}/`;
		const first = new FoundationDBPatchStore(db, prefix);
		const second = new FoundationDBPatchStore(db, `${prefix}p/6`);
		const sid = Number.parseInt("01010101010101", 16);
		// The collision needs a large clock in its physical key. Represent its
		// preceding range explicitly so the fixture also respects contiguous frontiers.
		const prefixRow = { ...row("m", 1, sid), span: sid - 1 };
		const firstRow = {
			...row("m", sid, sid, [[sid, sid]]),
			operations: new Uint8Array(65537).fill(239),
		};
		const secondRow = row("\x01".repeat(7), 1, sid);
		await first.append([prefixRow, firstRow]);
		await second.append([secondRow]);
		expect(await first.missing(firstRow.docId, [[sid, sid]])).toEqual([
			firstRow,
		]);
		expect(await second.missing(secondRow.docId, [])).toEqual([secondRow]);
		expect(() => new FoundationDBPatchStore(db, "\ud800")).toThrow(
			"Invalid FoundationDB namespace",
		);
	});
	test("FoundationDB retries conflicting transactions from independent connections", async () => {
		const clients = Array.from(
			{ length: 4 },
			() => new DockerFoundationDB(fdbContainer),
		);
		const namespace = `concurrent-${crypto.randomUUID()}/`,
			docId = crypto.randomUUID();
		const stores = clients.map(
			(client) => new FoundationDBPatchStore(client, namespace),
		);
		try {
			await Promise.all(
				stores.map((concurrent, i) => concurrent.append([row(docId, i + 1)])),
			);
			expect(await stores[0]!.vector(docId)).toEqual([[actor, 5]]);
			expect(
				(await stores[0]!.missing(docId, [])).map((item) => item.clock),
			).toEqual([1, 2, 3, 4]);
		} finally {
			await Promise.all(clients.map((client) => client.close()));
		}
	});
	afterAll(() => db.close());
} else test.skip("FoundationDB integration: set PULSIFY_FDB_DOCKER", () => {});
