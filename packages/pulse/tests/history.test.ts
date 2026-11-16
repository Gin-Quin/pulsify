import { describe, expect, test } from "bun:test";
import { array, object, optional, record } from "@gin-quin/codec";
import {
	connectPulse,
	counter,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	frozen,
	loadPulse,
	PulseRelay,
	getPulseMeta,
	snapshotPulse,
	versioned,
	type Pulse,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import {
	encodeMessage,
	decodeMessage,
} from "../source/connection/PulseMessage.js";
import { isGapRow } from "../source/protocol/PatchLog.js";
import { rowToPatch } from "../source/connection/PulsePatch.js";

const Note = definePulse(
	"HistoryNote",
	object({
		title: "string",
		status: versioned("string"),
		price: versioned("float64", { timestamps: true }),
		likes: counter(),
		author: object({ name: "string", age: optional("uint") }),
		size: frozen(object({ width: "uint", height: "uint" })),
		tags: record("string"),
		items: array("string"),
	}),
).materialize();
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
const meta = (pulse: Pulse<any>) => getPulseMeta(pulse);
const rows = (pulse: Pulse<any>) => meta(pulse).log.missing([]);
const count = (pulse: Pulse<any>) => rows(pulse).length;

/** Send what `target` lacks from `source` through the binary transport. */
function sync(source: Pulse<any>, target: Pulse<any>): void {
	const missing = meta(source).log.missing(meta(target).log.vector);
	if (!missing.length) return;
	const message = decodeMessage(
		encodeMessage({
			kind: 4,
			docId: missing[0]!.docId,
			requestId: 0,
			vv: [],
			rows: missing,
		}),
	);
	if (message.kind !== 4) throw new Error("Expected update message");
	meta(target).applyRows(message.rows);
}
function create(sessionId = 65536) {
	return createPulse(
		Note,
		{
			id: crypto.randomUUID(),
			title: "Draft",
			status: "open",
			price: 1,
			likes: 0,
			author: { name: "Ada" },
			size: { width: 1, height: 1 },
			tags: {},
			items: [],
		},
		options(sessionId),
	);
}
function join(source: Pulse<any>, sessionId: number) {
	const peer = createRuntime(Note, source.id, options(sessionId)) as ReturnType<
		typeof create
	>;
	sync(source, peer);
	return peer;
}
/** The journal covers every sequence number of every actor exactly once. */
function assertTiled(pulse: Pulse<any>): void {
	const next = new Map<number, number>();
	for (const row of rows(pulse).sort(
		(a, b) => a.sid - b.sid || a.clock - b.clock,
	)) {
		expect(row.clock).toBe(next.get(row.sid) ?? 1);
		next.set(row.sid, row.clock + row.span);
	}
	expect([...next].sort((a, b) => a[0] - b[0])).toEqual(meta(pulse).log.vector);
}

describe("last value by default", () => {
	test("rewriting a field keeps one row, whatever the number of writes", () => {
		const a = create();
		const base = count(a);
		for (let i = 0; i < 500; i++) a.title = `Title ${i}`;
		expect(count(a)).toBe(base + 1);
		for (let i = 0; i < 500; i++) {
			a.title = `T${i}`;
			a.author.name = `N${i}`;
			a.author.age = i;
			a.tags["x"] = `tag${i}`;
			a.size = { width: i, height: i };
			a.likes.increment();
		}
		// One row per register, however the writes interleave.
		expect(count(a)).toBe(base + 6);
		assertTiled(a);
		expect(snapshotPulse(a)).toMatchObject({
			title: "T499",
			author: { name: "N499", age: 499 },
			tags: { x: "tag499" },
			size: { width: 499, height: 499 },
			likes: 500,
		});
		const b = join(a, 65537);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect(count(b)).toBe(count(a));
		assertTiled(b);
	});

	test("a deletion replaces the value, and is replaced in turn", () => {
		const a = create();
		const base = count(a);
		for (let i = 0; i < 50; i++) {
			a.tags["x"] = `v${i}`;
			delete a.tags["x"];
			a.author.age = i;
			delete a.author.age;
		}
		expect(count(a)).toBe(base + 2);
		const b = join(a, 65537);
		expect(snapshotPulse(b).tags).toEqual({});
		expect(snapshotPulse(b).author).toEqual({ name: "Ada" });
		a.tags["x"] = "back";
		sync(a, b);
		expect(b.tags["x"]).toBe("back");
		expect(count(a)).toBe(base + 2);
		expect(count(b)).toBe(base + 2);
	});

	test("values that create nodes, and sequences, keep their history", () => {
		const a = create();
		const base = count(a);
		for (let i = 0; i < 5; i++) {
			a.author = { name: `Author ${i}` };
			a.items.push(`item ${i}`);
		}
		expect(count(a)).toBe(base + 10);
	});

	test("a peer that is behind catches up through rows that span replaced writes", () => {
		const a = create();
		const b = join(a, 65537);
		for (let i = 0; i < 20; i++) a.title = `A${i}`;
		sync(a, b); // b holds the last title, at the frontier.
		for (let i = 0; i < 20; i++) {
			a.title = `B${i}`;
			a.items.push(`${i}`);
		}
		sync(a, b);
		sync(a, b);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect(meta(b).log.vector).toEqual(meta(a).log.vector);
		expect(meta(b).log.pendingCount).toBe(0);
		assertTiled(a);
		assertTiled(b);
		// And a third peer learns everything from the one that caught up.
		const c = join(b, 65538);
		expect(snapshotPulse(c)).toEqual(snapshotPulse(a));
		assertTiled(c);
	});

	test("an actor whose every write was replaced is still covered", () => {
		const a = create();
		const b = join(a, 65537);
		b.title = "from b"; // b's only row
		sync(b, a);
		a.title = "from a"; // replaces it
		sync(a, b);
		expect(rows(a).some(isGapRow)).toBe(true);
		const c = join(a, 65538);
		expect(c.title).toBe("from a");
		expect(meta(c).log.vector).toEqual(meta(a).log.vector);
		// b's next write follows its replaced one.
		b.title = "b again";
		sync(b, a);
		sync(a, c);
		sync(b, c);
		expect([a.title, c.title]).toEqual(["b again", "b again"]);
		for (const pulse of [a, b, c]) assertTiled(pulse);
		expect(count(a)).toBe(count(c));
	});

	test("concurrent writes keep the winner on every replica and in every journal", () => {
		const a = create();
		const b = join(a, 65537);
		for (let i = 0; i < 10; i++) {
			a.title = `a${i}`;
			b.title = `b${i}`;
		}
		sync(a, b);
		sync(b, a);
		expect(a.title).toBe(b.title);
		const winner = a.title;
		const c = join(a, 65538);
		const d = join(b, 65539);
		expect([c.title, d.title]).toEqual([winner, winner]);
		// A later write replaces the winner everywhere.
		c.title = "final";
		for (const peer of [a, b, d]) sync(c, peer);
		expect([a.title, b.title, d.title]).toEqual(["final", "final", "final"]);
	});
});

describe("through a relay", () => {
	test("connected clients converge, and a late one loads a short history", async () => {
		const relay = new PulseRelay();
		const connector = createMemoryConnector(relay);
		const scoped = () => ({
			scope: createPulseScope(),
			connectors: [connector],
		});
		const a = createPulse(
			Note,
			{
				id: crypto.randomUUID(),
				title: "Draft",
				status: "open",
				price: 1,
				likes: 0,
				author: { name: "Ada" },
				size: { width: 1, height: 1 },
				tags: {},
				items: [],
			},
			scoped(),
		);
		await connectPulse(a).synced;
		const b = await loadPulse(Note, a.id, { ...scoped(), waitFor: "all" });
		for (let i = 0; i < 150; i++) {
			const writer = i % 3 ? a : b;
			writer.title = `title ${i}`;
			writer.likes.increment();
			writer.author.name = `name ${i}`;
			// Some writes travel together, some alone.
			if (i % 4 === 0) await Promise.resolve();
			if (i % 10 === 0) {
				await connectPulse(a).synced;
				await connectPulse(b).synced;
			}
		}
		for (let round = 0; round < 3; round++) {
			await connectPulse(a).synced;
			await connectPulse(b).synced;
			await Bun.sleep(5);
		}
		expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
		expect(a.likes.value).toBe(150);
		const late = await loadPulse(Note, a.id, { ...scoped(), waitFor: "all" });
		expect(snapshotPulse(late)).toEqual(snapshotPulse(a));
		// Three fields and two counts, not 450 writes.
		expect(meta(late).log.size).toBeLessThan(12);
		expect(meta(a).log.size).toBeLessThan(12);
		for (const pulse of [a, b, late]) {
			assertTiled(pulse);
			destroyPulse(pulse);
		}
	});
});

describe("versioned fields", () => {
	test("every write is kept, with its time when asked", () => {
		const a = create();
		const base = count(a);
		const before = Date.now();
		for (let i = 0; i < 20; i++) {
			a.status = `s${i}`;
			a.price = i;
		}
		expect(count(a)).toBe(base + 40);
		const b = join(a, 65537);
		expect(count(b)).toBe(count(a));
		const decoded = rows(b)
			.filter((row) => !isGapRow(row))
			.map((row) =>
				rowToPatch(row, (schema) => meta(b).model.decodeEncoding(schema)),
			);
		const times = decoded.flatMap((patch) =>
			patch.time === undefined ? [] : [patch.time],
		);
		expect(times.length).toBe(20);
		for (const time of times) {
			expect(time).toBeGreaterThanOrEqual(before);
			expect(time).toBeLessThanOrEqual(Date.now());
		}
		expect(snapshotPulse(b)).toMatchObject({ status: "s19", price: 19 });
	});
});

describe("convergence", () => {
	/** A small deterministic generator, so a failing seed can be replayed. */
	function random(seed: number) {
		let state = seed >>> 0;
		return (below: number) => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state % below;
		};
	}
	const edits: ((pulse: ReturnType<typeof create>, n: number) => void)[] = [
		(pulse, n) => (pulse.title = `title ${n}`),
		(pulse, n) => (pulse.status = `status ${n}`),
		(pulse, n) => (pulse.price = n),
		(pulse) => pulse.likes.increment(),
		(pulse, n) => pulse.likes.decrement(1 + (n % 3)),
		(pulse, n) => (pulse.author.name = `name ${n}`),
		(pulse, n) => (pulse.author.age = n),
		(pulse) => delete pulse.author.age,
		(pulse, n) => (pulse.tags[`k${n % 4}`] = `tag ${n}`),
		(pulse, n) => delete pulse.tags[`k${n % 4}`],
		(pulse, n) => (pulse.size = { width: n, height: n }),
		(pulse, n) => pulse.items.push(`item ${n}`),
		(pulse, n) => (pulse.author = { name: `author ${n}` }),
	];
	for (let seed = 1; seed <= 40; seed++)
		test(`random edits and partial syncs converge (seed ${seed})`, () => {
			const next = random(seed);
			const first = create();
			const peers = [first];
			for (let i = 1; i < 4; i++) peers.push(join(first, 65536 + i));
			for (let step = 0; step < 300; step++) {
				const peer = peers[next(peers.length)]!;
				if (next(3)) edits[next(edits.length)]!(peer, step);
				else {
					const other = peers[next(peers.length)]!;
					if (other !== peer) sync(peer, other);
				}
			}
			for (let round = 0; round < 3; round++)
				for (const source of peers)
					for (const target of peers)
						if (source !== target) sync(source, target);
			const expected = snapshotPulse(first);
			const vector = meta(first).log.vector;
			for (const peer of peers) {
				expect(snapshotPulse(peer)).toEqual(expected);
				expect(meta(peer).log.vector).toEqual(vector);
				expect(meta(peer).log.pendingCount).toBe(0);
				assertTiled(peer);
			}
			// A replica that starts from any of them reaches the same document.
			const late = join(peers[next(peers.length)]!, 70000);
			expect(snapshotPulse(late)).toEqual(expected);
			expect(meta(late).log.vector).toEqual(vector);
			assertTiled(late);
		});
});
