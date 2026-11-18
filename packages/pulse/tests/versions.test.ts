import { describe, expect, test } from "bun:test";
import { array, object, optional, record } from "@gin-quin/codec";
import {
	connectPulse,
	counter,
	createMemoryConnector,
	loadPulse,
	PulseRelay,
	recoverPulseHistory,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseHistory,
	getPulseMeta,
	getPulseVersions,
	openPulseSnapshot,
	restorePulse,
	richText,
	snapshotPulse,
	versioned,
	type Pulse,
} from "../source/index.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { CorePatch } from "../source/core/operations.js";
import { patchToRow } from "../source/connection/PulsePatch.js";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage.js";

const Invoice = definePulse(
	"VersionedInvoice",
	versioned(
		object({
			title: "string",
			total: "float64",
			note: optional("string"),
			author: object({ name: "string" }),
			lines: array("string"),
			body: richText(),
			views: counter(),
		}),
		{ timestamps: true },
	),
).materialize();
const Plain = definePulse(
	"PlainNote",
	object({
		title: "string",
		status: versioned("string"),
		body: richText(),
		tags: array("string"),
	}),
).materialize();

const Keyed = definePulse(
	"VersionedKeys",
	versioned(
		object({
			byName: record(object({ note: "string", tags: array("string") })),
			labels: record("string"),
		}),
	),
).materialize();

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
}
const meta = (pulse: Pulse<any>) => getPulseMeta(pulse);
const rows = (pulse: Pulse<any>) => meta(pulse).log.missing([]);
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
const invoice = (sessionId = 65536, id: string = crypto.randomUUID()) =>
	createPulse(
		Invoice,
		{
			id,
			title: "Draft",
			total: 1,
			author: { name: "Ada" },
			lines: ["one"],
			body: "Hello",
			views: 0,
		},
		options(sessionId),
	);
/** A second replica of a document, holding what the first one has. */
function replicaOf<P extends Pulse<any>>(
	source: P,
	definition: any,
	sessionId: number,
): P {
	const pulse = openReplica(definition, source.id, sessionId) as P;
	sync(source, pulse);
	return pulse;
}
function openReplica(definition: any, id: string, sessionId: number) {
	// A runtime without data: what `loadPulse` creates before it downloads.
	const { createRuntime } =
		require("../source/pulses/PulseRuntime.js") as typeof import("../source/pulses/PulseRuntime.js");
	return createRuntime(definition, id, options(sessionId));
}

describe("history", () => {
	test("lists the versions of a document and the writes of a field", () => {
		const created = Date.now();
		const doc = invoice();
		const before = Date.now();
		doc.total = 2;
		doc.title = "Sent";
		doc.total = 3;
		const versions = getPulseHistory(doc);
		expect(versions).toHaveLength(4);
		expect(versions.map((version) => version.actor)).toEqual(
			Array(4).fill(65536),
		);
		expect(versions.at(-1)!.version).toEqual(getPulseVersions(doc).state);
		// Every transaction of a timed document has a time, the creation too.
		for (const version of versions)
			expect(version.time).toBeGreaterThanOrEqual(created);
		expect(versions[1]!.time).toBeGreaterThanOrEqual(before);

		const totals = getPulseHistory(doc, "total");
		expect(totals.map((entry) => entry.value)).toEqual([1, 2, 3]);
		expect(totals[2]!.version).toEqual(versions[3]!.version);
		expect(
			getPulseHistory(doc, ["author", "name"]).map((entry) => entry.value),
		).toEqual(["Ada"]);

		// Bounds: a version excludes what it includes, a date compares times.
		expect(
			getPulseHistory(doc, "total", { since: versions[1]!.version }).map(
				(entry) => entry.value,
			),
		).toEqual([3]);
		expect(getPulseHistory(doc, { until: versions[1]!.version })).toHaveLength(
			2,
		);
		expect(
			getPulseHistory(doc, { since: new Date(before) }).length,
		).toBeGreaterThanOrEqual(3);
		expect(getPulseHistory(doc, { until: new Date(created - 1) })).toEqual([]);
		expect(
			getPulseHistory(doc, { since: new Date(Date.now() + 60_000) }),
		).toEqual([]);
	});

	test("follows a text, a counter and a deleted field", () => {
		const doc = invoice();
		doc.body.insert(5, "!");
		doc.views.increment(2);
		doc.note = "late";
		delete doc.note;
		expect(getPulseHistory(doc, "body").map((entry) => entry.value)).toEqual([
			"Hello",
			"Hello!",
		]);
		expect(getPulseHistory(doc, "views").map((entry) => entry.value)).toEqual([
			0, 2,
		]);
		expect(getPulseHistory(doc, "note").map((entry) => entry.value)).toEqual([
			"late",
			undefined,
		]);
	});

	test("refuses a field that keeps its last value only", () => {
		const note = createPulse(
			Plain,
			{ title: "a", status: "open", body: "", tags: [] },
			options(65536),
		);
		note.status = "done";
		expect(getPulseHistory(note, "status").map((entry) => entry.value)).toEqual(
			["open", "done"],
		);
		expect(() => getPulseHistory(note, "title")).toThrow(/versioned\(\)/);
		expect(() =>
			snapshotPulse(note, { at: getPulseVersions(note).state }),
		).toThrow(/versioned\(\)/);
	});

	test("orders concurrent writes the same way on every replica", () => {
		const a = invoice(65536);
		const b = replicaOf(a, Invoice, 65537);
		a.total = 10;
		b.total = 20;
		b.title = "B";
		sync(a, b);
		sync(b, a);
		const fromA = getPulseHistory(a, "total");
		expect(fromA).toEqual(getPulseHistory(b, "total"));
		expect(fromA.map((entry) => entry.value)).toEqual([1, 10, 20]);
		expect(getPulseHistory(a)).toEqual(getPulseHistory(b));
	});
});

describe("past versions", () => {
	test("reads the document at a version and at a date", async () => {
		const doc = invoice();
		doc.total = 2;
		doc.lines.push("two");
		doc.body.insert(5, " world");
		await new Promise((resolve) => setTimeout(resolve, 5));
		const middle = new Date();
		await new Promise((resolve) => setTimeout(resolve, 5));
		doc.total = 3;
		doc.author.name = "Grace";
		const versions = getPulseHistory(doc);

		const first = snapshotPulse(doc, { at: versions[0]!.version });
		expect(first).toMatchObject({
			title: "Draft",
			total: 1,
			lines: ["one"],
			body: "Hello",
			author: { name: "Ada" },
		});
		const dated = snapshotPulse(doc, { at: middle });
		expect(dated).toMatchObject({
			total: 2,
			lines: ["one", "two"],
			body: "Hello world",
			author: { name: "Ada" },
		});
		expect(snapshotPulse(doc, { at: versions.at(-1)!.version })).toEqual(
			snapshotPulse(doc),
		);
		// The live document is untouched.
		expect(doc.total).toBe(3);
		expect(() => snapshotPulse(doc, { at: new Date(0) })).toThrow(/that old/);
		expect(() => snapshotPulse(doc, { at: [[65536, 99]] })).toThrow(
			/not received/,
		);
	});
});

describe("restore", () => {
	test("brings a version back as a new generation, and can be undone", () => {
		const doc = invoice();
		const start = getPulseVersions(doc).state;
		doc.total = 2;
		doc.lines.push("two");
		doc.body.insert(5, " world");
		doc.views.increment(3);
		const edited = getPulseVersions(doc).state;
		const lines = doc.lines;

		restorePulse(doc, start);
		expect(doc.generation).toBe(1);
		expect(snapshotPulse(doc)).toMatchObject({
			total: 1,
			lines: ["one"],
			body: "Hello",
			views: 0,
		});
		expect(() => lines.length).toThrow(/replaced or removed/);
		// The restored document is edited like any other.
		doc.lines.push("again");
		doc.views.increment();
		expect([...doc.lines]).toEqual(["one", "again"]);
		expect(doc.views.value).toBe(1);

		restorePulse(doc, edited);
		expect(doc.generation).toBe(2);
		expect(snapshotPulse(doc)).toMatchObject({
			total: 2,
			lines: ["one", "two"],
			body: "Hello world",
			views: 3,
		});
		expect(getPulseHistory(doc, "total").map((entry) => entry.value)).toEqual([
			1, 2, 1, 2,
		]);
	});

	test("discards the edits another replica made to the previous generation", () => {
		for (const restoreFirst of [true, false]) {
			const a = invoice(65536);
			const b = replicaOf(a, Invoice, 65537);
			const start = getPulseVersions(a).state;
			a.total = 2;
			sync(a, b);
			// B edits without the restore, and with a later Lamport clock.
			restorePulse(a, start);
			b.total = 50;
			b.title = "B";
			b.lines.push("b");
			b.body.insert(0, "B: ");
			b.total = 51;
			if (restoreFirst) {
				sync(a, b);
				sync(b, a);
			} else {
				sync(b, a);
				sync(a, b);
			}
			for (const pulse of [a, b]) {
				expect(pulse.generation).toBe(1);
				expect(snapshotPulse(pulse)).toMatchObject({
					title: "Draft",
					total: 1,
					lines: ["one"],
					body: "Hello",
				});
			}
			expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
			// B writes on the generation it now has.
			b.total = 7;
			sync(b, a);
			expect(a.total).toBe(7);
		}
	});

	test("keeps one of two concurrent restores on every replica", () => {
		const a = invoice(65536);
		const start = getPulseVersions(a).state;
		a.total = 2;
		const second = getPulseVersions(a).state;
		a.total = 3;
		const b = replicaOf(a, Invoice, 65537);
		restorePulse(a, start);
		restorePulse(b, second);
		sync(a, b);
		sync(b, a);
		expect(a.generation).toBe(1);
		expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
		// A second restore on one side wins over a first one on the other.
		const c = replicaOf(a, Invoice, 65538);
		restorePulse(c, start);
		restorePulse(a, second);
		restorePulse(a, start);
		sync(a, c);
		sync(c, a);
		expect(c.generation).toBe(3);
		expect(snapshotPulse(a)).toEqual(snapshotPulse(c));
	});

	test("keeps the formatting of a rich text, on every replica", () => {
		const a = invoice(65536);
		a.body.format(0, 2, { bold: true });
		a.body.insert(5, " world", { italic: true });
		a.body.format(1, 3, { color: "red" });
		const delta = a.body.toDelta();
		const formatted = getPulseVersions(a).state;
		a.body.delete(0, 8);
		a.body.format(0, 1, { bold: true });
		const b = replicaOf(a, Invoice, 65537);

		restorePulse(a, formatted);
		expect(a.body.toDelta()).toEqual(delta);
		sync(a, b);
		expect(b.body.toDelta()).toEqual(delta);
		expect(b.body.toString()).toBe("Hello world");
		b.body.insert(11, "!", { bold: true });
		sync(b, a);
		expect(a.body.toString()).toBe("Hello world!");
	});

	test("names the version instead of sending the content", () => {
		const a = invoice(65536);
		const size = 60_000;
		a.body.insert(5, "x".repeat(size));
		// Alternating attributes: no run of two characters shares them.
		for (let index = 0; index < 400; index += 2)
			a.body.format(index, 1, { bold: true });
		a.body.format(0, size, { parent: "p1" });
		// More than a transaction holds.
		a.title = "t".repeat(700 * 1024);
		a.note = "n".repeat(700 * 1024);
		const delta = a.body.toDelta();
		const formatted = getPulseVersions(a).state;
		a.body.delete(0, size);
		a.title = "short";
		const before = getPulseHistory(a).length;
		restorePulse(a, formatted);
		// One transaction of a few bytes, whatever the document holds.
		expect(getPulseHistory(a)).toHaveLength(before + 1);
		expect(rows(a).at(-1)!.operations.length).toBeLessThan(64);
		expect(a.body.toDelta()).toEqual(delta);
		expect(a.title).toHaveLength(700 * 1024);
		// A replica that receives everything at once, and one that follows.
		const b = replicaOf(a, Invoice, 65537);
		expect(b.body.toDelta()).toEqual(delta);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		restorePulse(a, getPulseHistory(a)[0]!.version);
		a.lines.push("after");
		sync(a, b);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect([...b.lines]).toEqual(["one", "after"]);
	});

	test("builds the same nodes on replicas that hold keys in another order", () => {
		const a = createPulse(Keyed, { byName: {}, labels: {} }, options(65536));
		const b = replicaOf(a, Keyed, 65537);
		// Concurrent keys: each replica inserts its own first.
		a.byName["zed"] = { note: "z", tags: ["z"] };
		a.labels["b"] = "B";
		b.byName["amy"] = { note: "a", tags: ["a"] };
		b.labels["a"] = "A";
		sync(a, b);
		sync(b, a);
		expect(Object.keys(a.byName)).not.toEqual(Object.keys(b.byName));
		const version = getPulseVersions(a).state;
		a.byName["zed"]!.note = "changed";
		sync(a, b);
		restorePulse(b, version);
		sync(b, a);
		// Edits to what the restore built reach the same nodes on both.
		a.byName["amy"]!.tags.push("from a");
		a.byName["zed"]!.note = "from a";
		b.byName["zed"]!.tags.push("from b");
		b.byName["amy"]!.note = "from b";
		sync(a, b);
		sync(b, a);
		expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
		expect(snapshotPulse(a).byName).toEqual({
			amy: { note: "from b", tags: ["a", "from a"] },
			zed: { note: "from a", tags: ["z", "from b"] },
		});
	});

	test("restores a version that holds restores, and the one before them", () => {
		const a = invoice(65536);
		const first = getPulseVersions(a).state;
		a.total = 2;
		const second = getPulseVersions(a).state;
		restorePulse(a, first);
		a.total = 3;
		const third = getPulseVersions(a).state;
		restorePulse(a, second);
		a.total = 4;
		restorePulse(a, third);
		expect(a.total).toBe(3);
		expect(a.generation).toBe(3);
		a.lines.push("x");
		// A replica replays every restore from its own journal.
		const b = replicaOf(a, Invoice, 65537);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect(getPulseHistory(b, "total").map((entry) => entry.value)).toEqual([
			1, 2, 1, 3, 2, 4, 3,
		]);
		b.lines.push("y");
		sync(b, a);
		expect([...a.lines]).toEqual(["one", "x", "y"]);
	});

	test("refuses a restore that names a version its writer did not have", () => {
		const a = invoice(65536);
		const b = replicaOf(a, Invoice, 65537);
		// A row no replica writes: the version is ahead of its dependencies.
		const forged = (version: [number, number][], generation = 1) =>
			patchToRow(
				a.id,
				new CorePatch(65536, 2, 9, meta(a).model.schemaId, [
					{ kind: 10, version, generation },
				]),
				[[65536, 2]],
				meta(a).model.encoding,
			);
		expect(() => meta(b).applyRows([forged([[65536, 3]])])).toThrow(
			/version its writer had/,
		);
		expect(() => meta(b).applyRows([forged([[70000, 4]])])).toThrow(
			/version its writer had/,
		);
		expect(() => meta(b).applyRows([forged([[65536, 2]], 0)])).toThrow(
			/version its writer had/,
		);
		expect(b.generation).toBe(0);
		expect(rows(b)).toHaveLength(1);
		// The same row with a version it had is a restore like another.
		meta(b).applyRows([forged([[65536, 2]])]);
		expect(b.generation).toBe(1);
	});

	test("sends the content where a write replaced another", () => {
		// Kept as last values first, then versioned by a migration.
		const plain = object({ title: "string", body: richText() });
		const kept = versioned(object({ title: "string", body: richText() }));
		const Old = definePulse("LateVersioned", plain).materialize();
		const New = definePulse("LateVersioned", plain)
			.migrateTo(kept, () => ({}))
			.materialize();
		const id = crypto.randomUUID();
		const old = createPulse(
			Old,
			{ id, title: "a", body: "Hi" },
			options(65536),
		);
		old.title = "b";
		old.title = "c";
		const a = openReplica(New, id, 65537) as any;
		sync(old, a);
		a.body.format(0, 2, { bold: true });
		a.title = "d";
		const version = getPulseVersions(a).state;
		a.title = "e";
		a.body.insert(2, "!");
		const before = rows(a).length;
		restorePulse(a, version);
		expect(snapshotPulse(a)).toMatchObject({ title: "d", body: "Hi" });
		// The root travels: the journal dropped writes below that version.
		expect(rows(a).length).toBe(before + 1);
		expect(rows(a).at(-1)!.operations.length).toBeGreaterThan(64);
		const b = openReplica(New, id, 65538) as any;
		sync(a, b);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect(b.body.toDelta()).toEqual([
			{ insert: "Hi", attributes: { bold: true } },
		]);
	});
});

describe("a replica without the history", () => {
	test("fetches it when a restore arrives, and when it loads one", async () => {
		const relay = new PulseRelay();
		const connected = (sessionId: number) => ({
			scope: createPulseScope(),
			connectors: [createMemoryConnector(relay)],
			sessionId,
		});
		// Without times, a run of writes to one field is condensed.
		const Kept = definePulse(
			"KeptTitle",
			versioned(object({ title: "string", total: "float64" })),
		).materialize();
		const a = createPulse(Kept, { title: "Draft", total: 0 }, connected(65536));
		await connectPulse(a).synced;
		// A long run of writes: the relay sends a late replica its last value.
		for (let i = 0; i < 100; i++) a.title = `title ${i}`;
		const middle = getPulseHistory(a, "title")[50]!.version;
		await connectPulse(a).synced;
		const b = await loadPulse(Kept, a.id, connected(65537));
		const held = getPulseVersions(b);
		expect(held.history).not.toEqual(held.state);

		restorePulse(a, middle);
		a.total = 5;
		await connectPulse(a).synced;
		// Asking for the history as well does not hold the recovery up.
		await recoverPulseHistory(b).catch(() => {});
		await until(() => b.generation === 1);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect(b.title).toBe("title 49");
		expect(getPulseVersions(b).history).toEqual(getPulseVersions(b).state);
		b.total = 6;
		await connectPulse(b).synced;
		await until(() => a.total === 6);

		// A load is not over while the restore it brought waits for history.
		const c = await loadPulse(Kept, a.id, connected(65538));
		expect(c.generation).toBe(1);
		expect(snapshotPulse(c)).toEqual(snapshotPulse(a));
		for (const pulse of [a, b, c]) destroyPulse(pulse);
	});
});

describe("what a receiver accepts", () => {
	test("a text the schema has retired does not come back, and loads everywhere", () => {
		const v1 = versioned(object({ title: "string", body: richText() }));
		const v2 = versioned(object({ title: "string" }));
		const Old = definePulse("RetiredText", v1).materialize();
		const New = definePulse("RetiredText", v1)
			.migrateTo(v2, () => ({}))
			.materialize();
		const id = crypto.randomUUID();
		const old = createPulse(
			Old,
			{ id, title: "a", body: "Hi" },
			options(65536),
		);
		old.body.format(0, 2, { bold: true });
		const a = openReplica(New, id, 65537) as any;
		sync(old, a);
		a.title = "b";
		const version = getPulseVersions(a).state;
		a.title = "c";
		restorePulse(a, version);
		expect(snapshotPulse(a)).toMatchObject({ title: "b", generation: 1 });
		const fresh = openReplica(New, id, 65538) as any;
		sync(a, fresh);
		expect(snapshotPulse(fresh)).toEqual(snapshotPulse(a));
	});

	test("a restore no receiver would accept is not written", () => {
		const a = invoice(65536);
		const b = replicaOf(a, Invoice, 65537);
		// Two valid counts whose total no single count can hold.
		a.views.increment(Number.MAX_SAFE_INTEGER);
		b.views.increment(1);
		sync(a, b);
		sync(b, a);
		const version = getPulseVersions(a).state;
		a.title = "later";
		const before = rows(a).length;
		expect(() => restorePulse(a, version)).toThrow();
		expect(rows(a)).toHaveLength(before);
		expect(a.generation).toBe(0);
		const fresh = replicaOf(a, Invoice, 65538);
		expect(snapshotPulse(fresh)).toEqual(snapshotPulse(a));
	});

	test("a row that waited in the journal is counted once", () => {
		const a = invoice(65536);
		a.total = 2;
		const version = getPulseVersions(a).state;
		a.total = 3;
		restorePulse(a, version);
		const [first, second, third, restore] = rows(a);
		const b = openReplica(Invoice, a.id, 65537) as any;
		meta(b).applyRows([second!]);
		expect(meta(b).loaded).toBe(false);
		meta(b).applyRows([first!, third!, restore!]);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect(b.total).toBe(2);
	});

	test("the anchors of one editor node keep the parent that won", () => {
		const a = invoice(65536);
		a.body.insert(5, "x");
		const [, , , , , x] = meta(a).model.root!.child("body")!.visible;
		const [first, second] = meta(a).model.root!.child("body")!.visible;
		const body = meta(a).model.root!.child("body")!.id;
		const mark = (entry: string, attributes: Record<string, unknown>) =>
			meta(a).mutate([{ kind: 5, target: body, entries: [entry], attributes }]);
		// Two anchors of node "n": the later one attaches it to the root.
		mark(first!.id, {
			"$pulsify:pm:node": "n",
			"$pulsify:pm:parent": "missing",
		});
		mark(second!.id, { "$pulsify:pm:node": "n", "$pulsify:pm:parent": "" });
		for (const entry of meta(a).model.root!.child("body")!.visible.slice(2))
			mark(entry.id, { "$pulsify:pm:parent": entry === x ? "n" : "gone" });
		expect(a.body.toString()).toBe("x");
		const version = getPulseVersions(a).state;
		a.body.insert(1, "y");
		restorePulse(a, version);
		expect(a.body.toString()).toBe("x");
		const b = replicaOf(a, Invoice, 65537);
		expect(b.body.toString()).toBe("x");
	});

	test("a deleted anchor still says where its node went", () => {
		// Two blocks joined by an editor: the anchor of the second one is
		// redirected to the first, then deleted. Its text stays visible.
		const join = (pulse: Pulse<any>) => {
			const text = meta(pulse).model.root!.child("body")!;
			const [first, second, x, ...others] = text.visible;
			const mark = (entry: string, attributes: Record<string, unknown>) =>
				meta(pulse).mutate([
					{ kind: 5, target: text.id, entries: [entry], attributes },
				]);
			mark(first!.id, { "$pulsify:pm:node": "a", "$pulsify:pm:parent": "" });
			mark(second!.id, { "$pulsify:pm:node": "b", "$pulsify:pm:parent": "" });
			mark(x!.id, { "$pulsify:pm:parent": "b" });
			for (const entry of others)
				mark(entry.id, { "$pulsify:pm:parent": "gone" });
			mark(second!.id, { "$pulsify:pm:redirect": "a" });
			meta(pulse).mutate([
				{
					kind: 3,
					target: text.id,
					after: "",
					deletes: [second!.id],
					values: [],
				},
			]);
		};
		// By version.
		const a = invoice(65536);
		join(a);
		expect(a.body.toString()).toBe("l");
		const version = getPulseVersions(a).state;
		a.body.insert(1, "y");
		restorePulse(a, version);
		expect(a.body.toString()).toBe("l");
		expect(replicaOf(a, Invoice, 65537).body.toString()).toBe("l");
		// By content: a write replaced another, so the snapshot travels.
		const note = createPulse(
			Plain,
			{ title: "a", status: "open", body: "Hello", tags: [] },
			options(65536),
		);
		join(note);
		note.title = "b";
		note.title = "c";
		const saved = openPulseSnapshot(
			Plain,
			note.id,
			exportPulseUpdates(note, []),
		);
		note.body.insert(1, "y");
		restorePulse(note, saved);
		expect(note.body.toString()).toBe("l");
		expect(replicaOf(note, Plain, 65537).body.toString()).toBe("l");
	});

	test("rows that wait for others are no part of the history", () => {
		const a = invoice(65536);
		const b = replicaOf(a, Invoice, 65537);
		b.lines.push("x");
		b.lines.push("y");
		const c = replicaOf(a, Invoice, 65538);
		const [, , second] = rows(b);
		meta(c).applyRows([second!]);
		expect(getPulseHistory(c)).toHaveLength(1);
		expect(getPulseHistory(c).at(-1)!.version).toEqual(
			getPulseVersions(c).state,
		);
		expect(getPulseHistory(c, "lines").map((entry) => entry.value)).toEqual([
			["one"],
		]);
	});

	test("a restore keeps the version it was given, not the caller's array", () => {
		const a = invoice(65536);
		a.total = 2;
		const version = getPulseVersions(a).state;
		a.total = 3;
		restorePulse(a, version);
		version[0]![1] = 2;
		const b = replicaOf(a, Invoice, 65537);
		expect(a.total).toBe(2);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
	});

	test("an edit to a value that was replaced is no change of its field", () => {
		const a = createPulse(
			Keyed,
			{ byName: { zed: { note: "z", tags: [] } }, labels: {} },
			options(65536),
		);
		const b = replicaOf(a, Keyed, 65537);
		a.byName["zed"] = { note: "new", tags: [] };
		b.byName["zed"]!.note = "to the old one";
		sync(a, b);
		sync(b, a);
		expect(getPulseHistory(a, "byName").map((entry) => entry.value)).toEqual([
			{ zed: { note: "z", tags: [] } },
			{ zed: { note: "new", tags: [] } },
		]);
	});

	test("attributes that only differ by type stay apart", () => {
		for (const way of ["version", "content"] as const) {
			const a = invoice(65536);
			a.body.format(0, 1, { x: new Uint8Array([1]) });
			a.body.format(1, 1, { x: { "0": 1 } });
			a.body.format(2, 1, { y: 1n });
			const delta = a.body.toDelta();
			const version = getPulseVersions(a).state;
			a.body.delete(0, 3);
			if (way === "version") restorePulse(a, version);
			else {
				const {
					id,
					kind,
					version: _v,
					generation,
					...data
				} = snapshotPulse(a, { at: version }) as any;
				const other = createPulse(Invoice, data, options(65999));
				(other as any).body.format(0, 1, { x: new Uint8Array([1]) });
				(other as any).body.format(1, 1, { x: { "0": 1 } });
				(other as any).body.format(2, 1, { y: 1n });
				restorePulse(a, other as any);
			}
			expect(a.body.toDelta()).toEqual(delta);
			const b = replicaOf(a, Invoice, 65537);
			expect(b.body.toDelta()).toEqual(delta);
		}
	});

	test("a range cannot write more marks than a transaction may", () => {
		const a = invoice(65536);
		a.body.insert(5, "x".repeat(2000));
		const b = replicaOf(a, Invoice, 65537);
		const text = meta(a).model.root!.child("body")!;
		const attributes = Object.fromEntries(
			Array.from({ length: 3000 }, (_, index) => [`k${index}`, 1]),
		);
		const forged = patchToRow(
			a.id,
			new CorePatch(65536, 3, 9, meta(a).model.schemaId, [
				{
					kind: 5,
					target: text.id,
					entries: [text.visible[5]!.id],
					count: 2000,
					attributes,
				},
			]),
			[[65536, 3]],
			meta(a).model.encoding,
		);
		expect(forged.operations.length).toBeLessThan(64 * 1024);
		expect(() => meta(b).applyRows([forged])).toThrow(/entry range/);
	});

	test("the history of an object or an array follows what is inside it", () => {
		const doc = invoice();
		doc.lines.push("two");
		doc.author.name = "Grace";
		doc.total = 2;
		expect(getPulseHistory(doc, "lines").map((entry) => entry.value)).toEqual([
			["one"],
			["one", "two"],
		]);
		expect(getPulseHistory(doc, "author").map((entry) => entry.value)).toEqual([
			{ name: "Ada" },
			{ name: "Grace" },
		]);
	});

	test("a snapshot opens the same whatever its frames", () => {
		const v1 = object({ name: "string" });
		const v2 = object({ name: "string", title: "string" });
		const Old = definePulse("FramedNote", v1).materialize();
		const New = definePulse("FramedNote", v1)
			.migrateTo(v2, (data) => ({ title: data.name.toUpperCase() }))
			.materialize();
		const old = createPulse(Old, { name: "initial" }, options(65536));
		const first = exportPulseUpdates(old, []);
		const before = getPulseVersions(old).state;
		// A versioned write would do too: any row after the creation.
		(old as any).name = "changed";
		const whole = exportPulseUpdates(old, []);
		const second = exportPulseUpdates(old, before);
		const one = openPulseSnapshot(New, old.id, whole);
		const two = openPulseSnapshot(New, old.id, [...first, ...second]);
		expect(snapshotPulse(two).title).toBe("CHANGED");
		expect(snapshotPulse(two)).toMatchObject({
			name: snapshotPulse(one).name,
			title: snapshotPulse(one).title,
		});
	});
});

describe("restores made apart", () => {
	/** How each of two offline replicas restores: by version, or from a snapshot. */
	const ways = {
		version: (pulse: Pulse<any>, version: any) => restorePulse(pulse, version),
		content: (pulse: Pulse<any>, version: any) => {
			// A pulse of another document is no version of this journal: the
			// content has to travel.
			const {
				id: _id,
				kind: _kind,
				version: _version,
				generation: _generation,
				...data
			} = snapshotPulse(pulse, { at: version }) as any;
			const other = createPulse(Invoice, data, options(65999));
			restorePulse(pulse, other as any);
			destroyPulse(other);
		},
	};
	for (const [left, right] of [
		["version", "version"],
		["content", "content"],
		["version", "content"],
		["content", "version"],
	] as const)
		test(`${left} and ${right}: one wins with its edits, on both sides`, () => {
			for (const first of ["a", "b"]) {
				const a = invoice(65536);
				const start = getPulseVersions(a).state;
				a.total = 2;
				a.lines.push("two");
				const second = getPulseVersions(a).state;
				a.total = 3;
				const b = replicaOf(a, Invoice, 65537);

				// Offline: each restores a version, then keeps editing.
				ways[left](a, start);
				a.total = 10;
				a.lines.push("from a");
				a.body.insert(5, " (a)");
				ways[right](b, second);
				b.total = 20;
				b.lines.push("from b");
				b.body.insert(5, " (b)");
				b.title = "B";

				if (first === "a") {
					sync(a, b);
					sync(b, a);
				} else {
					sync(b, a);
					sync(a, b);
				}
				// Same generation: the later stamp wins, with what followed it.
				expect(a.generation).toBe(1);
				expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
				expect(snapshotPulse(a)).toMatchObject({
					title: "B",
					total: 20,
					lines: ["one", "two", "from b"],
					body: "Hello (b)",
				});
				// The one that lost writes on the document that won.
				a.lines.push("a again");
				a.total = 30;
				sync(a, b);
				expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
				expect([...b.lines]).toEqual(["one", "two", "from b", "a again"]);
				expect(b.total).toBe(30);
				// A third replica that receives everything at once agrees.
				const c = replicaOf(a, Invoice, 65538);
				expect(snapshotPulse(c)).toEqual(snapshotPulse(a));
			}
		});

	test("a restore of a later generation wins, whatever the clocks", () => {
		const a = invoice(65536);
		const start = getPulseVersions(a).state;
		a.total = 2;
		const b = replicaOf(a, Invoice, 65537);
		// A restores twice; B once, after many edits that push its clock ahead.
		restorePulse(a, start);
		a.total = 5;
		restorePulse(a, getPulseVersions(a).state);
		a.total = 6;
		for (let i = 0; i < 20; i++) b.total = 100 + i;
		restorePulse(b, start);
		b.total = 7;
		sync(b, a);
		sync(a, b);
		expect(a.generation).toBe(2);
		expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
		expect(b.total).toBe(6);
	});
});

describe("snapshots", () => {
	test("opens the frames of a document that keeps no history", () => {
		const note = createPulse(
			Plain,
			{ title: "a", status: "open", body: "Hi", tags: ["x"] },
			options(65536),
		);
		note.body.format(0, 2, { bold: true });
		const frames = exportPulseUpdates(note, []);
		note.title = "b";
		note.tags.push("y");
		note.body.insert(2, " there");

		const saved = openPulseSnapshot(Plain, note.id, frames);
		expect(snapshotPulse(saved)).toMatchObject({
			title: "a",
			body: "Hi",
			tags: ["x"],
		});
		expect(() => {
			saved.title = "c";
		}).toThrow(/read-only/);
		expect(() => saved.tags.push("z")).toThrow(/read-only/);

		restorePulse(note, saved);
		destroyPulse(saved);
		expect(note.generation).toBe(1);
		expect(snapshotPulse(note)).toMatchObject({
			title: "a",
			body: "Hi",
			tags: ["x"],
		});
		expect(note.body.toDelta()).toEqual([
			{ insert: "Hi", attributes: { bold: true } },
		]);
		expect(() => openPulseSnapshot(Plain, "other", frames)).toThrow();
		expect(() => openPulseSnapshot(Plain, note.id, [])).toThrow(/complete/);
	});

	test("sends a long formatted text in one transaction, as ranges", () => {
		const note = createPulse(
			Plain,
			{ title: "a", status: "open", body: "", tags: [] },
			options(65536),
		);
		const size = 60_000;
		note.body.insert(0, "x".repeat(size));
		note.body.format(0, size, { parent: "p1" });
		for (let index = 0; index < 400; index += 2)
			note.body.format(index, 1, { bold: true });
		// A replaced write: the journal no longer holds every row.
		note.title = "b";
		note.title = "c";
		const delta = note.body.toDelta();
		const frames = exportPulseUpdates(note, []);
		note.body.delete(0, size);
		note.title = "d";
		const saved = openPulseSnapshot(Plain, note.id, frames);
		const before = rows(note).length;
		restorePulse(note, saved);
		expect(rows(note)).toHaveLength(before + 1);
		// The text, and a few bytes for each of its 401 runs.
		expect(rows(note).at(-1)!.operations.length).toBeLessThan(size + 40_000);
		expect(note.body.toDelta()).toEqual(delta);
		expect(note.title).toBe("c");
		const peer = replicaOf(note, Plain, 65537);
		expect(peer.body.toDelta()).toEqual(delta);

		// The content itself has to fit a transaction.
		note.status = "s".repeat(600 * 1024);
		note.title = "t".repeat(600 * 1024);
		const large = openPulseSnapshot(
			Plain,
			note.id,
			exportPulseUpdates(note, []),
		);
		note.title = "e";
		note.title = "f";
		const held = rows(note).length;
		expect(() => restorePulse(note, large)).toThrow(/1 MiB/);
		expect(note.generation).toBe(1);
		expect(rows(note)).toHaveLength(held);
		for (const pulse of [saved, large]) destroyPulse(pulse);
	});

	test("applies the migrations added since a snapshot was made", () => {
		const v1 = object({ name: "string", tags: array("string") });
		const v2 = object({
			name: "string",
			title: "string",
			tags: array("string"),
			count: "uint",
		});
		const Old = definePulse("MigratedNote", v1).materialize();
		const New = definePulse("MigratedNote", v1)
			.migrateTo(v2, (data) => ({
				title: data.name.toUpperCase(),
				count: data.tags.length,
			}))
			.materialize();
		const id = crypto.randomUUID();
		const old = createPulse(
			Old,
			{ id, name: "ada", tags: ["x"] },
			options(65536),
		);
		const frames = exportPulseUpdates(old, []);

		// The document moves on: it is migrated, then edited.
		const live = openReplica(New, id, 65537) as any;
		sync(old, live);
		expect(live.version).toBe(2);
		live.title = "Edited";
		live.tags.push("y");
		live.count = 9;

		const saved = openPulseSnapshot(New, id, frames);
		expect(saved.version).toBe(2);
		expect(snapshotPulse(saved)).toMatchObject({
			title: "ADA",
			count: 1,
			tags: ["x"],
		});
		restorePulse(live, saved);
		expect(snapshotPulse(live)).toMatchObject({
			version: 2,
			generation: 1,
			title: "ADA",
			count: 1,
			tags: ["x"],
		});
		// A replica that only knows the first version cannot read the restore.
		const other = openReplica(New, id, 65538) as Pulse<any>;
		sync(live, other);
		expect(snapshotPulse(other)).toEqual(snapshotPulse(live));
	});

	test("reads a version from before a migration with the current schema", () => {
		const v1 = versioned(object({ name: "string" }));
		const v2 = versioned(object({ name: "string", title: "string" }));
		const Old = definePulse("MigratedVersioned", v1).materialize();
		const New = definePulse("MigratedVersioned", v1)
			.migrateTo(v2, (data) => ({ title: data.name.toUpperCase() }))
			.materialize();
		const id = crypto.randomUUID();
		const old = createPulse(Old, { id, name: "ada" }, options(65536));
		old.name = "grace";
		const live = openReplica(New, id, 65537) as any;
		sync(old, live);
		live.title = "Edited";
		const first = getPulseHistory(live)[0]!.version;
		expect(snapshotPulse(live, { at: first })).toMatchObject({
			version: 2,
			name: "ada",
			title: "ADA",
		});
		restorePulse(live, first);
		expect(snapshotPulse(live)).toMatchObject({
			version: 2,
			generation: 1,
			name: "ada",
			title: "ADA",
		});
	});
});
