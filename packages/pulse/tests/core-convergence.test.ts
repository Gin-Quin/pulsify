import { expect, test } from "bun:test";
import { array, literal, object } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	struct,
	tuple,
	type Pulse,
	type PulseProperties,
} from "../source/index";
import { createRuntime } from "../source/pulses/PulseRuntime";
import { defaultPulseOptions } from "../source/pulses/PulseOptions";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage";
import type { PulsePatchRow } from "../source/connection/PulsePatch";
import { Document, data } from "./helpers";

type Replica = Pulse<Document>;
const config = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
function wire(rows: PulsePatchRow[]): PulsePatchRow[] {
	if (!rows.length) return [];
	const message = decodeMessage(
		encodeMessage({
			kind: 4,
			docId: rows[0]!.docId,
			requestId: 0,
			vv: [],
			rows,
		}),
	);
	if (message.kind !== 4) throw new Error("Expected a patch message");
	return message.rows;
}
function apply(target: Replica, rows: PulsePatchRow[]): void {
	getPulseMeta(target).applyRows(wire(rows));
}
function withReplicas(body: (replicas: Replica[]) => void, count = 3): void {
	const first = createPulse(
		Document,
		{ ...data("core-convergence"), optional: "initial" },
		config(65536),
	);
	const replicas: Replica[] = [first];
	try {
		for (let i = 1; i < count; i++) {
			const replica = createRuntime(
				Document,
				first.id,
				config(65536 + i),
			) as Replica;
			replicas.push(replica);
			apply(replica, getPulseMeta(first).log.missing([]));
		}
		body(replicas);
	} finally {
		for (const replica of replicas) destroyPulse(replica);
	}
}
function exchange(replicas: Replica[], seed = 1): void {
	const rows = replicas.flatMap((replica) =>
		getPulseMeta(replica).log.missing([]),
	);
	let state = seed;
	const random = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
	for (const replica of replicas) {
		const shuffled = [...rows];
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = random() % (i + 1);
			[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
		}
		for (const row of shuffled) {
			apply(replica, [row]);
			if (random() % 3 === 0) apply(replica, [row]);
		}
		expect(getPulseMeta(replica).log.pendingCount).toBe(0);
	}
	for (const replica of replicas.slice(1)) {
		expect(snapshotPulse(replica)).toEqual(snapshotPulse(replicas[0]!));
		expect(getPulseMeta(replica).log.vector).toEqual(
			getPulseMeta(replicas[0]!).log.vector,
		);
	}
}
const values = (replica: Replica) => replica.items.map((item) => item.value);

test("core: simultaneous insertion runs at one anchor stay contiguous", () => {
	withReplicas(([a, b, c]) => {
		a!.items.unshift({ value: 11 }, { value: 12 }, { value: 13 });
		b!.items.unshift({ value: 21 }, { value: 22 }, { value: 23 });
		exchange([a!, b!, c!], 91);
		const result = values(a!);
		expect(result.slice(-2)).toEqual([1, 2]);
		expect(result.slice(result.indexOf(11), result.indexOf(11) + 3)).toEqual([
			11, 12, 13,
		]);
		expect(result.slice(result.indexOf(21), result.indexOf(21) + 3)).toEqual([
			21, 22, 23,
		]);
	});
});

test("core: insertion after a concurrently deleted anchor survives its tombstone", () => {
	withReplicas(([a, b, c]) => {
		a!.items.splice(0, 1);
		b!.items.splice(1, 0, { value: 10 });
		exchange([a!, b!, c!], 14);
		expect(values(a!)).toEqual([10, 2]);
	});
});

test("core: concurrent deletion and child edit cannot resurrect an array entry", () => {
	withReplicas(([a, b, c]) => {
		a!.items.splice(0, 1);
		b!.items[0]!.value = 99;
		exchange([a!, b!, c!], 17);
		expect(values(a!)).toEqual([2]);
	});
});

test("core: concurrent replacements of one array entry keep its cardinality", () => {
	withReplicas(([a, b, c]) => {
		a!.items[0] = { value: 10 };
		b!.items[0] = { value: 20 };
		exchange([a!, b!, c!], 19);
		expect(a!.items.length).toBe(2);
		expect([10, 20]).toContain(a!.items[0]!.value);
		expect(a!.items[1]!.value).toBe(2);
	});
});

test("core: replacing a parent does not reattach a concurrently edited old child", () => {
	withReplicas(([a, b, c]) => {
		const oldChild = b!.nested;
		a!.nested = { count: 40 };
		oldChild.count = 21;
		exchange([a!, b!, c!], 27);
		expect(a!.nested.count).toBe(40);
		expect(() => oldChild.count).toThrow();
		expect(() => {
			oldChild.count = 22;
		}).toThrow();
	});
});

test("core: replacing an array item isolates edits made to its previous value", () => {
	withReplicas(([a, b, c]) => {
		const oldItem = b!.items[0]!;
		a!.items[0] = { value: 40 };
		oldItem.value = 21;
		exchange([a!, b!, c!], 28);
		expect(values(a!)).toEqual([40, 2]);
		expect(() => oldItem.value).toThrow();
	});
});

test("core: a causally later register write wins even from the lower actor", () => {
	withReplicas(([a, b, c]) => {
		b!.title = "higher actor";
		apply(a!, getPulseMeta(b!).log.missing(getPulseMeta(a!).log.vector));
		a!.title = "causally later, lower actor";
		exchange([a!, b!, c!], 31);
		expect(a!.title).toBe("causally later, lower actor");
	});
});

test("core: simultaneous register writes have one delivery-independent winner", () => {
	withReplicas(([a, b, c]) => {
		a!.title = "a";
		b!.title = "b";
		c!.title = "c";
		exchange([a!, b!, c!], 47);
		expect(["a", "b", "c"]).toContain(a!.title);
	});
});

test("core: a deleted property may be reinserted by a causally later write", () => {
	withReplicas(([a, b, c]) => {
		delete b!.optional;
		apply(a!, getPulseMeta(b!).log.missing(getPulseMeta(a!).log.vector));
		expect("optional" in a!).toBe(false);
		a!.optional = "restored causally";
		exchange([a!, b!, c!], 49);
		expect(a!.optional).toBe("restored causally");
	});
});

test("core: concurrent deletion and assignment of a property converge", () => {
	withReplicas(([a, b, c]) => {
		delete a!.optional;
		b!.optional = "changed";
		exchange([a!, b!, c!], 50);
		expect([undefined, "changed"]).toContain(a!.optional);
	});
});

test("core: missing actor history cannot advance the contiguous frontier", () => {
	withReplicas(([a, b, c]) => {
		const before = getPulseMeta(b!).log.vector;
		for (let i = 1; i <= 4; i++) a!.nested.count = i;
		const rows = getPulseMeta(a!).log.missing(before);
		expect(rows.length).toBeGreaterThan(1);
		apply(b!, [rows.at(-1)!]);
		expect(getPulseMeta(b!).log.vector).toEqual(before);
		expect(getPulseMeta(b!).log.pendingCount).toBe(1);
		expect(b!.nested.count).toBe(0);
		for (const row of rows.slice(0, -1).reverse()) apply(b!, [row]);
		expect(b!.nested.count).toBe(4);
		expect(getPulseMeta(b!).log.pendingCount).toBe(0);
		expect(getPulseMeta(b!).log.vector).toEqual(getPulseMeta(a!).log.vector);
		exchange([a!, b!, c!], 57);
	});
});

test("core: a dependent cross-actor edit waits for its creating transaction", () => {
	withReplicas(([a, b, c]) => {
		const base = getPulseMeta(c!).log.vector;
		a!.items.push({ value: 10 });
		const created = getPulseMeta(a!).log.missing(base);
		apply(b!, created);
		const afterCreate = getPulseMeta(b!).log.vector;
		b!.items.at(-1)!.value = 11;
		const dependent = getPulseMeta(b!).log.missing(afterCreate);
		apply(c!, dependent);
		expect(getPulseMeta(c!).log.vector).toEqual(base);
		expect(getPulseMeta(c!).log.pendingCount).toBe(1);
		expect(values(c!)).toEqual([1, 2]);
		apply(c!, created);
		expect(values(c!)).toEqual([1, 2, 11]);
		expect(getPulseMeta(c!).log.pendingCount).toBe(0);
		exchange([a!, b!, c!], 59);
	});
});

test("core: a batch may update an array entry inserted by an earlier row in that batch", () => {
	withReplicas(([a, b, c]) => {
		const before = getPulseMeta(b!).log.vector;
		a!.items.push({ value: 10 });
		a!.items[a!.items.length - 1] = { value: 11 };
		apply(b!, getPulseMeta(a!).log.missing(before));
		expect(values(b!)).toEqual([1, 2, 11]);
		expect(snapshotPulse(b!)).toEqual(snapshotPulse(a!));
		exchange([a!, b!, c!], 61);
	});
});

test("core: imported Lamport time does not create gaps in the local actor sequence", () => {
	withReplicas(([a, b]) => {
		for (let i = 1; i <= 100; i++) a!.nested.count = i;
		apply(b!, getPulseMeta(a!).log.missing(getPulseMeta(b!).log.vector));
		const before = getPulseMeta(b!).log.vector;
		b!.title = "first transaction by this actor";
		const first = getPulseMeta(b!).log.missing(before);
		expect(first).toHaveLength(1);
		expect(first[0]!.sid).toBe(65537);
		expect(first[0]!.clock).toBe(1);
		const checkpoint = getPulseMeta(b!).log.vector;
		b!.title = "second transaction by this actor";
		const second = getPulseMeta(b!).log.missing(checkpoint);
		expect(second).toHaveLength(1);
		expect(second[0]!.clock).toBe(first[0]!.clock + first[0]!.span);
	});
});

test("core: schema constants reject replacement and deep mutation on all replicas", () => {
	const schema = object({
		fixed: object({ nested: object({ values: array("uint") }) }),
		format: literal("v1"),
		mutable: "uint",
	});
	const Definition = definePulse("SchemaConstants", schema, {
		constantPaths: [["fixed"]],
	}).materialize();
	const a = createPulse(
		Definition,
		{ fixed: { nested: { values: [1, 2] } }, format: "v1", mutable: 0 },
		config(65536),
	);
	const b = createRuntime(Definition, a.id, config(65537)) as typeof a;
	try {
		getPulseMeta(b).applyRows(wire(getPulseMeta(a).log.missing([])));
		const initial = snapshotPulse(a);
		for (const replica of [a, b]) {
			const before = getPulseMeta(replica).log.vector;
			for (const edit of [
				() => ((replica as any).fixed = { nested: { values: [8] } }),
				() => delete (replica as any).fixed,
				() => ((replica.fixed.nested.values as any)[0] = 8),
				() => (replica.fixed.nested.values as any).push(8),
				() => ((replica as any).format = "v2"),
				() => delete (replica as any).format,
			]) {
				expect(edit).toThrow();
				expect(snapshotPulse(replica)).toEqual(initial);
				expect(getPulseMeta(replica).log.vector).toEqual(before);
			}
		}
		a.mutable = 1;
		getPulseMeta(b).applyRows(
			wire(getPulseMeta(a).log.missing(getPulseMeta(b).log.vector)),
		);
		expect(b.mutable).toBe(1);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("core: deep constant values survive binary transfer and rejected edits are atomic", () => {
	type Constants = PulseProperties<"CoreConstants"> & {
		fixed: ReturnType<typeof struct<{ nested: { values: number[] } }>>;
		pair: ReturnType<typeof tuple<[number, { label: string }]>>;
	};
	const Definition = definePulse<Constants>("CoreConstants").materialize();
	const fixed = struct({ nested: { values: [1, 2, 3] } });
	const pair = tuple<[number, { label: string }]>([1, { label: "fixed" }]);
	const a = createPulse(Definition, { fixed, pair }, config(65536));
	const b = createRuntime(Definition, a.id, config(65537)) as Pulse<Constants>;
	try {
		getPulseMeta(b).applyRows(wire(getPulseMeta(a).log.missing([])));
		const initial = snapshotPulse(a);
		for (const replica of [a, b]) {
			const vector = getPulseMeta(replica).log.vector;
			for (const edit of [
				() => ((replica.fixed.nested as any).values[0] = 9),
				() => (replica.fixed.nested.values as any).push(4),
				() => ((replica.pair[1] as any).label = "changed"),
				() => delete (replica.fixed.nested as any).values,
			]) {
				expect(edit).toThrow();
				expect(snapshotPulse(replica)).toEqual(initial);
				expect(getPulseMeta(replica).log.vector).toEqual(vector);
			}
		}
		// Initial caller-owned constants cannot mutate the stored graph afterwards.
		(fixed.nested.values as any)[0] = 100;
		(pair[1] as any).label = "caller changed";
		expect(snapshotPulse(a)).toEqual(initial);
		expect(snapshotPulse(b)).toEqual(initial);
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

for (let seed = 1; seed <= 12; seed++) {
	test(`core: mixed offline sequence converges under reordering and duplication (${seed})`, () => {
		withReplicas((replicas) => {
			let state = seed;
			const random = () => {
				state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
				return state;
			};
			for (let wave = 0; wave < 4; wave++) {
				for (const replica of replicas) {
					for (let edit = 0; edit < 7; edit++) {
						const n = random();
						switch ((n >>> 8) % 8) {
							case 0:
								replica.title = `title-${n}`;
								break;
							case 1:
								replica.nested.count = n;
								break;
							case 2:
								replica.nested = { count: n };
								break;
							case 3:
								replica.items.push({ value: n });
								break;
							case 4:
								replica.items.unshift({ value: n }, { value: n + 1 });
								break;
							case 5:
								if (replica.items.length)
									replica.items.splice(random() % replica.items.length, 1);
								break;
							case 6:
								if (replica.items.length)
									replica.items[random() % replica.items.length] = { value: n };
								break;
							case 7:
								if (replica.items.length)
									replica.items[random() % replica.items.length]!.value = n;
								break;
						}
					}
				}
				exchange(replicas, random());
			}
		}, 4);
	});
}
