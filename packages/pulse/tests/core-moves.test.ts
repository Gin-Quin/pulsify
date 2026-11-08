import { expect, test } from "bun:test";
import { array, createCodec, object, optional } from "@gin-quin/codec";
import {
	arrayOperations,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	applyPulseUpdates,
	getPulseMeta,
	richText,
	snapshotPulse,
	tree,
	connectPulse,
	createMemoryConnector,
	loadPulse,
	disconnectPulse,
	PulseRelay,
	decodeMessage,
	type Connector,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { eventually } from "./helpers.js";
import { positionBetween } from "../source/core/fractionalPosition.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
const Definition = definePulse(
	"Moves",
	object({
		items: array(object({ label: "string", body: richText() })),
		outline: tree(object({ label: "string", body: richText() })),
	}),
).materialize();
function replicas(count = 3) {
	const first = createPulse(
		Definition,
		{
			id: "moves",
			items: ["A", "B", "C", "D", "E"].map((label) => ({ label, body: label })),
			outline: {},
		},
		options(65536),
	);
	const result = [first];
	for (let i = 1; i < count; i++) {
		const peer = createRuntime(
			Definition,
			first.id,
			options(65536 + i),
		) as typeof first;
		applyPulseUpdates(peer, exportPulseUpdates(first, []));
		result.push(peer);
	}
	return result;
}
type Replica = ReturnType<typeof replicas>[number];
const labels = (doc: Replica) => doc.items.map((item) => item.label);
const sync = (source: Replica, target: Replica) =>
	applyPulseUpdates(
		target,
		exportPulseUpdates(source, getPulseMeta(target).log.vector),
	);
function exchange(docs: Replica[], seed = 1) {
	const rows = docs.flatMap((doc) => getPulseMeta(doc).log.missing([]));
	let state = seed;
	const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
	for (const doc of docs) {
		const shuffled = [...rows];
		for (let i = shuffled.length - 1; i; i--) {
			const j = random() % (i + 1);
			[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
		}
		for (const row of shuffled) {
			getPulseMeta(doc).applyRows([row]);
			getPulseMeta(doc).applyRows([row]);
		}
		expect(getPulseMeta(doc).log.pendingCount).toBe(0);
	}
	for (const doc of docs.slice(1)) {
		expect(snapshotPulse(doc)).toEqual(snapshotPulse(docs[0]!));
		expect(doc.outline.toJSON()).toEqual(docs[0]!.outline.toJSON());
		expect(new Set(labels(doc)).size).toBe(doc.items.length);
	}
}

test("array move uses final indices, retains proxies and rich text, and agrees with native splices", () => {
	const [a] = replicas(1);
	try {
		const reference = a!.items[1]!,
			text = reference.body;
		arrayOperations(a!.items).move(1, 3);
		expect(labels(a!)).toEqual(["A", "C", "D", "B", "E"]);
		expect(a!.items[3]).toBe(reference);
		text.insert(1, "!");
		expect(a!.items[3]!.body.text).toBe("B!");
		const expected = labels(a!);
		let seed = 913;
		const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
		for (let n = 0; n < 200; n++) {
			if (n % 5 === 0) {
				const index = random() % (expected.length + 1),
					label = `new${n}`;
				a!.items.splice(index, 0, { label, body: richText(label) });
				expected.splice(index, 0, label);
			} else if (n % 7 === 0 && expected.length) {
				const index = random() % expected.length;
				a!.items.splice(index, 1);
				expected.splice(index, 1);
			} else {
				const from = random() % expected.length,
					count = 1 + (random() % (expected.length - from));
				const to = random() % (expected.length - count + 1);
				arrayOperations(a!.items).move(from, to, count);
				expected.splice(to, 0, ...expected.splice(from, count));
			}
			expect(labels(a!)).toEqual(expected);
		}
		const size = getPulseMeta(a!).log.size;
		arrayOperations(a!.items).move(0, 0);
		expect(() => arrayOperations(a!.items).move(-1, 0)).toThrow(RangeError);
		expect(() => arrayOperations(a!.items).move(0, 0, 0.5)).toThrow(RangeError);
		expect(getPulseMeta(a!).log.size).toBe(size);
	} finally {
		destroyPulse(a!);
	}
});

test("array concurrent moves choose a single LWW position and preserve concurrent edits", () => {
	const docs = replicas();
	const [a, b, c] = docs;
	try {
		const reference = c!.items[1]!;
		arrayOperations(a!.items).move(1, 4);
		arrayOperations(b!.items).move(1, 0); // Same Lamport, higher actor wins.
		c!.items[1]!.label = "edited";
		c!.items[1]!.body.insert(1, "!");
		exchange(docs, 912);
		expect(labels(a!)).toEqual(["edited", "A", "C", "D", "E"]);
		expect(c!.items[0]).toBe(reference);
		expect(a!.items[0]!.body.text).toBe("B!");
		arrayOperations(c!.items).move(0, 4); // A causally later move wins.
		exchange(docs, 55);
		expect(labels(a!).at(-1)).toBe("edited");
	} finally {
		docs.forEach(destroyPulse);
	}
});

test("array deletion wins over moves; concurrent moves of different elements remain unique", () => {
	const docs = replicas();
	const [a, b, c] = docs;
	try {
		arrayOperations(a!.items).move(1, 4);
		b!.items.splice(1, 1);
		arrayOperations(c!.items).move(4, 0, 1);
		c!.items.splice(1, 0, { label: "X", body: richText("X") });
		exchange(docs, 42);
		expect(labels(a!)).not.toContain("B");
		expect(labels(a!)).toContain("X");
		expect(labels(a!)).toContain("E");
	} finally {
		docs.forEach(destroyPulse);
	}
});

test("tree is a generic codec schema; empty, nested, optional and scalar payloads work", () => {
	const schema = tree("string");
	expect(createCodec(schema).decode(createCodec(schema).encode({}))).toEqual(
		{},
	);
	const D = definePulse(
		"GenericTree",
		object({
			names: schema,
			nested: array(tree("uint")),
			maybe: optional(tree(object({ label: "string" }))),
		}),
	).materialize();
	const doc = createPulse(
		D,
		{ names: {}, nested: [{}], maybe: undefined },
		options(65536),
	);
	try {
		const node = doc.names.createNode("hello");
		node.data = "world";
		expect(node.data).toBe("world");
		const numeric = doc.nested[0]!.createNode(12);
		numeric.data = 13;
		expect(doc.nested[0]!.roots()[0]!.data).toBe(13);
		expect(() => doc.names.createNode(12 as any)).toThrow();
		const bytes = createCodec(schema).encode(snapshotPulse(doc).names);
		expect(createCodec(schema).decode(bytes)[node.id]!.data).toBe("world");
	} finally {
		destroyPulse(doc);
	}
});

test("tree moves retain identity, order and nested data; invalid operations are atomic", () => {
	const [a] = replicas(1);
	try {
		const root = a!.outline.createNode({
			label: "root",
			body: richText("root"),
		});
		const other = a!.outline.createNode({
			label: "other",
			body: richText("other"),
		});
		const child = root.createNode({ label: "child", body: richText("child") });
		const data = child.data,
			body = data.body;
		child.move(other, 0);
		expect(child.parent()).toBe(other);
		expect(child.data).toBe(data);
		body.insert(5, "!");
		expect(other.children()[0]!.data.body.text).toBe("child!");
		child.move();
		child.moveBefore(root);
		other.moveAfter(child);
		expect(a!.outline.roots().map((node) => node.data.label)).toEqual([
			"child",
			"other",
			"root",
		]);
		root.move(child);
		const size = getPulseMeta(a!).log.size;
		expect(() => child.move(root)).toThrow("own subtree");
		expect(() => root.move(root)).toThrow("own subtree");
		expect(() => child.move(undefined, -1)).toThrow(RangeError);
		expect(getPulseMeta(a!).log.size).toBe(size);
		const snap = snapshotPulse(a!).outline;
		snap[child.id]!.data.label = "detached";
		expect(child.data.label).toBe("child");
		child.delete();
		expect(() => {
			data.label = "after deletion";
		}).toThrow("deleted or hidden");
		expect(() => body.insert(0, "after deletion")).toThrow("deleted or hidden");
		expect(a!.outline.getNode(root.id)).toBeUndefined();
		expect(() => root.move()).toThrow("deleted or hidden");
	} finally {
		destroyPulse(a!);
	}
});

test("generic tree payloads can contain other trees, and tree proxies clone through initialization", () => {
	const D = definePulse(
		"NestedTrees",
		object({ nested: tree(tree("string")) }),
	).materialize();
	const doc = createPulse(D, { nested: {} }, options(65536));
	try {
		const outer = doc.nested.createNode({});
		outer.data.createNode("inside");
		expect(outer.data.roots()[0]!.data).toBe("inside");
		const other = doc.nested.createNode(outer.data);
		expect(other.data.roots()[0]!.data).toBe("inside");
		other.data.roots()[0]!.data = "detached";
		expect(outer.data.roots()[0]!.data).toBe("inside");
		outer.data = {};
		expect(outer.data.roots()).toHaveLength(0);
	} finally {
		destroyPulse(doc);
	}
});

test("restoring tombstones with the same actor never reuses IDs or position keys", () => {
	const D = definePulse(
		"RestoredTree",
		object({ outline: tree("string") }),
	).materialize();
	const a = createPulse(D, { outline: {} }, options(65536));
	let b: typeof a | undefined;
	try {
		a.outline.createNode("deleted").delete();
		b = createPulse(D, { outline: snapshotPulse(a).outline }, options(65536));
		b.outline.createNode("new");
		const restored = snapshotPulse(b).outline;
		expect(Object.keys(restored)).toHaveLength(2);
		expect(
			new Set(Object.values(restored).map((record) => record.location.position))
				.size,
		).toBe(2);
		const c = createPulse(D, { outline: restored }, options(65537));
		try {
			expect(c.outline.roots()[0]!.data).toBe("new");
		} finally {
			destroyPulse(c);
		}
	} finally {
		destroyPulse(a);
		if (b) destroyPulse(b);
	}
});

test("tree concurrent opposing moves converge to a cycle-free forest; data edits survive", () => {
	const docs = replicas();
	const [a, b, c] = docs;
	try {
		const x = a!.outline.createNode({ label: "X", body: richText("x") });
		const y = a!.outline.createNode({ label: "Y", body: richText("y") });
		sync(a!, b!);
		sync(a!, c!);
		x.move(y);
		b!.outline.getNode(y.id)!.move(b!.outline.getNode(x.id));
		c!.outline.getNode(x.id)!.data.body.insert(1, "!");
		exchange(docs, 899);
		for (const doc of docs) {
			expect(doc.outline.roots()).toHaveLength(1);
			expect(doc.outline.nodes()).toHaveLength(2);
			expect(doc.outline.roots()[0]!.id).toBe([x.id, y.id].sort()[0]!);
			expect(doc.outline.getNode(x.id)!.data.body.text).toBe("x!");
		}
	} finally {
		docs.forEach(destroyPulse);
	}
});

test("tree concurrent moves of one node use LWW for parent and position together", () => {
	const docs = replicas();
	const [a, b, c] = docs;
	try {
		const roots = ["x", "y", "z"].map((label) =>
			a!.outline.createNode({ label, body: richText(label) }),
		);
		const child = roots[0]!.createNode({
			label: "child",
			body: richText("child"),
		});
		sync(a!, b!);
		sync(a!, c!);
		child.move(roots[1]);
		b!.outline.getNode(child.id)!.move(b!.outline.getNode(roots[2]!.id));
		c!.outline.getNode(child.id)!.data.label = "edited";
		exchange(docs);
		expect(child.parent()!.id).toBe(roots[2]!.id);
		expect(child.data.label).toBe("edited");
	} finally {
		docs.forEach(destroyPulse);
	}
});

test("tree deletion hides a subtree; an offline move out survives while a move in is hidden", () => {
	const docs = replicas();
	const [a, b, c] = docs;
	try {
		const parent = a!.outline.createNode({
			label: "parent",
			body: richText("p"),
		});
		const child = parent.createNode({ label: "child", body: richText("c") });
		const other = a!.outline.createNode({
			label: "other",
			body: richText("o"),
		});
		sync(a!, b!);
		sync(a!, c!);
		parent.delete();
		b!.outline.getNode(child.id)!.move();
		c!.outline.getNode(other.id)!.move(c!.outline.getNode(parent.id));
		exchange(docs, 341);
		expect(a!.outline.nodes().map((node) => node.id)).toEqual([child.id]);
	} finally {
		docs.forEach(destroyPulse);
	}
});

test("dense fractional sibling positions stay ordered under repeated and concurrent insertions", () => {
	let left: string | undefined, right: string | undefined;
	for (let i = 0; i < 300; i++) {
		const position = positionBetween(
			left,
			right,
			i.toString(16).padStart(8, "0"),
		);
		if (left) expect(position > left).toBe(true);
		if (right) expect(position < right).toBe(true);
		if (i % 2) left = position;
		else right = position;
	}
	const docs = replicas();
	const [a, b] = docs;
	try {
		a!.outline.createNode({ label: "a", body: richText("a") });
		b!.outline.createNode({ label: "b", body: richText("b") });
		exchange(docs);
		for (let i = 0; i < 50; i++)
			a!.outline.createNode(
				{ label: `new${i}`, body: richText("") },
				undefined,
				1,
			);
		exchange(docs, 39);
		expect(a!.outline.roots()).toHaveLength(52);
	} finally {
		docs.forEach(destroyPulse);
	}
});

test("same-turn writes are one automatic connector upload, with immediate local state", async () => {
	const relay = new PulseRelay(),
		base = createMemoryConnector(relay);
	const uploads: number[] = [];
	const connector: Connector = {
		kind: "local",
		async open(input) {
			const session = await base.open(input);
			return {
				...session,
				async send(bytes) {
					const message = decodeMessage(bytes);
					if (message.kind === 3) uploads.push(message.rows.length);
					await session.send(bytes);
				},
			};
		},
	};
	const doc = createPulse(
		Definition,
		{ items: [], outline: {} },
		{ ...options(65536), connectors: [connector] },
	);
	try {
		await connectPulse(doc).synced;
		await new Promise((resolve) => setTimeout(resolve, 0));
		uploads.length = 0;
		doc.items.push({ label: "x", body: richText("") });
		doc.items[0]!.label = "changed";
		doc.outline.createNode({ label: "root", body: richText("") });
		expect(doc.items[0]!.label).toBe("changed");
		expect(uploads).toHaveLength(0);
		await eventually(() =>
			expect(relay.getLog(doc.id)!.size).toBe(getPulseMeta(doc).log.size),
		);
		expect(uploads).toEqual([3]);
	} finally {
		destroyPulse(doc);
	}
});

test("offline tree and array moves converge after reconnect through real connectors", async () => {
	const connector = createMemoryConnector();
	const a = createPulse(
		Definition,
		{ items: ["A", "B"].map((label) => ({ label, body: label })), outline: {} },
		{ ...options(65536), connectors: [connector] },
	);
	let b: typeof a | undefined;
	try {
		const parent = a.outline.createNode({ label: "p", body: richText("p") });
		const child = parent.createNode({ label: "c", body: richText("c") });
		await connectPulse(a).synced;
		b = await loadPulse(Definition, a.id, {
			...options(65537),
			connectors: [connector],
			waitFor: "all",
		});
		disconnectPulse(a);
		disconnectPulse(b);
		arrayOperations(a.items).move(0, 1);
		child.move();
		b.items[0]!.body.insert(1, "!");
		b.outline.getNode(child.id)!.data.label = "edited";
		await Promise.all([connectPulse(a).synced, connectPulse(b).synced]);
		await eventually(() => expect(snapshotPulse(b!)).toEqual(snapshotPulse(a)));
		expect(b.items[1]!.body.text).toBe("A!");
		expect(b.outline.getNode(child.id)!.parent()).toBeUndefined();
		expect(b.outline.getNode(child.id)!.data.label).toBe("edited");
	} finally {
		destroyPulse(a);
		if (b) destroyPulse(b);
	}
});
