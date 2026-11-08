import { expect, test } from "bun:test";
import { array, literal, object } from "@gin-quin/codec";
import {
	arrayOperations,
	createPulse,
	createPulseScope,
	compilePulseSchema,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	applyPulseUpdates,
	getPulseMeta,
	snapshotPulse,
	tree,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { CorePatch } from "../source/core/operations.js";
import { patchToRow } from "../source/connection/PulsePatch.js";

const D = definePulse(
	"IndependentMoves",
	object({
		items: array(object({ id: "string", value: "uint" })),
		outline: tree(object({ value: "uint" })),
	}),
).materialize();
const opts = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});

test("independent review: randomized offline moves and causally interleaved exchanges converge", () => {
	for (let seed = 1; seed <= 40; seed++) {
		let state = seed;
		const random = () =>
			(state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
		const a = createPulse(
			D,
			{
				id: `review-${seed}`,
				items: Array.from({ length: 8 }, (_, i) => ({
					id: `original${i}`,
					value: 0,
				})),
				outline: {},
			},
			opts(65536),
		);
		for (let i = 0; i < 8; i++) a.outline.createNode({ value: i });
		const docs = [a];
		for (let i = 1; i <= 2; i++) {
			const peer = createRuntime(D, a.id, opts(65536 + i)) as typeof a;
			applyPulseUpdates(peer, exportPulseUpdates(a, []));
			docs.push(peer);
		}
		try {
			for (let tick = 0; tick < 120; tick++) {
				const index = random() % docs.length,
					doc = docs[index]!;
				const action = random() % 7;
				if (action === 0 && doc.items.length) {
					const from = random() % doc.items.length,
						count = 1 + (random() % (doc.items.length - from)),
						to = random() % (doc.items.length - count + 1);
					arrayOperations(doc.items).move(from, to, count);
				} else if (action === 1) {
					doc.items.splice(random() % (doc.items.length + 1), 0, {
						id: `new${seed}-${tick}`,
						value: tick,
					});
				} else if (action === 2 && doc.items.length)
					doc.items.splice(random() % doc.items.length, 1);
				else if (action === 3 && doc.items.length)
					doc.items[random() % doc.items.length]!.value = tick;
				else if (action === 4) {
					const nodes = doc.outline.nodes();
					if (nodes.length > 1) {
						const source = nodes[random() % nodes.length]!,
							target =
								random() % 4 ? nodes[random() % nodes.length] : undefined;
						try {
							source.move(target);
						} catch (error) {
							if (!(error instanceof TypeError)) throw error;
						}
					}
				} else if (action === 5) {
					const target = docs[(index + 1) % docs.length]!;
					applyPulseUpdates(
						target,
						exportPulseUpdates(doc, getPulseMeta(target).log.vector),
					);
				} else {
					const nodes = doc.outline.nodes();
					if (nodes.length && random() % 3 === 0)
						nodes[random() % nodes.length]!.delete();
					else doc.outline.createNode({ value: tick });
				}
			}
			const rows = docs.flatMap((doc) => getPulseMeta(doc).log.missing([]));
			for (const doc of docs) {
				const shuffled = [...rows];
				for (let i = shuffled.length - 1; i; i--) {
					const j = random() % (i + 1);
					[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
				}
				for (const row of shuffled) {
					getPulseMeta(doc).applyRows([row]);
					if (random() % 2) getPulseMeta(doc).applyRows([row]);
				}
				expect(getPulseMeta(doc).log.pendingCount).toBe(0);
				expect(new Set(doc.items.map((item) => item.id)).size).toBe(
					doc.items.length,
				);
			}
			for (const doc of docs.slice(1)) {
				expect(snapshotPulse(doc)).toEqual(snapshotPulse(a));
				expect(doc.outline.toJSON()).toEqual(a.outline.toJSON());
			}
		} finally {
			docs.forEach(destroyPulse);
		}
	}
});

test("independent review: moving a projected cycle root to the root explicitly clears the raw parent", () => {
	const a = createPulse(
		D,
		{ id: "review-cycle", items: [], outline: {} },
		opts(65536),
	);
	const b = createRuntime(D, a.id, opts(65537)) as typeof a;
	try {
		const x = a.outline.createNode({ value: 1 }),
			y = a.outline.createNode({ value: 2 });
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		x.move(y);
		b.outline.getNode(y.id)!.move(b.outline.getNode(x.id));
		applyPulseUpdates(a, exportPulseUpdates(b, getPulseMeta(a).log.vector));
		expect(a.outline.roots()[0]!.id).toBe(x.id);
		x.move(); // User deliberately moves X to roots, clearing its latent X -> Y edge.
		y.move(); // Break Y -> X after the root operation.
		expect(x.parent()).toBeUndefined();
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("independent review: creating a node after initializing from a snapshot never overwrites existing data", () => {
	const a = createPulse(
		D,
		{ id: "review-snapshot-source", items: [], outline: {} },
		opts(65536),
	);
	let b: typeof a | undefined;
	try {
		a.outline.createNode({ value: 1 });
		b = createPulse(
			D,
			{
				id: "review-snapshot-copy",
				items: [],
				outline: snapshotPulse(a).outline,
			},
			opts(65536),
		);
		b.outline.createNode({ value: 2 });
		expect(b.outline.roots().map((node) => node.data.value)).toEqual([1, 2]);
	} finally {
		destroyPulse(a);
		if (b) destroyPulse(b);
	}
});

test("independent review: move validation rejects forged references and relocation-token mutations atomically", () => {
	const a = createPulse(
		D,
		{
			id: "review-validation",
			items: ["a", "b"].map((id) => ({ id, value: 0 })),
			outline: {},
		},
		opts(65536),
	);
	const b = createRuntime(D, a.id, opts(65537)) as typeof a;
	try {
		arrayOperations(a.items).move(0, 1);
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		const meta = getPulseMeta(b),
			sequence = meta.model.root!.child("items")!;
		const origin = sequence.visible[0]!.id;
		const token = [...sequence.entries.values()].find(
			(entry) => entry.origin,
		)!.id;
		const value = { value: { id: "bad", value: 1 }, constants: [], texts: [] };
		const before = snapshotPulse(b),
			vector = meta.log.vector;
		const mutations = [
			[
				{
					kind: 6 as const,
					target: sequence.id,
					entries: ["65538:1:0"],
					after: "",
				},
			],
			[
				{
					kind: 6 as const,
					target: sequence.id,
					entries: [origin, origin],
					after: "",
				},
			],
			[{ kind: 6 as const, target: sequence.id, entries: [token], after: "" }],
			[{ kind: 4 as const, target: sequence.id, entry: token, value }],
			[
				{
					kind: 3 as const,
					target: sequence.id,
					after: "",
					deletes: [token],
					values: [],
				},
			],
			[
				{ kind: 6 as const, target: sequence.id, entries: [origin], after: "" },
				{
					kind: 6 as const,
					target: sequence.id,
					entries: ["65538:1:0"],
					after: "",
				}, // Same-patch token is not a logical entry.
			],
		];
		for (const ops of mutations) {
			const patch = new CorePatch(65538, 1, 100, meta.model.schemaId, ops);
			const row = patchToRow(b.id, patch, vector, meta.model.encoding);
			expect(() => meta.applyRows([row])).toThrow();
			expect(snapshotPulse(b)).toEqual(before);
			expect(meta.log.vector).toEqual(vector);
		}
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("independent review: remote scalar writes cannot bypass tree-location validation", () => {
	const a = createPulse(
		D,
		{ id: "review-location-validation", items: [], outline: {} },
		opts(65536),
	);
	const b = createRuntime(D, a.id, opts(65537)) as typeof a;
	try {
		const x = a.outline.createNode({ value: 1 });
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		const meta = getPulseMeta(b),
			location = meta.model
				.root!.child("outline")!
				.child(x.id)!
				.child("location")!;
		const before = snapshotPulse(b),
			vector = meta.log.vector;
		const patch = new CorePatch(65538, 1, 100, meta.model.schemaId, [
			{
				kind: 1,
				target: location.id,
				field: meta.model.field(location, "position"),
				value: { value: "zzzz", constants: [], texts: [] },
			},
		]);
		const row = patchToRow(b.id, patch, vector, meta.model.encoding);
		expect(() => meta.applyRows([row])).toThrow();
		expect(snapshotPulse(b)).toEqual(before);
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("independent review: tree IDs and tombstones cannot be replaced, including inside one batch", () => {
	const a = createPulse(
		D,
		{ id: "review-immutable-tree", items: [], outline: {} },
		opts(65536),
	);
	const b = createRuntime(D, a.id, opts(65537)) as typeof a;
	try {
		const x = a.outline.createNode({ value: 1 });
		x.delete();
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		const meta = getPulseMeta(b),
			map = meta.model.root!.child("outline")!;
		const before = snapshotPulse(b),
			vector = meta.log.vector;
		const record = {
			data: { value: 2 },
			location: {
				parent: "",
				position:
					"8000" +
					(65538).toString(16).padStart(14, "0") +
					(1).toString(16).padStart(14, "0") +
					"0001",
			},
			deleted: false,
		};
		const prepared = { value: record, constants: [], texts: [] };
		const scenarios = [
			[{ kind: 1 as const, target: map.id, field: x.id, value: prepared }],
			[{ kind: 2 as const, target: map.id, field: x.id }],
			[
				{
					kind: 1 as const,
					target: map.child(x.id)!.id,
					field: meta.model.field(map.child(x.id)!, "deleted"),
					value: { value: false, constants: [], texts: [] },
				},
			],
			[
				{
					kind: 1 as const,
					target: map.id,
					field: "n65539:1",
					value: prepared,
				},
			],
			[
				{
					kind: 1 as const,
					target: map.id,
					field: "n65538:1",
					value: prepared,
				},
				{
					kind: 1 as const,
					target: map.id,
					field: "n65538:1",
					value: prepared,
				},
			],
		];
		for (const ops of scenarios) {
			const patch = new CorePatch(65538, 1, 100, meta.model.schemaId, ops);
			const row = patchToRow(b.id, patch, vector, meta.model.encoding);
			expect(() => meta.applyRows([row])).toThrow();
			expect(snapshotPulse(b)).toEqual(before);
			expect(meta.log.vector).toEqual(vector);
		}
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("independent review: initial tree snapshots reject invalid and duplicate sibling positions", () => {
	const record = (position: string) => ({
		data: { value: 1 },
		location: { parent: "", position },
		deleted: false,
	});
	for (const outline of [
		{ a: record("zzzz") },
		{ a: record("8001"), b: record("8001") },
	]) {
		expect(() =>
			createPulse(
				D,
				{ id: "review-invalid-initial-tree", items: [], outline },
				opts(65536),
			),
		).toThrow();
	}
});

test("independent review: copied tree sibling positions are rejected for both creation and moves", () => {
	const a = createPulse(
		D,
		{ id: "review-copied-position", items: [], outline: {} },
		opts(65536),
	);
	const b = createRuntime(D, a.id, opts(65537)) as typeof a;
	try {
		const x = a.outline.createNode({ value: 1 }),
			y = a.outline.createNode({ value: 2 });
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		const meta = getPulseMeta(b),
			map = meta.model.root!.child("outline")!;
		const copiedLocation = snapshotPulse(a).outline[x.id]!.location;
		const before = snapshotPulse(b),
			vector = meta.log.vector;
		const scenarios = [
			[
				{
					kind: 1 as const,
					target: map.id,
					field: "n65538:1",
					value: {
						value: {
							data: { value: 3 },
							location: copiedLocation,
							deleted: false,
						},
						constants: [],
						texts: [],
					},
				},
			],
			[
				{
					kind: 1 as const,
					target: map.child(y.id)!.id,
					field: meta.model.field(map.child(y.id)!, "location"),
					value: { value: copiedLocation, constants: [], texts: [] },
				},
			],
		];
		for (const ops of scenarios) {
			const patch = new CorePatch(65538, 1, 100, meta.model.schemaId, ops);
			const row = patchToRow(b.id, patch, vector, meta.model.encoding);
			expect(() => meta.applyRows([row])).toThrow("positions must identify");
			expect(snapshotPulse(b)).toEqual(before);
			expect(meta.log.vector).toEqual(vector);
		}
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("independent review: constant tree containers reject compilation while constant payloads work", () => {
	const schema = object({ outline: tree("string") });
	expect(() =>
		compilePulseSchema(schema, { constantPaths: [["outline"]] }),
	).toThrow("constant field");
	expect(() =>
		compilePulseSchema(object({ nested: schema }), {
			constantPaths: [["nested"]],
		}),
	).toThrow("constant field");
	const Definition = definePulse(
		"ReviewConstantTreePayload",
		object({ outline: tree(literal("fixed")) }),
	).materialize();
	const doc = createPulse(Definition, { outline: {} }, opts(65536));
	try {
		const x = doc.outline.createNode("fixed"),
			y = doc.outline.createNode("fixed");
		x.move(y);
		expect(x.data).toBe("fixed");
		expect(x.parent()).toBe(y);
	} finally {
		destroyPulse(doc);
	}
});
