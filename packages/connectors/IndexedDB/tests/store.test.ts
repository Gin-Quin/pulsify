import { deletionStoreConformance } from "../../../pulse/tests/deletion-store.js";
import { describe, expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseMeta,
	versioned,
} from "pulsify-core";
import { encodeMessage } from "pulsify-core/protocol";
import type { StoredPatchRow } from "pulsify-core/storage";
import {
	IDBFactory,
	IDBIndex,
	IDBKeyRange,
	IDBObjectStore,
} from "fake-indexeddb";
import { IndexedDbPatchStore } from "../source/index";
import { lastValueStoreConformance } from "../../../pulse/tests/history-store.js";
import {
	encodeValueOp,
	pagingStoreConformance,
} from "../../../pulse/tests/paging-store.js";

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

test("an actor whose rows fill exactly one scan batch is read to its frontier", async () => {
	// The scan resumes after a full batch; at the frontier the next range is empty.
	for (const count of [127, 128, 129, 256]) {
		const store = create();
		const docId = `batch-${count}`;
		const rows = Array.from({ length: count }, (_, i) => row(docId, i + 1));
		await store.append(rows);
		expect((await store.missing(docId, [])).length).toBe(count);
		expect((await store.missing(docId, [[actor, 2]])).length).toBe(count - 1);
		const page = await store.missingPage(docId, [], { maxRows: count });
		expect(page.rows.length).toBe(count);
		expect(page.next).toBeUndefined();
	}
});

test("IndexedDB pagination seeks forward without rescanning earlier pages or neighboring subtrees", async () => {
	const store = create();
	const db = await store.database();
	// Observe actual cursor work, avoiding machine-dependent timing assertions.
	const prototype = Object.getPrototypeOf(
		db.transaction("clocks").objectStore("clocks"),
	) as IDBObjectStore;
	const original = prototype.openKeyCursor;
	let visited = 0;
	try {
		await store.append([row("r/a")]);
		for (let i = 0; i < 500; i++) {
			await store.append([row(`r/a-/sibling/${i}`)]);
			await store.append([row(`r/a/child/${String(i).padStart(4, "0")}`)]);
		}
		prototype.openKeyCursor = function (query, direction) {
			const pending = original.call(this, query, direction);
			pending.addEventListener("success", () => {
				if (pending.result) visited++;
			});
			return pending;
		};
		const found: string[] = [];
		for (;;) {
			const page = await store.documents("r/a", found.at(-1) ?? "", 25);
			if (!page.length) break;
			found.push(...page);
		}
		expect(found).toEqual([
			"r/a",
			...Array.from(
				{ length: 500 },
				(_, i) => `r/a/child/${String(i).padStart(4, "0")}`,
			),
		]);
		expect(visited).toBe(500);
	} finally {
		prototype.openKeyCursor = original;
		store.close();
	}
});

lastValueStoreConformance("IndexedDB", async () => create());
pagingStoreConformance("IndexedDB", async () => create());

test("a page reads its values by clock, not every value of the actor", async () => {
	const store = create(),
		docId = crypto.randomUUID();
	// 1000 distinct registers: one value each.
	for (let i = 0; i < 1000; i += 500)
		await store.append(
			Array.from({ length: 500 }, (_, j) => ({
				...row(docId, i + j + 1),
				operations: encodeValueOp(i + j + 1, i + j + 1),
			})),
		);
	const prototypes = [IDBIndex.prototype, IDBObjectStore.prototype];
	const originals = prototypes.map((prototype) => prototype.getAll);
	let read = 0;
	try {
		for (const [i, prototype] of prototypes.entries())
			prototype.getAll = function (
				this: IDBIndex | IDBObjectStore,
				query?: IDBValidKey | IDBKeyRange | null,
				count?: number,
			) {
				const pending = originals[i]!.call(this, query, count);
				const store = "objectStore" in this ? this.objectStore : this;
				pending.addEventListener("success", () => {
					if (store.name === "values") read += pending.result.length;
				});
				return pending;
			};
		let page = await store.missingPage(docId, [[actor, 500]], {
			maxRows: 2,
		});
		expect(page.rows.map((r) => r.clock)).toEqual([500, 501]);
		page = await store.missingPage(docId, [[actor, 500]], {
			maxRows: 2,
			after: page.next,
		});
		expect(page.rows.map((r) => r.clock)).toEqual([502, 503]);
		// Two pages, each at most one scan batch: never the 1000 values.
		expect(read).toBeGreaterThan(0);
		expect(read).toBeLessThanOrEqual(2 * 128);
	} finally {
		prototypes.forEach((prototype, i) => (prototype.getAll = originals[i]!));
		store.close();
	}
});

describe("IndexedDbPatchStore", () => {
	test("a database from before version 13 is upgraded in place", async () => {
		const options = storeOptions(),
			docId = crypto.randomUUID();
		// The layout that versions before 13 created: no registers.
		const old = await new Promise<IDBDatabase>((resolve, reject) => {
			const open = options.indexedDB.open(options.name, 1);
			open.onupgradeneeded = () => {
				open.result
					.createObjectStore("rows", { keyPath: ["docId", "sid", "clock"] })
					.createIndex("state", ["docId", "ready", "sid", "end"]);
				open.result.createObjectStore("clocks", { keyPath: ["docId", "sid"] });
			};
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		const first = row(docId),
			second = row(docId, 2);
		await new Promise<void>((resolve, reject) => {
			const tx = old.transaction(["rows", "clocks"], "readwrite");
			for (const each of [first, second])
				tx.objectStore("rows").put({ ...each, end: each.clock + 1, ready: 1 });
			tx.objectStore("clocks").put({ docId, sid: actor, clock: 3 });
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		old.close();

		const store = new IndexedDbPatchStore(options);
		expect(await store.vector(docId)).toEqual([[actor, 3]]);
		expect(await store.missing(docId, [])).toEqual([first, second]);
		expect([...(await store.database()).objectStoreNames].sort()).toEqual([
			"clocks",
			"rows",
			"tombstones",
			"values",
		]);
		// And it keeps the last value only of what is written from now on.
		const pulse = createPulse(
			definePulse("UpgradedStore", object({ title: "string" })).materialize(),
			{ id: crypto.randomUUID(), title: "" },
			{ scope: createPulseScope(), sessionId: actor },
		);
		try {
			const log = getPulseMeta(pulse).log;
			for (let i = 0; i < 20; i++) {
				pulse.title = `title ${i}`;
				await store.append(log.missing(await store.vector(pulse.id)));
			}
			expect(await store.missing(pulse.id, [])).toHaveLength(2);
		} finally {
			destroyPulse(pulse);
			store.close();
		}
	});
	test("a database that indexed registers drops the index and keeps its rows", async () => {
		const options = storeOptions(),
			docId = crypto.randomUUID();
		// The unreleased version 2: a register index, spans grown over replaced
		// writes, and gap rows where no row could grow.
		const old = await new Promise<IDBDatabase>((resolve, reject) => {
			const open = options.indexedDB.open(options.name, 2);
			open.onupgradeneeded = () => {
				open.result
					.createObjectStore("rows", { keyPath: ["docId", "sid", "clock"] })
					.createIndex("state", ["docId", "ready", "sid", "end"]);
				open.result.createObjectStore("clocks", { keyPath: ["docId", "sid"] });
				open.result.createObjectStore("registers", {
					keyPath: ["docId", "register"],
				});
			};
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		const gap = {
			...row(docId, 1, other),
			span: 2,
			operations: Uint8Array.of(3, 1, 0, 0),
		};
		const long = { ...row(docId), span: 3 },
			last = row(docId, 4),
			after = row(docId, 3, other);
		await new Promise<void>((resolve, reject) => {
			const tx = old.transaction(["rows", "clocks", "registers"], "readwrite");
			for (const each of [long, last, gap, after])
				tx.objectStore("rows").put({
					...each,
					end: each.clock + each.span,
					ready: 1,
				});
			tx.objectStore("clocks").put({ docId, sid: actor, clock: 5 });
			tx.objectStore("clocks").put({ docId, sid: other, clock: 4 });
			tx.objectStore("registers").put({
				docId,
				register: "x",
				sid: actor,
				clock: 4,
				lamport: 1,
			});
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		old.close();

		const store = new IndexedDbPatchStore(options);
		expect([...(await store.database()).objectStoreNames].sort()).toEqual([
			"clocks",
			"rows",
			"tombstones",
			"values",
		]);
		// Spans and gaps are served as before, from any remote clock.
		expect(await store.missing(docId, [])).toEqual([long, last, gap, after]);
		expect(await store.missing(docId, [[actor, 2]])).toEqual([
			long,
			last,
			gap,
			after,
		]);
		expect(
			await store.missing(docId, [
				[actor, 5],
				[other, 2],
			]),
		).toEqual([
			{ ...gap, clock: 2, span: 1, dependencies: [[other, 2]] },
			after,
		]);
		const next = row(docId, 5);
		expect(await store.append([next])).toMatchObject({ ready: 1 });
		expect(
			await store.missing(docId, [
				[actor, 5],
				[other, 4],
			]),
		).toEqual([next]);
		store.close();
	});
	test("a version 4 database indexes its values by clock and serves them in order", async () => {
		const options = storeOptions(),
			docId = crypto.randomUUID();
		// The version 4 layout: values keyed by register, without the clock index.
		const old = await new Promise<IDBDatabase>((resolve, reject) => {
			const open = options.indexedDB.open(options.name, 4);
			open.onupgradeneeded = () => {
				open.result.createObjectStore("tombstones");
				open.result
					.createObjectStore("rows", { keyPath: ["docId", "sid", "clock"] })
					.createIndex("state", ["docId", "ready", "sid", "end"]);
				open.result.createObjectStore("clocks", { keyPath: ["docId", "sid"] });
				open.result.createObjectStore("values", {
					keyPath: ["docId", "sid", "register"],
				});
			};
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		// Register keys sort the other way round from clocks.
		const values = [1, 2, 3, 4].map((clock) => ({
			...row(docId, clock),
			operations: encodeValueOp(10 - clock, clock),
		}));
		await new Promise<void>((resolve, reject) => {
			const tx = old.transaction(["values", "clocks"], "readwrite");
			for (const value of values)
				tx.objectStore("values").put({
					docId,
					sid: actor,
					register: `r${10 - value.clock}`,
					clock: value.clock,
					dependencies: value.dependencies,
					operations: value.operations,
				});
			tx.objectStore("clocks").put({ docId, sid: actor, clock: 5 });
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		old.close();

		const store = new IndexedDbPatchStore(options);
		const db = await store.database();
		expect(db.version).toBe(5);
		expect([
			...db.transaction("values").objectStore("values").indexNames,
		]).toEqual(["clock"]);
		expect(await store.missing(docId, [])).toEqual(values);
		expect(await store.missing(docId, [[actor, 3]])).toEqual(values.slice(2));
		const first = await store.missingPage(docId, [], { maxRows: 3 });
		expect(first.rows).toEqual(values.slice(0, 3));
		const second = await store.missingPage(docId, [], {
			maxRows: 3,
			after: first.next,
		});
		expect(second).toEqual({
			rows: values.slice(3),
			vv: [[actor, 5]],
			next: undefined,
		});
		store.close();
	});
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
			vector: [
				[actor, 3],
				[other, 2],
			],
		});
		expect(await store.append([first, second])).toEqual({
			inserted: 0,
			ready: 0,
			pending: 0,
			vector: [
				[actor, 3],
				[other, 2],
			],
		});
		expect(await store.append([first, first])).toEqual({
			inserted: 0,
			ready: 0,
			pending: 0,
			vector: [
				[actor, 3],
				[other, 2],
			],
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
			vector: [],
		});
		expect(await store.vector(docId)).toEqual([]);
		expect(await store.missing(docId, [])).toEqual([]);
		expect(await store.append([first])).toEqual({
			inserted: 1,
			ready: 4,
			pending: 0,
			vector: [
				[actor, 4],
				[other, 2],
			],
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

	test("a waiting row that learns a longer span replaces the rows it covers", async () => {
		const store = create(),
			docId = crypto.randomUUID();
		const fifth = row(docId, 5),
			sixth = row(docId, 6);
		expect(await store.append([fifth, sixth])).toMatchObject({ pending: 2 });
		expect(await store.append([{ ...fifth, span: 3 }])).toMatchObject({
			pending: 1,
		});
		const first = { ...row(docId), span: 4 };
		expect(await store.append([first])).toMatchObject({ ready: 2, pending: 0 });
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
		const store = create(),
			docId = crypto.randomUUID();
		// Waiting rows: the second one says its actor's history ended at 7.
		await store.append([row(docId, 6), row(docId, 9, actor, [[actor, 7]])]);
		await expect(
			store.append([{ ...row(docId, 5), span: 3 }]),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await store.append([row(docId, 6)])).toMatchObject({
			inserted: 0,
			pending: 2,
		});
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
		// A row that starts among the writes another row replaced is ignored.
		expect(await store.append([row(docId, 3)])).toMatchObject({ inserted: 0 });
		expect(await store.missing(docId, [])).toEqual([first]);
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
			vector: [],
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
			vector: [[actor, 2]],
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
			vector: [],
		});
		expect(await store.append(prefix.slice(0, 4))).toEqual({
			inserted: 4,
			ready: 10,
			pending: 0,
			vector: [[actor, 11]],
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
		).toEqual({ inserted: 1, ready: 1, pending: 0, vector: [[actor, 2]] });
		expect(await store.missing(docId, [])).toEqual([first]);
		await expect(
			store.appendEncoded(
				encodeMessage({ kind: 1, docId, requestId: 1, vv: [] }),
			),
		).rejects.toMatchObject({ code: "INVALID_MESSAGE" });

		const D = definePulse(
			"StoreState",
			versioned(object({ count: "float64" })),
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

deletionStoreConformance("IndexedDB", async () => create());
