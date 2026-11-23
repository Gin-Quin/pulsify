import { describe, expect, test } from "bun:test";
import { array, map, object, optional } from "@gin-quin/codec";
import {
	arrayOperations,
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	loadPulse,
	PulseRelay,
	pulseRef,
	sub,
	subscribePulseStatus,
} from "../source/index.js";
import { createPulseViews } from "../source/bindings.js";
import { assertScopeLive } from "../source/pulses/deletion.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";

describe("runtime performance regressions (R1-R5, R7)", () => {
	test("R1: unrelated scalar writes stay O(1) when schema contains sub(), and remote edits do not re-poll tried refs", async () => {
		const Child = definePulse(
			"PerfChild",
			object({ name: "string" }),
		).materialize();
		const Doc = definePulse(
			"PerfSubDoc",
			object({
				title: "string",
				rows: array(object({ a: "uint", b: "string" })),
				child: optional(sub(Child)),
			}),
		).materialize();

		const measure = (n: number) => {
			const rows = Array.from({ length: n }, (_, i) => ({ a: i, b: `r${i}` }));
			const doc = createPulse(
				Doc,
				{ title: "init", rows },
				{ scope: createPulseScope() },
			);
			try {
				for (let i = 0; i < 20; i++) doc.title = `w${i}`;
				const start = performance.now();
				for (let i = 0; i < 200; i++) doc.title = `v${i}`;
				return performance.now() - start;
			} finally {
				destroyPulse(doc);
			}
		};

		const tSmall = measure(4_000);
		const tLarge = measure(16_000);
		// Scaling by 4x rows must stay O(1) for unrelated writes (never 4x slower).
		expect(tLarge).toBeLessThan(Math.max(tSmall * 2.5, 15));

		// Remote writes to unrelated fields must not call takePushed on dangling refs;
		// adding a new ref must only probe the new ref, not previously tried ones.
		const relay = new PulseRelay();
		const takePushedIds: string[] = [];
		const base = createMemoryConnector(relay);
		const instrumented = {
			...base,
			takePushed(docId: string) {
				takePushedIds.push(docId);
				return base.takePushed?.(docId);
			},
		};
		const Parent = definePulse(
			"PerfSubParent",
			object({ title: "string", refs: array(sub(Child)) }),
		).materialize();
		const a = createPulse(
			Parent,
			{ id: "r1-perf", title: "init", refs: [] },
			{ scope: createPulseScope(), connectors: [base] },
		);
		for (let i = 0; i < 50; i++) a.refs.push(`r1-perf/missing-${i}` as never);
		await connectPulse(a).synced;
		const b = await loadPulse(Parent, "r1-perf", {
			scope: createPulseScope(),
			connectors: [instrumented],
			waitFor: "all",
		});
		try {
			takePushedIds.length = 0;
			for (let i = 0; i < 5; i++) a.title = `t${i}`;
			for (let i = 0; i < 50 && b.title !== "t4"; i++)
				await new Promise((r) => setTimeout(r, 5));
			expect(b.title).toBe("t4");
			expect(takePushedIds).toEqual([]);

			a.refs.push("r1-perf/missing-new" as never);
			for (let i = 0; i < 50 && b.refs.length !== 51; i++)
				await new Promise((r) => setTimeout(r, 5));
			expect(b.refs.length).toBe(51);
			// Only the newly added ref is probed (hydrateFromPushed + loadOne), never the 50 old ones.
			expect(new Set(takePushedIds)).toEqual(new Set(["r1-perf/missing-new"]));
			expect(takePushedIds.length).toBeLessThanOrEqual(2);
		} finally {
			destroyPulse(a);
			destroyPulse(b);
		}
	});

	test("R2: passive reader status does not flip and schedules no empty uploads on remote edits", async () => {
		const Doc = definePulse(
			"PerfR2Doc",
			object({ title: "string" }),
		).materialize();
		const relay = new PulseRelay();
		const connector = createMemoryConnector(relay);
		const a = createPulse(
			Doc,
			{ id: "r2-perf", title: "0" },
			{ scope: createPulseScope(), connectors: [connector] },
		);
		await connectPulse(a).synced;
		const b = await loadPulse(Doc, "r2-perf", {
			scope: createPulseScope(),
			connectors: [connector],
			waitFor: "all",
		});
		const statuses: string[] = [];
		const stopStatus = subscribePulseStatus(b, (s) => statuses.push(s));
		let extraSyncs = 0;
		const stopConn = getPulseMeta(b).connections[0]!.on("synced", () => {
			extraSyncs++;
		});
		try {
			for (let i = 1; i <= 3; i++) {
				a.title = String(i);
				for (let j = 0; j < 50 && b.title !== String(i); j++)
					await new Promise((r) => setTimeout(r, 5));
				expect(b.title).toBe(String(i));
			}
			await new Promise((r) => setTimeout(r, 20));
			expect(statuses).toEqual(["synced"]);
			expect(extraSyncs).toBe(0);

			// A local write on B still transitions synced -> ready -> synced.
			b.title = "local";
			for (let j = 0; j < 50 && a.title !== "local"; j++)
				await new Promise((r) => setTimeout(r, 5));
			await new Promise((r) => setTimeout(r, 20));
			expect(statuses).toEqual(["synced", "ready", "synced"]);
			expect(extraSyncs).toBe(1);
		} finally {
			stopStatus();
			stopConn();
			destroyPulse(a);
			destroyPulse(b);
		}
	});

	test("R3: PulseMap.size is O(1) and cached sorted order invalidates on local and remote changes", () => {
		const Doc = definePulse(
			"PerfR3Map",
			object({ m: map("int", "string") }),
		).materialize();
		const measureSize = (n: number) => {
			const init = new Map<number, string>();
			for (let i = 0; i < n; i++) init.set(i, `v${i}`);
			const doc = createPulse(Doc, { m: init }, { scope: createPulseScope() });
			try {
				void doc.m.size; // Prime cache.
				const start = performance.now();
				let total = 0;
				for (let i = 0; i < 2_000; i++) total += doc.m.size;
				expect(total).toBe(n * 2_000);
				return performance.now() - start;
			} finally {
				destroyPulse(doc);
			}
		};

		const tSmall = measureSize(1_000);
		const tLarge = measureSize(4_000);
		expect(tLarge).toBeLessThan(Math.max(tSmall * 2.5, 5));

		// Verify cache stays accurate across local inserts, value updates, deletes, and remote sync.
		const a = createPulse(
			Doc,
			{
				id: "r3-sync",
				m: new Map([
					[3, "c"],
					[1, "a"],
				]),
			},
			{ scope: createPulseScope(), sessionId: 65536 },
		);
		const b = createRuntime(Doc, "r3-sync", {
			...defaultPulseOptions,
			scope: createPulseScope(),
			sessionId: 65537,
		}) as typeof a;
		try {
			getPulseMeta(b).applyRows(getPulseMeta(a).log.missing([]));
			// Prime b's caches before remote updates arrive.
			expect(b.m.size).toBe(2);
			expect([...b.m.keys()]).toEqual([1, 3]);

			expect(a.m.size).toBe(2);
			expect([...a.m.keys()]).toEqual([1, 3]);
			a.m.set(2, "b");
			expect(a.m.size).toBe(3);
			expect([...a.m.keys()]).toEqual([1, 2, 3]);
			a.m.set(2, "B");
			expect(a.m.size).toBe(3);
			expect([...a.m.entries()]).toEqual([
				[1, "a"],
				[2, "B"],
				[3, "c"],
			]);
			a.m.delete(1);
			expect(a.m.size).toBe(2);
			expect([...a.m.keys()]).toEqual([2, 3]);

			// Remote rows invalidate b's cached size and sorted keys.
			getPulseMeta(b).applyRows(
				getPulseMeta(a).log.missing(getPulseMeta(b).log.vector),
			);
			expect(b.m.size).toBe(2);
			expect([...b.m.entries()]).toEqual([
				[2, "B"],
				[3, "c"],
			]);
		} finally {
			destroyPulse(a);
			destroyPulse(b);
		}
	});

	test("R4: pulsify caches PulseRef per model node and keeps ref.pulse live", async () => {
		const Child = definePulse(
			"PerfR4Child",
			object({ title: "string" }),
		).materialize();
		const Parent = definePulse(
			"PerfR4Parent",
			object({
				cover: optional(sub(Child)),
				items: array(sub(Child)),
				byKey: map("string", sub(Child)),
			}),
		).materialize();
		const connector = createMemoryConnector(new PulseRelay());
		const scopeA = createPulseScope();
		const pA = createPulse(
			Parent,
			{ id: "r4-doc", items: [], byKey: new Map() },
			{ scope: scopeA, connectors: [connector] },
		);
		const c1 = createPulse(Child, { title: "One" }, { parent: pA });
		const c2 = createPulse(Child, { title: "Two" }, { parent: pA });
		pA.cover = pulseRef(c1);
		pA.items.push(pulseRef(c1), pulseRef(c2));
		pA.byKey.set("first", pulseRef(c1));
		await Promise.all([
			connectPulse(pA).synced,
			connectPulse(c1).synced,
			connectPulse(c2).synced,
		]);

		const pB = await loadPulse(Parent, "r4-doc", {
			scope: createPulseScope(),
			connectors: [connector],
			waitFor: "all",
			subPulses: false,
		});
		try {
			const coverRef = pB.cover!;
			expect(pB.cover).toBe(coverRef);
			expect(pB.items[0]).toBe(pB.items[0]);
			expect(pB.byKey.get("first")).toBe(pB.byKey.get("first"));
			expect(coverRef.pulse).toBeUndefined();

			// Loading resolves through the live getter on the same cached ref.
			const loaded = await coverRef.load({ waitFor: "all" });
			expect(coverRef.pulse).toBe(loaded);
			expect(pB.cover).toBe(coverRef);

			// Moving an array element preserves its PulseRef identity.
			const item0 = pB.items[0]!;
			arrayOperations(pB.items).move(0, 1);
			expect(pB.items[1]).toBe(item0);

			// Replacing a field returns a new ref with the new ID.
			pB.cover = pulseRef(c2);
			expect(pB.cover).not.toBe(coverRef);
			expect(pB.cover!.id).toBe(c2.id);
		} finally {
			destroyPulse(c1);
			destroyPulse(c2);
			destroyPulse(pA);
			destroyPulse(pB);
		}
	});

	test("R5: scope.deleted lookup scales with path depth, not tombstone count", () => {
		const measure = (n: number) => {
			const scope = createPulseScope();
			scope.deleted = new Set();
			for (let i = 0; i < n; i++) scope.deleted.add(`root/dead/${i}`);
			// Correctness checks: exact match, descendant match, sibling non-match.
			expect(() => assertScopeLive(scope, "root/dead/0")).toThrow(/deleted/);
			expect(() => assertScopeLive(scope, "root/dead/0/child")).toThrow(
				/deleted/,
			);
			assertScopeLive(scope, "root/dead/00");

			const start = performance.now();
			for (let i = 0; i < 1_000; i++)
				assertScopeLive(scope, `root/live/${i}/leaf`);
			return performance.now() - start;
		};

		const tSmall = measure(5_000);
		const tLarge = measure(20_000);
		expect(tLarge).toBeLessThan(Math.max(tSmall * 2.5, 10));
	});

	test("R7: pulseViews handles use WeakMap and do not retain removed sub-pulse refs", async () => {
		const Child = definePulse(
			"PerfR7Child",
			object({ name: "string" }),
		).materialize();
		const Parent = definePulse(
			"PerfR7Parent",
			object({ cover: optional(sub(Child)), items: array(sub(Child)) }),
		).materialize();
		const pulse = createPulse(
			Parent,
			{ id: "r7-perf", items: [] },
			{ scope: createPulseScope() },
		);
		try {
			const wrap = createPulseViews(() => () => {});
			const view = wrap(pulse);
			pulse.items.push("r7-perf/keep" as never);
			expect(view.items[0]).toBe(view.items[0]);

			const refs: WeakRef<object>[] = [];
			for (let i = 0; i < 200; i++) {
				pulse.cover = `r7-perf/churn-${i}` as never;
				const handle = view.cover!;
				expect(view.cover).toBe(handle);
				refs.push(new WeakRef(handle));
			}
			pulse.cover = undefined;
			Bun.gc(true);
			await new Promise((r) => setTimeout(r, 10));
			Bun.gc(true);
			const collected = refs.filter((ref) => !ref.deref()).length;
			expect(collected).toBeGreaterThan(100);
		} finally {
			destroyPulse(pulse);
		}
	});
});
