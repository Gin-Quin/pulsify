import { describe, expect, test } from "bun:test";
import { array, record, object, optional } from "@gin-quin/codec";
import {
	applyPulseUpdates,
	arrayOperations,
	compilePulseSchema,
	constant,
	counter,
	createPulse,
	createPulseScope,
	definePulse,
	exportPulseUpdates,
	getPulseMeta,
	schemaFingerprint,
	snapshotPulse,
	tree,
	versioned,
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

const Post = definePulse(
	"CounterPost",
	object({
		title: "string",
		likes: counter(),
		// Every change of this one stays in history, like a versioned field.
		tally: versioned(counter()),
		views: optional(counter()),
		reactions: record(counter()),
		polls: array(object({ label: "string", votes: counter() })),
		scores: array(counter()),
	}),
).materialize();
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

function replicas(likes = 0) {
	const a = createPulse(
		Post,
		{
			id: crypto.randomUUID(),
			title: "Post",
			likes,
			tally: 0,
			reactions: {},
			polls: [],
			scores: [],
		},
		options(65536),
	);
	const b = createRuntime(Post, a.id, options(65537)) as typeof a;
	sync(a, b);
	return { a, b };
}
const nodeOf = (pulse: Pulse<any>, key: string) =>
	getPulseMeta(pulse).model.root!.child(key)!;

describe("collaborative counter", () => {
	test("reads like a number, and increments, decrements and sets", () => {
		const { a } = replicas(2);
		const likes: Counter = a.likes;
		likes.increment();
		likes.increment(3);
		likes.decrement(9);
		expect(likes.value).toBe(-3);
		likes.set(7);
		likes.decrement();
		expect(likes.value).toBe(6);
		expect(+likes).toBe(6);
		expect(`${likes}`).toBe("6");
		expect(JSON.stringify(a)).toContain('"likes":6');
		expect(snapshotPulse(a).likes).toBe(6);
		expect(a.likes).toBe(likes);

		const rows = getPulseMeta(a).log.missing([]).length;
		for (const amount of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) {
			expect(() => likes.increment(amount)).toThrow(RangeError);
			if (amount !== Number.MAX_SAFE_INTEGER)
				expect(() => likes.decrement(amount)).toThrow(RangeError);
		}
		for (const total of [1.5, NaN, Infinity])
			expect(() => likes.set(total)).toThrow(RangeError);
		likes.set(6); // The value it already has: nothing to write.
		expect(() => counter(1.5)).toThrow("integer");
		expect(() => counter(1).increment()).toThrow("Attach");
		expect(likes.value).toBe(6);
		expect(getPulseMeta(a).log.missing([]).length).toBe(rows);
	});

	test("concurrent changes add up on every replica", () => {
		const { a, b } = replicas(1);
		for (let i = 0; i < 5; i++) a.likes.increment();
		b.likes.increment(2);
		b.likes.decrement();
		expect(a.likes.value).toBe(6);
		expect(b.likes.value).toBe(2);
		sync(a, b);
		sync(b, a);
		sync(a, b); // A retransmission changes nothing.
		expect(a.likes.value).toBe(7);
		expect(b.likes.value).toBe(7);
		expect(snapshotPulse(b).likes).toBe(7);
		// One count per actor, each written by its own actor only.
		expect(nodeOf(b, "likes").data).toEqual({ 65536: 6, 65537: 1 });
	});

	test("set writes a difference into the setter's own count", () => {
		const { a, b } = replicas(10);
		b.likes.set(0);
		expect(nodeOf(b, "likes").data).toEqual({ 65536: 10, 65537: -10 });
		a.likes.increment(); // Concurrent with the set: it survives it.
		sync(a, b);
		sync(b, a);
		expect(a.likes.value).toBe(1);
		expect(b.likes.value).toBe(1);
		// Two concurrent sets both apply their difference.
		a.likes.set(5);
		b.likes.set(5);
		sync(a, b);
		sync(b, a);
		expect(a.likes.value).toBe(9);
		expect(b.likes.value).toBe(9);
	});

	test("counts travel like scalar registers in every envelope", () => {
		const size = (frames: Uint8Array[]) =>
			frames.reduce((sum, frame) => sum + frame.length, 0);
		const sizes: number[] = [];
		for (const peerVersion of [1, 2, 3, 4] as const) {
			const { a, b } = replicas();
			const base = getPulseMeta(b).log.vector;
			for (let i = 0; i < 40; i++) a.tally.increment();
			b.tally.increment();
			const frames = exportPulseUpdates(a, base, { peerVersion });
			sizes.push(size(frames));
			applyPulseUpdates(b, frames);
			expect(b.tally.value).toBe(41);
			expect(snapshotPulse(b).tally).toBe(41);
		}
		// A run of counts is grouped, then condensed to its last count.
		expect(sizes[1]).toBeLessThan(sizes[0]! / 4);
		expect(sizes[2]).toBeLessThan(120);
		// A lone change is a compact frame, like a number field's.
		const { a, b } = replicas();
		const base = getPulseMeta(b).log.vector;
		a.tally.decrement(3);
		const frames = exportPulseUpdates(a, base, { peerVersion: 4 });
		expect(size(frames)).toBeLessThan(
			size(exportPulseUpdates(a, base, { peerVersion: 1 })) / 2,
		);
		applyPulseUpdates(b, frames);
		expect(b.tally.value).toBe(-3);
	});

	test("a counter keeps one row per actor, whatever the number of changes", () => {
		const { a, b } = replicas();
		const rows = (pulse: Pulse<any>) => getPulseMeta(pulse).log.size;
		const base = rows(a);
		for (let i = 0; i < 300; i++) {
			a.likes.increment();
			b.likes.increment(2);
			if (i % 50 === 0) {
				sync(a, b);
				sync(b, a);
			}
		}
		sync(a, b);
		sync(b, a);
		expect(a.likes.value).toBe(900);
		expect(b.likes.value).toBe(900);
		// One count per actor, and one gap: every first row of `b` was replaced,
		// and no earlier row of that actor can cover them.
		expect(rows(a)).toBe(base + 3);
		expect(rows(b)).toBe(base + 3);
		// A versioned counter keeps every change.
		for (let i = 0; i < 10; i++) a.tally.increment();
		expect(rows(a)).toBe(base + 13);
	});

	test("lives in optional fields, maps, arrays and trees", () => {
		const { a, b } = replicas();
		expect(a.views).toBeUndefined();
		a.views = counter(0);
		a.reactions["👍"] = counter(2);
		a.polls.push({ label: "Yes", votes: counter(0) });
		a.scores.push(counter(1), counter(2));
		sync(a, b);
		arrayOperations(a.scores).move(0, 1);
		b.scores[0]!.increment(10);
		a.views!.increment();
		a.reactions["👍"]!.increment();
		a.polls[0]!.votes.increment();
		b.views!.increment();
		b.reactions["👍"]!.increment();
		b.polls[0]!.votes.increment(4);
		sync(a, b);
		sync(b, a);
		for (const pulse of [a, b])
			expect(snapshotPulse(pulse)).toMatchObject({
				views: 2,
				reactions: { "👍": 4 },
				polls: [{ label: "Yes", votes: 5 }],
				scores: [2, 11],
			});

		const Board = definePulse(
			"CounterBoard",
			object({ cards: tree(object({ votes: counter() })) }),
		).materialize();
		const board = createPulse(Board, { cards: {} }, options(65536));
		const card = board.cards.createNode({ votes: 1 });
		card.data.votes.increment();
		expect(board.cards.toJSON()[0]!.data).toEqual({ votes: 2 });
	});

	test("assigning to an existing counter sets it, and keeps it", () => {
		const { a, b } = replicas(5);
		const before = a.likes;
		b.likes.increment();
		a.likes = counter(0);
		expect(a.likes).toBe(before);
		a.scores.push(counter(3));
		a.scores[0] = counter(1);
		a.likes = a.likes; // Its own value: nothing to write.
		sync(a, b);
		sync(b, a);
		// The concurrent increment survives the assignment.
		expect(a.likes.value).toBe(1);
		expect(b.likes.value).toBe(1);
		expect(snapshotPulse(b).scores).toEqual([1]);
		// A plain number is the same assignment, for untyped code.
		(b as { likes: unknown }).likes = 7;
		sync(b, a);
		expect(a.likes.value).toBe(7);
		expect(() => {
			(a as { likes: unknown }).likes = 1.5;
		}).toThrow("does not match");
		// Removing a counter and creating it again does replace it.
		a.views = counter(4);
		const views = a.views!;
		delete a.views;
		a.views = counter(0);
		expect(() => views.value).toThrow("replaced or removed");
		expect(a.views!.value).toBe(0);
	});

	test("rejects a count that is not an integer written by its actor", () => {
		const forge = (field: string | number, value: unknown) => {
			const { a, b } = replicas();
			getPulseMeta(a).mutate([
				{
					kind: 1,
					target: nodeOf(a, "likes").id,
					field,
					value: { value, constants: [], texts: [] },
				},
			]);
			return () => sync(a, b);
		};
		expect(forge(65536, 9)).not.toThrow();
		expect(forge(65537, 9)).toThrow("written by its actor");
		expect(forge("65536", 9)).toThrow("written by its actor");
		expect(forge(65536, 1.5)).toThrow("written by its actor");
		expect(forge(65536, Infinity)).toThrow("written by its actor");
		const { a, b } = replicas();
		getPulseMeta(a).mutate([
			{ kind: 2, target: nodeOf(a, "likes").id, field: 65536 },
		]);
		expect(() => sync(a, b)).toThrow("written by its actor");
		// A long run of one actor's counts is validated as a whole.
		const run = replicas();
		const base = getPulseMeta(run.b).log.vector;
		for (let i = 0; i < 40; i++) run.a.tally.increment();
		getPulseMeta(run.a).model.commitScalar(
			nodeOf(run.a, "tally"),
			"65536",
			65536,
			40.5,
		);
		for (const peerVersion of [2, 3] as const)
			expect(() =>
				applyPulseUpdates(
					run.b,
					exportPulseUpdates(run.a, base, { peerVersion }),
				),
			).toThrow("does not match");
		// A counter is created with an integer too.
		const created = replicas();
		getPulseMeta(created.a).mutate([
			{
				kind: 1,
				target: getPulseMeta(created.a).model.root!.id,
				field: "views",
				value: { value: 1.5, constants: [], texts: [] },
			},
		]);
		expect(() => sync(created.a, created.b)).toThrow("does not match");
	});

	test("is a float64 for codec, with its own schema identity", () => {
		const plain = compilePulseSchema(object({ likes: "float64" }));
		const counted = compilePulseSchema(object({ likes: counter() }));
		expect(counted.codec.encode({ likes: -3 })).toEqual(
			plain.codec.encode({ likes: -3 }),
		);
		expect(schemaFingerprint(counted)).not.toBe(schemaFingerprint(plain));
		expect(() =>
			compilePulseSchema(constant(object({ likes: counter() }))),
		).toThrow("counter");
		expect(() => counted.assert({ likes: 1.5 })).toThrow("does not match");
		expect(() =>
			createPulse(Post, {
				title: "",
				likes: 1.5,
				tally: 0,
				reactions: {},
				polls: [],
				scores: [],
			}),
		).toThrow("does not match");
	});

	test("a migration turns a number into a counter", () => {
		const v1 = object({ likes: "uint" });
		const old = createPulse(
			definePulse("CounterMigration", v1).materialize(),
			{ id: crypto.randomUUID(), likes: 3 },
			options(65536),
		);
		const Latest = definePulse("CounterMigration", v1)
			.migrateTo(object({ likes: counter() }), () => ({}))
			.materialize();
		type Migrated = Pulse<ModelFromDefinition<typeof Latest>>;
		const a = createRuntime(Latest, old.id, options(65537)) as Migrated;
		const b = createRuntime(Latest, old.id, options(65538)) as Migrated;
		sync(old, a);
		sync(a, b);
		a.likes.increment();
		b.likes.increment();
		sync(a, b);
		sync(b, a);
		expect(a.likes.value).toBe(5);
		expect(b.likes.value).toBe(5);
	});
});
