import { describe, expect, test } from "bun:test";
import { array, bigint, map, object, optional, record } from "@gin-quin/codec";
import {
	arrayOperations,
	compilePulseSchema,
	constant,
	counter,
	createPulse,
	createPulseScope,
	definePresence,
	definePulse,
	frozen,
	getPulseMeta,
	plainText,
	schemaFingerprint,
	snapshotPulse,
	tree,
	type Counter,
	type ModelFromDefinition,
	type Pulse,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import {
	encodeMessage,
	decodeMessage,
} from "../source/connection/PulseMessage.js";

const Board = definePulse(
	"MapBoard",
	object({
		names: map("int", "string"),
		prices: map("float64", object({ label: "string" })),
		tags: map("string", "boolean"),
		flags: map("boolean", "uint"),
		big: map(bigint(), "string"),
		votes: map("uint", counter()),
		grid: map("int", map("int", "string")),
		notes: optional(map("uint", plainText())),
		rows: array(map("int", "string")),
	}),
).materialize();
type BoardModel = ModelFromDefinition<typeof Board>;
// The public type is a plain Map, keyed by the declared type.
const _names: Map<number, string> = {} as BoardModel["names"];
const _votes: Map<number, Counter> = {} as BoardModel["votes"];
const _big: Map<bigint, string> = {} as BoardModel["big"];
(void _names, _votes, _big);

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});

/** Send every row of `source` to `target` through the binary transport. */
function sync(source: Pulse<any>, target: Pulse<any>): void {
	const rows = getPulseMeta(source).log.missing([]);
	const message = decodeMessage(
		encodeMessage({
			kind: 4,
			docId: rows[0]!.docId,
			requestId: 0,
			vv: [],
			rows,
		}),
	);
	if (message.kind !== 4) throw new Error("Expected update message");
	getPulseMeta(target).applyRows(message.rows);
}

function replicas() {
	const a = createPulse(
		Board,
		{
			id: crypto.randomUUID(),
			names: new Map([[2, "two"]]),
			prices: new Map(),
			tags: new Map(),
			flags: new Map(),
			big: new Map(),
			votes: new Map(),
			grid: new Map(),
			rows: [],
		},
		options(65536),
	);
	const b = createRuntime(Board, a.id, options(65537)) as typeof a;
	sync(a, b);
	return { a, b };
}

describe("collaborative map", () => {
	test("is a Map with number keys, ints and floats", () => {
		const { a } = replicas();
		expect(a.names).toBeInstanceOf(Map);
		expect(a.names.get(2)).toBe("two");
		a.names.set(-1, "minus one").set(10, "ten");
		a.prices.set(0.5, { label: "half" });
		a.prices.set(1e21, { label: "huge" });
		a.prices.set(-0, { label: "zero" });

		expect(a.names.size).toBe(3);
		expect(a.names.has(10)).toBe(true);
		expect(a.names.has(11)).toBe(false);
		expect(a.prices.get(0.5)!.label).toBe("half");
		expect(a.prices.get(0)!.label).toBe("zero");
		a.prices.get(0.5)!.label = "one half";
		expect(a.prices.get(0.5)).toBe(a.prices.get(0.5)!);
		expect(a.prices.get(0.5)!.label).toBe("one half");

		expect(a.names.delete(10)).toBe(true);
		expect(a.names.delete(10)).toBe(false);
		expect(a.names.get(10)).toBeUndefined();
		// A key of another type is simply absent, as in a Map.
		expect(a.names.has("2" as never)).toBe(false);
		expect(a.names.get(1.5)).toBeUndefined();
	});

	test("iterates in key order, whatever the insertion order", () => {
		const { a } = replicas();
		for (const key of [10, -3, 2 ** 40, 0, 7]) a.names.set(key, String(key));
		expect([...a.names.keys()]).toEqual([-3, 0, 2, 7, 10, 2 ** 40]);
		expect([...a.names.values()]).toEqual([
			"-3",
			"0",
			"two",
			"7",
			"10",
			String(2 ** 40),
		]);
		expect([...a.names][0]).toEqual([-3, "-3"]);
		const seen: number[] = [];
		a.names.forEach((_value, key) => seen.push(key));
		expect(seen).toEqual([...a.names.keys()]);

		for (const key of [1.5, -0.25, 100, 1e-7]) a.prices.set(key, { label: "" });
		expect([...a.prices.keys()]).toEqual([-0.25, 1e-7, 1.5, 100]);
		a.tags.set("b", true).set("a", false).set("10", true);
		expect([...a.tags.keys()]).toEqual(["10", "a", "b"]);
		a.flags.set(true, 1).set(false, 0);
		expect([...a.flags.keys()]).toEqual([false, true]);
		a.big.set(2n ** 70n, "big").set(-5n, "small");
		expect([...a.big.keys()]).toEqual([-5n, 2n ** 70n]);
	});

	test("rejects keys of another type", () => {
		const { a } = replicas();
		expect(() => a.names.set(1.5, "x")).toThrow("not a valid int map key");
		expect(() => a.names.set("1" as never, "x")).toThrow("not a valid int");
		expect(() => a.votes.set(-1, counter(0))).toThrow("not a valid uint");
		expect(() => a.prices.set(NaN, { label: "" })).toThrow(
			"not a valid float64",
		);
		expect(() => a.prices.set(Infinity, { label: "" })).toThrow();
		expect(() => a.tags.set("__proto__", true)).toThrow("Unsupported property");
		expect(() => a.names.set(1, 2 as never)).toThrow("does not match");
		expect(() => {
			a.names = new Map([[1.5, "x"]]);
		}).toThrow("not a valid int map key");
	});

	test("merges concurrent entries and converges on one order", () => {
		const { a, b } = replicas();
		a.names.set(1, "from a");
		a.prices.set(2.5, { label: "a" });
		b.names.set(3, "from b");
		b.names.set(-7, "from b");
		b.names.delete(2);
		sync(a, b);
		sync(b, a);
		expect([...a.names]).toEqual([
			[-7, "from b"],
			[1, "from a"],
			[3, "from b"],
		]);
		expect([...b.names]).toEqual([...a.names]);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect(b.prices.get(2.5)!.label).toBe("a");

		// The same key written on both sides is one last-writer-wins register.
		a.names.set(5, "a");
		b.names.set(5, "b");
		sync(a, b);
		sync(b, a);
		expect(a.names.get(5)).toBe(b.names.get(5)!);
	});

	test("holds counters, text, nested maps and replaced containers", () => {
		const { a, b } = replicas();
		a.votes.set(1, counter(0));
		a.votes.get(1)!.increment(2);
		a.grid.set(0, new Map([[1, "x"]]));
		a.grid.get(0)!.set(2, "y");
		a.notes = new Map([[4, plainText("hello")]]);
		a.notes.get(4)!.insert(5, " world");
		a.rows.push(new Map([[1, "row"]]));
		a.rows[0]!.set(2, "more");
		sync(a, b);
		b.votes.get(1)!.increment();
		sync(b, a);
		expect(a.votes.get(1)!.value).toBe(3);
		expect([...b.grid.get(0)!]).toEqual([
			[1, "x"],
			[2, "y"],
		]);
		expect(b.notes!.get(4)!.text).toBe("hello world");
		expect([...b.rows[0]!]).toEqual([
			[1, "row"],
			[2, "more"],
		]);

		const old = a.grid.get(0)!;
		a.grid = new Map([[9, new Map([[9, "nine"]])]]);
		expect(() => old.size).toThrow("replaced or removed");
		expect(a.grid.get(9)!.get(9)).toBe("nine");
		a.grid.clear();
		expect(a.grid.size).toBe(0);
		const removed = arrayOperations(a.rows).delete(0, 1);
		expect(removed[0]).toBeInstanceOf(Map);
		expect([...removed[0]!]).toEqual([
			[1, "row"],
			[2, "more"],
		]);
		sync(a, b);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
	});

	test("snapshots and JSON", () => {
		const { a } = replicas();
		a.names.set(-1, "minus");
		a.prices.set(0.5, { label: "half" });
		const snapshot = snapshotPulse(a);
		expect(snapshot.names).toBeInstanceOf(Map);
		expect(Object.getPrototypeOf(snapshot.names)).toBe(Map.prototype);
		expect([...snapshot.names]).toEqual([
			[-1, "minus"],
			[2, "two"],
		]);
		expect(snapshot.prices.get(0.5)).toEqual({ label: "half" });
		// A snapshot is detached, and can be assigned back.
		snapshot.names.set(99, "detached");
		expect(a.names.has(99)).toBe(false);
		a.names = snapshot.names;
		expect(a.names.get(99)).toBe("detached");

		const json = JSON.parse(JSON.stringify(a));
		expect(json.names).toEqual([
			[-1, "minus"],
			[2, "two"],
			[99, "detached"],
		]);
		expect(new Map(json.prices).get(0.5)).toEqual({ label: "half" });
	});

	test("rejects a key that is not canonical", () => {
		// Every operation, local or received, resolves its key the same way.
		const write =
			(field: string, kind: 1 | 2 = 1) =>
			() => {
				const { a, b } = replicas();
				const target = getPulseMeta(a).model.root!.child("names")!.id;
				getPulseMeta(a).mutate([
					kind === 1
						? {
								kind,
								target,
								field,
								value: { value: "forged", constants: [], texts: [] },
							}
						: { kind, target, field },
				]);
				sync(a, b);
				return b.names;
			};
		expect(write("7")().get(7)).toBe("forged");
		expect(write("-7")().get(-7)).toBe("forged");
		for (const key of [
			"07",
			"7.0",
			"7e0",
			" 7",
			"+7",
			"1.5",
			"seven",
			"",
			"-0",
		])
			expect(write(key)).toThrow("not a valid int map key");
		expect(write("07", 2)).toThrow("not a valid int map key");

		// A whole map value is not checked where it is written, only received.
		const { a, b } = replicas();
		getPulseMeta(a).mutate([
			{
				kind: 1,
				target: getPulseMeta(a).model.root!.id,
				field: "names",
				value: { value: { "01": "forged" }, constants: [], texts: [] },
			},
		]);
		expect(() => sync(a, b)).toThrow();
		expect([...b.names.keys()]).toEqual([2]);
	});

	test("schema rules and identity", () => {
		const id = (schema: Parameters<typeof compilePulseSchema>[0]) =>
			schemaFingerprint(compilePulseSchema(schema));
		// A record keeps the identity it had when it was called a map.
		expect(id(object({ a: record("string") }))).toBe(
			"b86f8eac37abb7240ffcbf3c45cb33f0",
		);
		expect(id(object({ a: map("string", "string") }))).not.toBe(
			id(object({ a: record("string") })),
		);
		expect(id(object({ a: map("int", "string") }))).not.toBe(
			id(object({ a: map("uint", "string") })),
		);
		expect(() =>
			compilePulseSchema(object({ a: constant(map("int", "string")) })),
		).toThrow("A map cannot be constant or frozen");
		expect(() =>
			compilePulseSchema(frozen(object({ a: map("int", "string") }))),
		).toThrow("A map cannot be constant or frozen");
		expect(() => map("date" as never, "string")).toThrow("Map keys must be");
	});
});

describe("maps outside a plain field", () => {
	test("a migration reads and returns Maps", () => {
		const Stats = definePulse(
			"MapMigration",
			object({ hits: map("uint", "uint") }),
		)
			.migrateTo(
				object({ hits: map("uint", "uint"), total: "uint" }),
				(before) => {
					expect(before.hits).toBeInstanceOf(Map);
					let total = 0;
					for (const count of before.hits.values()) total += count;
					return { hits: new Map([...before.hits, [99, 1]]), total: total + 1 };
				},
			)
			.materialize();
		const first = definePulse(
			"MapMigration",
			object({ hits: map("uint", "uint") }),
		).materialize();
		const old = createPulse(
			first,
			{ id: crypto.randomUUID(), hits: new Map([[1, 2]]) },
			options(65536),
		);
		const migrated = createRuntime(Stats, old.id, options(65537));
		sync(old, migrated as never);
		const snapshot = snapshotPulse(migrated) as unknown as {
			hits: Map<number, number>;
			total: number;
		};
		expect([...snapshot.hits]).toEqual([
			[1, 2],
			[99, 1],
		]);
		expect(snapshot.total).toBe(3);
	});

	test("an unknown field stores a Map as a record of its keys", () => {
		const Loose = definePulse(
			"MapUnknown",
			object({ any: "unknown" }),
		).materialize();
		const pulse = createPulse(
			Loose,
			{
				id: crypto.randomUUID(),
				any: new Map([[1.5, new Map([[true, "x"]])]]),
			},
			options(65536),
		);
		expect(snapshotPulse(pulse).any).toEqual({ "1.5": { true: "x" } });
		expect(() => {
			pulse.any = new Map([[{}, 1]]);
		}).toThrow("Map keys must be primitive values");
	});

	test("a presence state and a tree node hold Maps", () => {
		const Cursors = definePresence(
			"map-cursors",
			object({ seen: map("uint", "boolean") }),
		);
		const state = { seen: new Map([[3, true]]) };
		const decoded = Cursors.codec.decode(
			Cursors.codec.encode(Cursors.assert(state)),
		);
		expect(decoded.seen).toBeInstanceOf(Map);
		expect([...decoded.seen]).toEqual([[3, true]]);
		expect(() => Cursors.assert({ seen: new Map([[-1, true]]) })).toThrow(
			"not a valid uint map key",
		);

		const Cards = definePulse(
			"MapTree",
			object({ cards: tree(object({ scores: map("int", "uint") })) }),
		).materialize();
		const board = createPulse(Cards, { cards: {} }, options(65536));
		const card = board.cards.createNode({ scores: new Map([[-1, 5]]) });
		card.data.scores.set(2, 7);
		expect([...card.data.scores]).toEqual([
			[-1, 5],
			[2, 7],
		]);
		const stored = Object.values(board.cards.snapshot())[0]!;
		expect(stored.data.scores).toBeInstanceOf(Map);
		expect(stored.data.scores.get(2)).toBe(7);
	});

	test("a pulse root cannot be a map", () => {
		expect(() =>
			definePulse("MapRoot", map("int", "string")).materialize(),
		).toThrow("A pulse cannot be a map");
	});
});
