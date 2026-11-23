import { expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import {
	applyPulseUpdates,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseMeta,
	snapshotPulse,
	subscribePulse,
	tree,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import {
	isFractionalPosition,
	positionBetween,
} from "../source/core/fractionalPosition.js";
import { CorePatch } from "../source/core/operations.js";
import { patchToRow, rowToPatch } from "../source/connection/PulsePatch.js";

const TreeDoc = definePulse(
	"TreePerformance",
	object({ outline: tree(object({ label: "string" })) }),
).materialize();

const opts = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});

function measureReads(n: number): number {
	const doc = createPulse(TreeDoc, { id: `t1-${n}`, outline: {} }, opts(65536));
	const peer = createRuntime(TreeDoc, doc.id, opts(65537)) as typeof doc;
	try {
		for (let i = 0; i < n; i++) doc.outline.createNode({ label: `n${i}` });
		applyPulseUpdates(peer, exportPulseUpdates(doc, []));
		const start = performance.now();
		for (const root of peer.outline.roots()) {
			void root.data;
			void root.children();
		}
		return performance.now() - start;
	} finally {
		destroyPulse(doc);
		destroyPulse(peer);
	}
}

test("T1: reading tree nodes scales linearly at n vs 4n and invalidates on writes", () => {
	// Warm up JIT before scaling check.
	measureReads(100);
	const small = measureReads(500);
	const large = measureReads(2000);
	expect(large).toBeLessThan(250);
	expect(large / Math.max(small, 5)).toBeLessThan(10);

	// Cache must invalidate on local move, local delete, and remote writes.
	const a = createPulse(TreeDoc, { id: "t1-inv", outline: {} }, opts(65536));
	const b = createRuntime(TreeDoc, a.id, opts(65537)) as typeof a;
	try {
		const x = a.outline.createNode({ label: "x" });
		const y = a.outline.createNode({ label: "y" });
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		expect(b.outline.roots().map((node) => node.data.label)).toEqual([
			"x",
			"y",
		]);

		y.move(x);
		expect(a.outline.roots().map((node) => node.id)).toEqual([x.id]);
		expect(x.children().map((node) => node.id)).toEqual([y.id]);
		applyPulseUpdates(b, exportPulseUpdates(a, getPulseMeta(b).log.vector));
		expect(b.outline.roots().map((node) => node.id)).toEqual([x.id]);
		expect(
			b.outline
				.getNode(x.id)!
				.children()
				.map((node) => node.id),
		).toEqual([y.id]);

		y.delete();
		expect(x.children()).toEqual([]);
		expect(a.outline.getNode(y.id)).toBeUndefined();
		applyPulseUpdates(b, exportPulseUpdates(a, getPulseMeta(b).log.vector));
		expect(b.outline.getNode(x.id)!.children()).toEqual([]);
		expect(b.outline.getNode(y.id)).toBeUndefined();
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

function measureCreates(n: number): number {
	const doc = createPulse(TreeDoc, { id: `t2-${n}`, outline: {} }, opts(65536));
	try {
		const start = performance.now();
		for (let i = 0; i < n; i++) doc.outline.createNode({ label: `n${i}` });
		return performance.now() - start;
	} finally {
		destroyPulse(doc);
	}
}

test("T2: creating tree nodes scales linearly at n vs 4n and handles subscribers and orphans", () => {
	measureCreates(100);
	const small = measureCreates(500);
	const large = measureCreates(2000);
	expect(large).toBeLessThan(250);
	expect(large / Math.max(small, 10)).toBeLessThan(8);

	// Subscriber reading or mutating during createNode must not corrupt cache.
	const doc = createPulse(TreeDoc, { id: "t2-sub", outline: {} }, opts(65536));
	let triggered = false;
	const unsub = subscribePulse(doc, () => {
		const roots = doc.outline.roots();
		if (!triggered && roots.length === 1) {
			triggered = true;
			doc.outline.createNode({ label: "from-listener" });
		}
	});
	try {
		doc.outline.createNode({ label: "first" });
		expect(doc.outline.roots().map((node) => node.data.label)).toEqual([
			"first",
			"from-listener",
		]);
	} finally {
		unsub();
		destroyPulse(doc);
	}

	// Restored orphan referencing a future node ID must attach when that ID is created.
	const orphanPos = positionBetween(
		undefined,
		undefined,
		"0000000000000100000000000001",
	);
	const orphanDoc = createPulse(
		TreeDoc,
		{
			id: "t2-orphan",
			outline: {
				orphan: {
					data: { label: "orphan" },
					location: { parent: "n65536:2", position: orphanPos },
					deleted: false,
				},
			},
		},
		opts(65536),
	);
	try {
		expect(orphanDoc.outline.roots().map((node) => node.id)).toEqual([
			"orphan",
		]);
		const parent = orphanDoc.outline.createNode({ label: "parent" });
		expect(parent.id).toBe("n65536:2");
		expect(orphanDoc.outline.roots().map((node) => node.id)).toEqual([
			parent.id,
		]);
		expect(parent.children().map((node) => node.id)).toEqual(["orphan"]);
	} finally {
		destroyPulse(orphanDoc);
	}
});

function measureRemoteValidation(baseNodes: number, ops: number): number {
	const doc = createPulse(
		TreeDoc,
		{ id: `t3-${baseNodes}`, outline: {} },
		opts(65536),
	);
	const peer = createRuntime(TreeDoc, doc.id, opts(65537)) as typeof doc;
	try {
		for (let i = 0; i < baseNodes; i++)
			doc.outline.createNode({ label: `base${i}` });
		const meta = getPulseMeta(peer);
		meta.applyRows(getPulseMeta(doc).log.missing([]));
		const frontier = getPulseMeta(doc).log.vector;
		for (let i = 0; i < ops; i++)
			doc.outline.createNode({ label: `remote${i}` });
		const extra = getPulseMeta(doc)
			.log.missing(frontier)
			.map((row) => ({
				patch: rowToPatch(row, meta.model.encoding),
				deps: row.dependencies,
			}));
		const start = performance.now();
		for (const { patch, deps } of extra) {
			meta.model.validateSingle(patch, deps);
			meta.model.apply(patch);
		}
		return performance.now() - start;
	} finally {
		destroyPulse(doc);
		destroyPulse(peer);
	}
}

test("T3: remote tree validation is independent of existing tree size at n vs 4n", () => {
	measureRemoteValidation(100, 100);
	const small = measureRemoteValidation(500, 1000);
	const large = measureRemoteValidation(2000, 1000);
	expect(large).toBeLessThan(100);
	expect(large / Math.max(small, 10)).toBeLessThan(3);

	// Position index tracks initial snapshots and moves even when the transaction suffix matches.
	const suffix =
		(65538).toString(16).padStart(14, "0") +
		(1).toString(16).padStart(14, "0") +
		"0001";
	const collidingPos = "8000" + suffix;
	const a = createPulse(
		TreeDoc,
		{
			id: "t3-pos",
			outline: {
				seed: {
					data: { label: "seed" },
					location: { parent: "", position: collidingPos },
					deleted: false,
				},
			},
		},
		opts(65536),
	);
	const b = createRuntime(TreeDoc, a.id, opts(65537)) as typeof a;
	try {
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		const meta = getPulseMeta(b);
		const map = meta.model.root!.child("outline")!;
		const patch = new CorePatch(65538, 1, 100, meta.model.schemaId, [
			{
				kind: 1,
				target: map.id,
				field: "n65538:1",
				value: {
					value: {
						data: { label: "forged" },
						location: { parent: "", position: collidingPos },
						deleted: false,
					},
					constants: [],
					texts: [],
				},
			},
		]);
		const row = patchToRow(b.id, patch, meta.log.vector, meta.model.encoding);
		expect(() => meta.applyRows([row])).toThrow("positions must identify");
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("T4: fractional position lengths stay O(log n) for appends, prepends, middle inserts, and concurrent appends", () => {
	const unique = (i: number) => i.toString(16).padStart(28, "0");

	const measureKeys = (n: number) => {
		let cur: string | undefined;
		let maxAppend = 0;
		for (let i = 0; i < n; i++) {
			const next = positionBetween(cur, undefined, unique(i));
			expect(isFractionalPosition(next)).toBe(true);
			if (cur !== undefined) expect(next > cur).toBe(true);
			cur = next;
			if (next.length > maxAppend) maxAppend = next.length;
		}

		cur = undefined;
		let maxPrepend = 0;
		for (let i = 0; i < n; i++) {
			const next = positionBetween(undefined, cur, unique(i));
			expect(isFractionalPosition(next)).toBe(true);
			if (cur !== undefined) expect(next < cur).toBe(true);
			cur = next;
			if (next.length > maxPrepend) maxPrepend = next.length;
		}

		const leftFixed = positionBetween(undefined, undefined, unique(0));
		let rightShrink = positionBetween(leftFixed, undefined, unique(1));
		let maxLeftSpot = 0;
		for (let i = 2; i < n + 2; i++) {
			const next = positionBetween(leftFixed, rightShrink, unique(i));
			expect(isFractionalPosition(next)).toBe(true);
			expect(next > leftFixed && next < rightShrink).toBe(true);
			rightShrink = next;
			if (next.length > maxLeftSpot) maxLeftSpot = next.length;
		}

		let leftGrow = leftFixed;
		const rightFixed = positionBetween(leftFixed, undefined, unique(1));
		let maxRightSpot = 0;
		for (let i = 2; i < n + 2; i++) {
			const next = positionBetween(leftGrow, rightFixed, unique(i));
			expect(isFractionalPosition(next)).toBe(true);
			expect(next > leftGrow && next < rightFixed).toBe(true);
			leftGrow = next;
			if (next.length > maxRightSpot) maxRightSpot = next.length;
		}

		return { maxAppend, maxPrepend, maxLeftSpot, maxRightSpot };
	};

	const small = measureKeys(500);
	const large = measureKeys(2000);
	expect(large.maxAppend).toBeLessThanOrEqual(40);
	expect(large.maxPrepend).toBeLessThanOrEqual(40);
	expect(large.maxLeftSpot).toBeLessThanOrEqual(44);
	expect(large.maxRightSpot).toBeLessThanOrEqual(48);
	expect(large.maxAppend - small.maxAppend).toBeLessThanOrEqual(4);
	expect(large.maxPrepend - small.maxPrepend).toBeLessThanOrEqual(4);
	expect(large.maxLeftSpot - small.maxLeftSpot).toBeLessThanOrEqual(4);
	expect(large.maxRightSpot - small.maxRightSpot).toBeLessThanOrEqual(4);

	// Interleaved concurrent appends from two replicas stay distinct, valid, and ordered.
	const a = createPulse(TreeDoc, { id: "t4-conc", outline: {} }, opts(65536));
	const b = createRuntime(TreeDoc, a.id, opts(65537)) as typeof a;
	try {
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		for (let round = 0; round < 40; round++) {
			a.outline.createNode({ label: `a${round}` });
			b.outline.createNode({ label: `b${round}` });
			if (round % 4 === 3) {
				applyPulseUpdates(b, exportPulseUpdates(a, getPulseMeta(b).log.vector));
				applyPulseUpdates(a, exportPulseUpdates(b, getPulseMeta(a).log.vector));
			}
		}
		applyPulseUpdates(b, exportPulseUpdates(a, getPulseMeta(b).log.vector));
		applyPulseUpdates(a, exportPulseUpdates(b, getPulseMeta(a).log.vector));
		const rootsA = a.outline.roots();
		const rootsB = b.outline.roots();
		expect(rootsA).toHaveLength(80);
		expect(rootsA.map((node) => node.id)).toEqual(
			rootsB.map((node) => node.id),
		);
		const snap = snapshotPulse(a).outline;
		const positions = rootsA.map((node) => snap[node.id]!.location.position);
		expect(new Set(positions).size).toBe(80);
		for (let i = 1; i < positions.length; i++)
			expect(positions[i]! > positions[i - 1]!).toBe(true);
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});
