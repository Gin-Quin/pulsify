import { describe, expect, test } from "bun:test";
import { array, object, optional, record } from "@gin-quin/codec";
import {
	counter,
	createPulse,
	createPulseScope,
	definePulse,
	frozen,
	getPulseMeta,
	snapshotPulse,
	versioned,
	type Pulse,
} from "../source/index.js";
import { isGap, type PatchStore } from "../source/storage.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import {
	encodeMessage,
	decodeMessage,
} from "../source/connection/PulseMessage.js";
import type { PulsePatchRow } from "../source/connection/PulsePatch.js";

const Note = definePulse(
	"StoredHistoryNote",
	object({
		title: "string",
		status: versioned("string"),
		likes: counter(),
		author: object({ name: "string", age: optional("uint") }),
		size: frozen(object({ width: "uint", height: "uint" })),
		tags: record("string"),
		items: array("string"),
	}),
).materialize();
type Note = Pulse<any> & {
	title: string;
	status: string;
	likes: { increment(amount?: number): void; decrement(amount?: number): void };
	author: { name: string; age?: number };
	size: { width: number; height: number };
	tags: Record<string, string>;
	items: string[];
};
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
const meta = (pulse: Pulse<any>) => getPulseMeta(pulse);
/** Rows cross the wire codec, as they do between a client and a store. */
function wire(rows: PulsePatchRow[]): PulsePatchRow[] {
	if (!rows.length) return rows;
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
	return message.rows;
}
const create = (sessionId = 65536): Note =>
	createPulse(
		Note,
		{
			id: crypto.randomUUID(),
			title: "Draft",
			status: "open",
			likes: 0,
			author: { name: "Ada" },
			size: { width: 1, height: 1 },
			tags: {},
			items: [],
		},
		options(sessionId),
	) as Note;
const empty = (docId: string, sessionId: number): Note =>
	createRuntime(Note, docId, options(sessionId)) as Note;

/**
 * What every store owes to fields without history: it keeps their last value
 * only, and any peer still reaches the same document through it.
 */
export function lastValueStoreConformance(
	name: string,
	open: () => Promise<PatchStore>,
): void {
	const push = async (store: PatchStore, pulse: Pulse<any>) => {
		const rows = meta(pulse).log.missing(await store.vector(meta(pulse).id));
		if (rows.length) await store.append(wire(rows));
	};
	const pull = async (store: PatchStore, pulse: Pulse<any>) => {
		// A pulse that is not loaded yet only knows its ID through its metadata.
		const rows = await store.missing(meta(pulse).id, meta(pulse).log.vector);
		if (rows.length) meta(pulse).applyRows(wire(rows));
	};
	/**
	 * The rows a store holds. A gap row stands for writes it no longer holds,
	 * where an actor's first writes were replaced: it is not counted.
	 */
	const stored = async (store: PatchStore, docId: string) =>
		(await store.missing(docId, [])).filter((row) => !isGap(row.operations))
			.length;
	/** The stored rows cover every sequence number of every actor exactly once. */
	const assertTiled = async (store: PatchStore, docId: string) => {
		const next = new Map<number, number>();
		for (const row of await store.missing(docId, [])) {
			expect(row.clock).toBe(next.get(row.sid) ?? 1);
			next.set(row.sid, row.clock + row.span);
		}
		expect([...next].sort((a, b) => a[0] - b[0])).toEqual(
			await store.vector(docId),
		);
	};
	const load = async (store: PatchStore, docId: string, sessionId = 70000) => {
		const pulse = empty(docId, sessionId);
		await pull(store, pulse);
		return pulse;
	};

	describe(`${name}: fields without history`, () => {
		test("a field rewritten online keeps one stored row", async () => {
			const store = await open(),
				a = create();
			await push(store, a);
			const base = await stored(store, a.id);
			for (let i = 0; i < 120; i++) {
				a.title = `Title ${i}`;
				a.likes.increment();
				a.author.age = i;
				a.tags["x"] = `tag ${i}`;
				a.size = { width: i, height: i };
				await push(store, a);
			}
			expect(await stored(store, a.id)).toBe(base + 5);
			await assertTiled(store, a.id);
			expect(snapshotPulse(await load(store, a.id))).toEqual(snapshotPulse(a));
		});

		test("writes made offline arrive as one row that covers the others", async () => {
			const store = await open(),
				a = create();
			await push(store, a);
			a.title = "online";
			await push(store, a);
			const base = await stored(store, a.id);
			for (let round = 0; round < 5; round++) {
				for (let i = 0; i < 30; i++) {
					a.title = `offline ${round}.${i}`;
					a.items.push(`${round}.${i}`);
				}
				await push(store, a);
				// Sent twice, nothing changes.
				await store.append(wire(meta(a).log.missing([])));
			}
			// The title is still one row; the sequence kept every insertion.
			expect(await stored(store, a.id)).toBe(base + 150);
			await assertTiled(store, a.id);
			expect(await store.vector(a.id)).toEqual(meta(a).log.vector);
			expect(snapshotPulse(await load(store, a.id))).toEqual(snapshotPulse(a));
		});

		// A store keeps each actor's newest write to a register, and never
		// compares it with another actor's: every replica picks the winner
		// itself. So the bound is one row per actor and register.
		test("two writers taking turns leave one row per writer and field", async () => {
			const store = await open(),
				a = create();
			await push(store, a);
			const b = await load(store, a.id, 65537);
			for (let i = 0; i < 60; i++) {
				const writer = i % 2 ? a : b;
				await pull(store, writer);
				writer.title = `turn ${i}`;
				writer.likes.increment();
				await push(store, writer);
			}
			await pull(store, a);
			await pull(store, b);
			expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
			// The title and one count per writer, on top of the creation.
			expect(await stored(store, a.id)).toBe(1 + 2 * 2);
			await assertTiled(store, a.id);
			expect(snapshotPulse(await load(store, a.id))).toEqual(snapshotPulse(a));
		});

		test("concurrent writers converge, and the store keeps each one's last write", async () => {
			const store = await open(),
				a = create();
			await push(store, a);
			const b = await load(store, a.id, 65537);
			for (let i = 0; i < 20; i++) {
				a.title = `a${i}`;
				b.title = `b${i}`;
				// Uploads cross: each side learns the other's write afterwards.
				await push(store, i % 2 ? a : b);
				await push(store, i % 2 ? b : a);
				await pull(store, a);
				await pull(store, b);
				expect(a.title).toBe(b.title);
			}
			expect(await stored(store, a.id)).toBe(1 + 2);
			await assertTiled(store, a.id);
			expect((await load(store, a.id)).title).toBe(a.title);
		});

		test("several writers of one field leave one row each, and a reader picks the winner", async () => {
			const store = await open(),
				a = create();
			await push(store, a);
			const writers = [a];
			for (let i = 1; i < 5; i++)
				writers.push(await load(store, a.id, 65536 + i));
			for (let round = 0; round < 10; round++) {
				// Every writer writes before any of them hears of the others.
				writers.forEach((writer, i) => (writer.title = `${i} ${round}`));
				for (const writer of writers.toReversed()) await push(store, writer);
				for (const writer of writers) await pull(store, writer);
			}
			const title = a.title;
			for (const writer of writers) expect(writer.title).toBe(title);
			expect(await stored(store, a.id)).toBe(1 + writers.length);
			await assertTiled(store, a.id);
			const fresh = await load(store, a.id);
			expect(fresh.title).toBe(title);
			expect(snapshotPulse(fresh)).toEqual(snapshotPulse(a));
		});

		test("versioned fields and sequences keep every write", async () => {
			const store = await open(),
				a = create();
			await push(store, a);
			const base = await stored(store, a.id);
			for (let i = 0; i < 25; i++) {
				a.status = `status ${i}`;
				a.items.push(`${i}`);
				await push(store, a);
			}
			expect(await stored(store, a.id)).toBe(base + 50);
		});

		for (let seed = 1; seed <= 12; seed++)
			test(`random edits through the store converge (seed ${seed})`, async () => {
				let state = seed * 2654435761;
				const next = (below: number) => {
					state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
					return state % below;
				};
				const edits: ((pulse: Note, n: number) => void)[] = [
					(pulse, n) => (pulse.title = `title ${n}`),
					(pulse, n) => (pulse.status = `status ${n}`),
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
				const store = await open(),
					first = create();
				await push(store, first);
				const peers = [first];
				for (let i = 1; i < 4; i++)
					peers.push(await load(store, first.id, 65536 + i));
				for (let step = 0; step < 250; step++) {
					const peer = peers[next(peers.length)]!;
					const action = next(4);
					if (action < 2) edits[next(edits.length)]!(peer, step);
					else if (action === 2) await push(store, peer);
					else await pull(store, peer);
				}
				for (let round = 0; round < 2; round++)
					for (const peer of peers) {
						await push(store, peer);
						await pull(store, peer);
					}
				for (const peer of peers) await pull(store, peer);
				const expected = snapshotPulse(first);
				const vector = await store.vector(first.id);
				for (const peer of peers) {
					expect(snapshotPulse(peer)).toEqual(expected);
					expect(meta(peer).log.vector).toEqual(vector);
					expect(meta(peer).log.pendingCount).toBe(0);
				}
				await assertTiled(store, first.id);
				const late = await load(store, first.id);
				expect(snapshotPulse(late)).toEqual(expected);
				expect(meta(late).log.vector).toEqual(vector);
			});
	});
}
