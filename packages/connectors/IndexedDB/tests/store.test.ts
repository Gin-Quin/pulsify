import { describe, expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseMeta,
} from "pulsify-core";
import { encodeMessage } from "pulsify-core/protocol";
import type { StoredPatchRow } from "pulsify-core/storage";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDbPatchStore } from "../source/index";

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
function storeOptions() {
	return {
		name: crypto.randomUUID(),
		indexedDB: new IDBFactory(),
		IDBKeyRange,
	};
}
const create = () => new IndexedDbPatchStore(storeOptions());

describe("IndexedDbPatchStore", () => {
	test("append is opaque, idempotent, isolated and queryable from a vector", async () => {
		const store = create(),
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
		expect(await store.append([first, first])).toEqual({
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
		expect(await store.missing(docId, [])).toEqual([first, second, another]);
		expect(await store.missing(crypto.randomUUID(), [])).toEqual([]);
		expect(await store.append([])).toEqual({
			inserted: 0,
			ready: 0,
			pending: 0,
		});
	});

	test("documents sharing a prefix stay isolated", async () => {
		const store = create();
		await store.append([row("a")]);
		await store.append([row("a/b"), row("a/b", 2)]);
		await store.append([row("ab", 1, other)]);
		expect(await store.vector("a")).toEqual([[actor, 2]]);
		expect(await store.vector("a/b")).toEqual([[actor, 3]]);
		expect(await store.vector("ab")).toEqual([[other, 2]]);
		expect(await store.missing("a", [])).toEqual([row("a")]);
		await store.forget("a");
		expect(await store.vector("a")).toEqual([]);
		expect(await store.missing("a", [])).toEqual([]);
		expect(await store.vector("a/b")).toEqual([[actor, 3]]);
		await store.clear();
		expect(await store.vector("a/b")).toEqual([]);
		expect(await store.vector("ab")).toEqual([]);
	});

	test("gaps and cross-actor dependencies remain pending until satisfied", async () => {
		const store = create(),
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
		expect(await store.missing(docId, [])).toEqual([
			first,
			second,
			third,
			dependent,
		]);
	});

	test("conflicting duplicates, partial overlaps and forks reject atomically", async () => {
		const store = create(),
			docId = crypto.randomUUID();
		const first = row(docId);
		first.span = 3;
		await store.append([first]);
		const fresh = row(docId, 1, other);
		await expect(
			store.append([fresh, { ...first, operations: new Uint8Array([9]) }]),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await store.vector(docId)).toEqual([[actor, 4]]);
		expect(await store.missing(docId, [[actor, 4]])).toEqual([]);
		await expect(
			store.append([fresh, { ...fresh, operations: new Uint8Array([9]) }]),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(store.append([row(docId, 3)])).rejects.toMatchObject({
			code: "CONFLICT",
		});
		await expect(
			store.append([row(docId, 7, actor, [])]),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await store.vector(docId)).toEqual([[actor, 4]]);
		const next = row(docId, 4, actor, [[actor, 4]]);
		await store.append([next]);
		expect(await store.missing(docId, [[actor, 2]])).toEqual([first, next]);
		expect(await store.missing(docId, [[actor, 4]])).toEqual([next]);
	});

	test("forks inside one batch and against pending rows are rejected", async () => {
		const store = create(),
			docId = crypto.randomUUID();
		await expect(
			store.append([row(docId), row(docId, 2), row(docId, 3, actor, [])]),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await store.missing(docId, [])).toEqual([]);
		expect(await store.append([row(docId, 10, actor, [])])).toEqual({
			inserted: 1,
			ready: 0,
			pending: 1,
		});
		// A future row that omits its own predecessor is a fork.
		await expect(store.append([row(docId)])).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(await store.vector(docId)).toEqual([]);
		const later = crypto.randomUUID();
		await store.append([row(later)]);
		expect(await store.append([row(later, 10, actor, [[actor, 2]])])).toEqual({
			inserted: 1,
			ready: 0,
			pending: 1,
		});
		expect(await store.vector(later)).toEqual([[actor, 2]]);
		expect(await store.missing(later, [[actor, 2]])).toEqual([]);
	});

	test("out-of-order history is promoted once its prefix arrives", async () => {
		const store = create(),
			docId = crypto.randomUUID();
		await store.append([row(docId, 10)]);
		const prefix = Array.from({ length: 9 }, (_, i) => row(docId, i + 1));
		expect(await store.append(prefix.slice(4))).toEqual({
			inserted: 5,
			ready: 0,
			pending: 6,
		});
		expect(await store.append(prefix.slice(0, 4))).toEqual({
			inserted: 4,
			ready: 10,
			pending: 0,
		});
		expect(await store.vector(docId)).toEqual([[actor, 11]]);
		expect(
			(await store.missing(docId, [[actor, 8]])).map((r) => r.clock),
		).toEqual([8, 9, 10]);
	});

	test("random causal histories agree with an independent closure", async () => {
		const store = create(),
			docId = crypto.randomUUID(),
			actors = [70001, 70002, 70003];
		const generated: StoredPatchRow[] = [],
			frontier = new Map<number, number>();
		let seed = 19937;
		const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
		for (let i = 0; i < 60; i++) {
			const sid = actors[random() % actors.length]!,
				clock = frontier.get(sid) ?? 1;
			const dependencies = [...frontier]
				.filter(([peer]) => peer === sid || random() % 2 === 0)
				.sort((a, b) => a[0] - b[0]);
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
			const waiting = received.filter(
				(candidate) => (expected.get(candidate.sid) ?? 1) <= candidate.clock,
			);
			let changed: boolean;
			do {
				changed = false;
				for (let j = waiting.length - 1; j >= 0; j--) {
					const candidate = waiting[j]!;
					if (
						candidate.clock === (expected.get(candidate.sid) ?? 1) &&
						candidate.dependencies.every(
							([sid, clock]) => (expected.get(sid) ?? 0) >= clock,
						)
					) {
						expected.set(candidate.sid, candidate.clock + candidate.span);
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
		expect(await store.missing(docId, [])).toEqual(
			generated.slice().sort((a, b) => a.sid - b.sid || a.clock - b.clock),
		);
	});

	test("parallel appends preserve the complete frontier", async () => {
		const store = create(),
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

	test("invalid batches, vectors and document IDs fail before writing", async () => {
		const store = create(),
			docId = crypto.randomUUID();
		await expect(
			store.append([row(docId), row("different-document", 1, other)]),
		).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
		await expect(store.append([{ ...row(docId), span: -1 }])).rejects.toThrow();
		await expect(store.missing(docId, [[actor, 0]])).rejects.toThrow();
		expect(await store.vector(docId)).toEqual([]);
		for (const invalid of ["", "\ud800", "document\0suffix"]) {
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
		const unicode = `${crypto.randomUUID()}/\ufffd/🌍`;
		await store.append([row(unicode)]);
		expect(await store.missing(unicode, [])).toEqual([row(unicode)]);
	});

	test("actor capacity is enforced atomically for ready and pending history", async () => {
		const store = create(),
			docId = crypto.randomUUID();
		const rows = Array.from({ length: 1024 }, (_, i) =>
			row(docId, 1, actor + i),
		);
		for (let i = 0; i < rows.length; i += 256)
			await store.append(rows.slice(i, i + 256));
		const frontier = await store.vector(docId);
		expect(frontier).toHaveLength(1024);
		await expect(
			store.append([row(docId, 2), row(docId, 2, actor + 1024)]),
		).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
		expect(await store.vector(docId)).toEqual(frontier);
		expect(await store.missing(docId, frontier)).toEqual([]);
	}, 15000);

	test("encoded frames are stored without decoding operations; state deltas are refused", async () => {
		const store = create(),
			docId = crypto.randomUUID();
		const first = row(docId);
		expect(
			await store.appendEncoded(
				encodeMessage({ kind: 4, docId, requestId: 1, vv: [], rows: [first] }),
			),
		).toEqual({ inserted: 1, ready: 1, pending: 0 });
		expect(await store.missing(docId, [])).toEqual([first]);
		await expect(
			store.appendEncoded(
				encodeMessage({ kind: 1, docId, requestId: 1, vv: [] }),
			),
		).rejects.toMatchObject({ code: "INVALID_MESSAGE" });

		const D = definePulse(
			"StoreState",
			object({ count: "float64" }),
		).materialize();
		const stateDoc = crypto.randomUUID();
		const pulse = createPulse(
			D,
			{ id: stateDoc, count: 0 },
			{ scope: createPulseScope(), sessionId: actor },
		);
		try {
			const base = getPulseMeta(pulse).log.vector;
			for (let i = 1; i <= 100; i++) pulse.count = i;
			const delta = exportPulseUpdates(pulse, base, { peerVersion: 3 })[0]!;
			await expect(store.appendEncoded(delta)).rejects.toMatchObject({
				code: "HISTORY_UNAVAILABLE",
			});
			for (const frame of exportPulseUpdates(pulse, [], {
				peerVersion: 2,
				mode: "history",
			}))
				await store.appendEncoded(frame);
			expect(await store.missing(stateDoc, [])).toEqual(
				getPulseMeta(pulse).log.missing([]),
			);
			expect(await store.missing(stateDoc, [[actor, 51]])).toEqual(
				getPulseMeta(pulse).log.missing([[actor, 51]]),
			);
		} finally {
			destroyPulse(pulse);
		}
	});

	test("operations are stored as compact binary copies of frame views", async () => {
		const options = storeOptions();
		const store = new IndexedDbPatchStore(options),
			docId = crypto.randomUUID();
		const frame = new Uint8Array(100_000).fill(7);
		const first = { ...row(docId), operations: frame.subarray(10, 20) };
		const large = { ...row(docId, 2), operations: new Uint8Array(180_000) };
		large.operations.fill(239);
		await store.append([first, large]);
		store.close();
		await expect(store.vector(docId)).rejects.toMatchObject({ code: "CLOSED" });

		const reopened = new IndexedDbPatchStore(options);
		const [stored, storedLarge] = await reopened.missing(docId, []);
		expect(stored!.operations).toBeInstanceOf(Uint8Array);
		expect(stored!.operations.buffer.byteLength).toBe(10);
		expect(stored).toEqual({ ...row(docId), operations: frame.slice(10, 20) });
		expect(storedLarge).toEqual(large);
		expect(await reopened.vector(docId)).toEqual([[actor, 3]]);
		reopened.close();
	});

	test("an unavailable database reports CONNECTION_FAILED and can be retried", async () => {
		const missing = new IndexedDbPatchStore({ name: "none" });
		if (!("indexedDB" in globalThis))
			await expect(missing.vector("doc")).rejects.toMatchObject({
				code: "CONNECTION_FAILED",
			});
		let attempts = 0;
		const factory = new IDBFactory();
		const flaky = {
			open(name: string, version?: number) {
				if (++attempts === 1) throw new Error("disk unavailable");
				return factory.open(name, version);
			},
		} as IDBFactory;
		const store = new IndexedDbPatchStore({
			name: crypto.randomUUID(),
			indexedDB: flaky,
			IDBKeyRange,
		});
		await expect(store.vector("doc")).rejects.toMatchObject({
			code: "CONNECTION_FAILED",
			message: "IndexedDB: disk unavailable",
		});
		expect(await store.vector("doc")).toEqual([]);
		expect(attempts).toBe(2);
		store.close();
	});
});
