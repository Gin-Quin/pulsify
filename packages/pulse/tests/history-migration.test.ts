import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { object, record } from "@gin-quin/codec";
import {
	counter,
	createPulse,
	createPulseScope,
	definePulse,
	getPulseMeta,
	schemaFingerprint,
	compilePulseSchema,
	snapshotPulse,
	versioned,
	type ModelFromDefinition,
	type Pulse,
} from "../source/index.js";
import { SqlitePatchStore } from "../source/storage.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import type { AnyPulseDefinition } from "../source/pulses/PulseDefinition.js";
import type { PulsePatchRow } from "../source/connection/PulsePatch.js";
import { rowToPatch } from "../source/connection/PulsePatch.js";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage.js";
import { isGap, lastValueOf } from "../source/core/operations.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
const meta = (pulse: Pulse<any>) => getPulseMeta(pulse);
function replica<D extends AnyPulseDefinition>(
	definition: D,
	id: string,
	actor: number,
): Pulse<ModelFromDefinition<D>> {
	return createRuntime(definition, id, options(actor)) as Pulse<
		ModelFromDefinition<D>
	>;
}
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
/** Send what `target` lacks from `source`. */
function sync(source: Pulse<any>, target: Pulse<any>): void {
	const rows = meta(source).log.missing(meta(target).log.vector);
	if (rows.length) meta(target).applyRows(wire(rows));
}
const rows = (pulse: Pulse<any>) => meta(pulse).log.missing([]);
/** The rows of a journal, by what a store does with them. */
function kinds(pulse: Pulse<any>) {
	const all = rows(pulse);
	return {
		gaps: all.filter((row) => isGap(row.operations)).length,
		last: all.filter((row) => lastValueOf(row.operations)).length,
		kept: all.filter(
			(row) => !isGap(row.operations) && !lastValueOf(row.operations),
		).length,
	};
}
const times = (pulse: Pulse<any>) =>
	rows(pulse)
		.filter((row) => !isGap(row.operations))
		.map(
			(row) =>
				rowToPatch(row, (schema) => meta(pulse).model.decodeEncoding(schema))
					.time,
		)
		.filter((time) => time !== undefined);
function converged(...pulses: Pulse<any>[]): void {
	for (let round = 0; round < 3; round++)
		for (const source of pulses)
			for (const target of pulses) if (source !== target) sync(source, target);
	for (const pulse of pulses) {
		expect(snapshotPulse(pulse)).toEqual(snapshotPulse(pulses[0]!));
		expect(meta(pulse).log.vector).toEqual(meta(pulses[0]!).log.vector);
		expect(meta(pulse).log.pendingCount).toBe(0);
	}
}

describe("documents written before fields had no history", () => {
	const Legacy = definePulse(
		"LegacyHistory",
		object({ title: "string", tags: record("string") }),
	).materialize();
	/** What every version before 13 wrote for a field: a history row. */
	function legacyWrite(pulse: Pulse<any>, value: string): void {
		const { model } = meta(pulse);
		model.commitScalar(
			model.root!,
			"title",
			model.field(model.root!, "title"),
			value,
		);
	}

	test("their rows stay, and their fields stop adding to them", () => {
		const a = createPulse(
			Legacy,
			{ id: crypto.randomUUID(), title: "created", tags: {} },
			options(65536),
		);
		for (let i = 0; i < 20; i++) legacyWrite(a, `old ${i}`);
		expect(kinds(a)).toEqual({ gaps: 0, last: 0, kept: 21 });
		// The schema identity did not change: the same definition reads them.
		const b = replica(Legacy, a.id, 65537);
		sync(a, b);
		expect(b.title).toBe("old 19");

		for (let i = 0; i < 50; i++) {
			a.title = `new ${i}`;
			b.tags["x"] = `tag ${i}`;
		}
		converged(a, b);
		expect(a.title).toBe("new 49");
		// The old history is intact; each field added one row, whatever the writes.
		expect(kinds(a)).toMatchObject({ last: 2, kept: 21 });
		expect(kinds(b)).toMatchObject({ last: 2, kept: 21 });
		// An old write that arrives late still loses to a newer one.
		const c = replica(Legacy, a.id, 65538);
		sync(a, c);
		expect(snapshotPulse(c)).toEqual(snapshotPulse(a));
	});

	test("a write in the old format made concurrently converges with the new ones", () => {
		const a = createPulse(
			Legacy,
			{ id: crypto.randomUUID(), title: "created", tags: {} },
			options(65536),
		);
		const b = replica(Legacy, a.id, 65537);
		sync(a, b);
		for (let i = 0; i < 5; i++) {
			legacyWrite(a, `old ${i}`);
			b.title = `new ${i}`;
		}
		converged(a, b);
		const c = replica(Legacy, a.id, 65538);
		sync(b, c);
		expect(c.title).toBe(a.title);
		// Afterwards a new write replaces the last one, never an old row.
		b.title = "after";
		b.title = "after again";
		converged(a, b, c);
		expect(kinds(c)).toMatchObject({ last: 1, kept: 6 });
	});

	test("a database from before version 13 is opened and extended as it is", async () => {
		const database = new Database(":memory:");
		const a = createPulse(
			Legacy,
			{ id: crypto.randomUUID(), title: "created", tags: {} },
			options(65536),
		);
		for (let i = 0; i < 10; i++) legacyWrite(a, `old ${i}`);
		await new SqlitePatchStore(database).append(wire(rows(a)));
		const store = new SqlitePatchStore(database);
		expect(await store.missing(a.id, [])).toHaveLength(11);
		for (let i = 0; i < 30; i++) {
			a.title = `new ${i}`;
			await store.append(wire(meta(a).log.missing(await store.vector(a.id))));
		}
		expect(await store.missing(a.id, [])).toHaveLength(12);
		const loaded = replica(Legacy, a.id, 65537);
		meta(loaded).applyRows(wire(await store.missing(a.id, [])));
		expect(snapshotPulse(loaded)).toEqual(snapshotPulse(a));
	});
});

describe("migrating whether a field keeps its history", () => {
	const plain = object({ status: "string", title: "string" });
	const kept = object({ status: versioned("string"), title: "string" });
	const timed = object({
		status: versioned("string", { timestamps: true }),
		title: "string",
	});

	test("turning history on keeps the value and every write that follows", () => {
		const builder = definePulse("HistoryOn", plain);
		const Old = builder.materialize();
		const Latest = builder.migrateTo(kept, () => ({})).materialize();
		const old = createPulse(
			Old,
			{ id: crypto.randomUUID(), status: "open", title: "T" },
			options(65536),
		);
		for (let i = 0; i < 10; i++) old.status = `v1 ${i}`;
		expect(kinds(old)).toEqual({ gaps: 0, last: 1, kept: 1 });

		const a = replica(Latest, old.id, 65537),
			b = replica(Latest, old.id, 65538);
		sync(old, a);
		expect(a.version).toBe(2);
		expect(a.status).toBe("v1 9");
		const base = kinds(a).kept;
		for (let i = 0; i < 10; i++) {
			a.status = `v2 ${i}`;
			a.title = `title ${i}`;
		}
		// Ten status writes are kept; the title is still one row.
		expect(kinds(a).kept).toBe(base + 10);
		expect(kinds(a).last).toBe(2);
		sync(a, b);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect(kinds(b)).toEqual(kinds(a));
	});

	test("a client still on the old version writes concurrently, in either order", () => {
		const builder = definePulse("HistoryOnLate", plain);
		const Old = builder.materialize();
		const Latest = builder.migrateTo(kept, () => ({})).materialize();
		const old = createPulse(
			Old,
			{ id: crypto.randomUUID(), status: "open", title: "T" },
			options(65536),
		);
		const author = replica(Latest, old.id, 65537);
		sync(old, author);
		const base = meta(old).log.vector;
		for (let i = 0; i < 3; i++) author.status = `v2 ${i}`;
		// The old client has not seen the migration, and writes last-value rows.
		for (let i = 0; i < 3; i++) old.status = `late ${i}`;
		const late = meta(old).log.missing(base),
			migrated = meta(author).log.missing(base);
		const first = replica(Latest, old.id, 65538),
			second = replica(Latest, old.id, 65539);
		sync(author, first);
		meta(first).applyRows(wire(late));
		meta(second).applyRows(wire(meta(old).log.missing([])));
		meta(second).applyRows(wire(migrated));
		// The second one met the old version first and migrated it itself: once
		// they have each other's migration, both hold the same document.
		expect(first.status).toBe(second.status);
		converged(first, second, author);
		// Whoever wins, the kept writes are all there.
		expect(kinds(first).kept).toBe(kinds(second).kept);
		expect(kinds(first).kept).toBeGreaterThanOrEqual(5);
		// The old client reads the migrated document as incompatible, not wrongly.
		expect(() => sync(author, old)).toThrow();
	});

	test("turning history off stops adding rows and keeps the ones stored", () => {
		const builder = definePulse("HistoryOff", kept);
		const Old = builder.materialize();
		const Latest = builder.migrateTo(plain, () => ({})).materialize();
		const old = createPulse(
			Old,
			{ id: crypto.randomUUID(), status: "open", title: "T" },
			options(65536),
		);
		for (let i = 0; i < 10; i++) old.status = `v1 ${i}`;
		expect(kinds(old)).toEqual({ gaps: 0, last: 0, kept: 11 });
		const a = replica(Latest, old.id, 65537);
		sync(old, a);
		expect(a.status).toBe("v1 9");
		const base = kinds(a);
		for (let i = 0; i < 40; i++) a.status = `v2 ${i}`;
		expect(kinds(a)).toEqual({ ...base, last: base.last + 1 });
		// A kept write of the old version that arrives late is still stored.
		old.status = "late";
		const b = replica(Latest, old.id, 65538);
		sync(a, b);
		sync(old, b);
		sync(old, a);
		converged(a, b);
		expect(kinds(a).kept).toBe(base.kept + 1);
	});

	test("timestamps start with the version that asks for them", () => {
		const builder = definePulse("HistoryTimed", kept);
		const Old = builder.materialize();
		const Latest = builder.migrateTo(timed, () => ({})).materialize();
		const old = createPulse(
			Old,
			{ id: crypto.randomUUID(), status: "open", title: "T" },
			options(65536),
		);
		for (let i = 0; i < 4; i++) old.status = `v1 ${i}`;
		expect(times(old)).toEqual([]);
		const a = replica(Latest, old.id, 65537);
		sync(old, a);
		const before = Date.now();
		for (let i = 0; i < 4; i++) a.status = `v2 ${i}`;
		// A required field cannot be deleted: nothing is recorded for the attempt.
		expect(() => delete (a as { status?: string }).status).toThrow();
		const b = replica(Latest, old.id, 65538);
		sync(a, b);
		const recorded = times(b) as number[];
		expect(recorded).toHaveLength(4);
		for (const time of recorded) {
			expect(time).toBeGreaterThanOrEqual(before);
			expect(time).toBeLessThanOrEqual(Date.now());
		}
		expect(b.status).toBe("v2 3");
	});

	test("a migration can change the mode and the value together", () => {
		const builder = definePulse("HistoryValue", plain);
		const Old = builder.materialize();
		const Latest = builder
			.migrateTo(kept, (before) => ({ status: before.status.toUpperCase() }))
			.materialize();
		const old = createPulse(
			Old,
			{ id: crypto.randomUUID(), status: "open", title: "T" },
			options(65536),
		);
		old.status = "draft";
		const a = replica(Latest, old.id, 65537),
			b = replica(Latest, old.id, 65538);
		sync(old, a);
		sync(old, b);
		// Both run the migration: its writes are the same, and one wins.
		expect(a.status).toBe("DRAFT");
		a.status = "done";
		converged(a, b);
		expect(a.status).toBe("done");
	});

	test("a counter changes mode without losing a count", () => {
		const v1 = object({ likes: counter() });
		const v2 = object({ likes: versioned(counter()) });
		const builder = definePulse("HistoryCounter", v1);
		const Old = builder.materialize();
		const Middle = builder.migrateTo(v2, () => ({}));
		const Latest = Middle.migrateTo(v1, () => ({})).materialize();
		const old = createPulse(
			Old,
			{ id: crypto.randomUUID(), likes: 2 },
			options(65536),
		);
		for (let i = 0; i < 5; i++) old.likes.increment();
		const a = replica(Middle.materialize(), old.id, 65537);
		sync(old, a);
		const likes = a.likes;
		expect(likes.value).toBe(7);
		// Not rebuilt: an increment the old client makes meanwhile still counts.
		old.likes.increment(10);
		for (let i = 0; i < 5; i++) a.likes.increment();
		expect(kinds(a).kept).toBeGreaterThanOrEqual(5);
		sync(old, a);
		expect(a.likes).toBe(likes);
		expect(a.likes.value).toBe(22);
		const b = replica(Latest, old.id, 65538);
		sync(a, b);
		expect(b.version).toBe(3);
		expect(b.likes.value).toBe(22);
		const kept = kinds(b).kept;
		for (let i = 0; i < 30; i++) b.likes.decrement();
		expect(b.likes.value).toBe(-8);
		expect(kinds(b).kept).toBe(kept);
	});

	test("a whole document becomes versioned, then stops", () => {
		const all = versioned(object({ status: "string", title: "string" }), {
			timestamps: true,
		});
		const builder = definePulse("HistoryRoot", plain);
		const Old = builder.materialize();
		const Middle = builder.migrateTo(all, () => ({}));
		const Latest = Middle.migrateTo(plain, () => ({})).materialize();
		const old = createPulse(
			Old,
			{ id: crypto.randomUUID(), status: "open", title: "T" },
			options(65536),
		);
		const a = replica(Middle.materialize(), old.id, 65537);
		sync(old, a);
		const base = kinds(a).kept;
		for (let i = 0; i < 6; i++) {
			a.status = `s${i}`;
			a.title = `t${i}`;
		}
		expect(kinds(a).kept).toBe(base + 12);
		expect(times(a)).toHaveLength(12);
		const b = replica(Latest, old.id, 65538);
		sync(a, b);
		const kept = kinds(b).kept;
		for (let i = 0; i < 20; i++) {
			b.status = `again ${i}`;
			b.title = `again ${i}`;
		}
		expect(kinds(b).kept).toBe(kept);
		expect(kinds(b).last).toBe(2);
		expect(snapshotPulse(b)).toMatchObject({
			status: "again 19",
			title: "again 19",
			version: 3,
		});
	});

	test("a document with several versions keeps its fields' last value only", () => {
		const v2 = object({
			status: "string",
			title: "string",
			tags: record("string"),
			author: object({ name: "string" }),
		});
		const builder = definePulse("HistoryVersions", plain);
		const Latest = builder
			.migrateTo(v2, () => ({ tags: {}, author: { name: "Ada" } }))
			.materialize();
		const a = createPulse(
			Latest,
			{
				id: crypto.randomUUID(),
				status: "open",
				title: "T",
				tags: {},
				author: { name: "Ada" },
			},
			options(65536),
		);
		const base = kinds(a);
		for (let i = 0; i < 100; i++) {
			a.status = `s${i}`;
			a.tags["k"] = `tag ${i}`;
			a.author.name = `name ${i}`;
			if (i % 2) delete a.tags["k"];
		}
		expect(kinds(a)).toMatchObject({ kept: base.kept, last: 3 });
		const b = replica(Latest, a.id, 65537);
		sync(a, b);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
	});

	test("peers must agree on what is versioned", () => {
		expect(schemaFingerprint(compilePulseSchema(kept))).not.toBe(
			schemaFingerprint(compilePulseSchema(plain)),
		);
		expect(schemaFingerprint(compilePulseSchema(timed))).not.toBe(
			schemaFingerprint(compilePulseSchema(kept)),
		);
		// A schema without the marker keeps the identity it had before.
		expect(
			schemaFingerprint(
				compilePulseSchema(object({ status: "string", title: "string" })),
			),
		).toBe(schemaFingerprint(compilePulseSchema(plain)));
		const a = createPulse(
			definePulse("HistoryAgree", plain).materialize(),
			{ id: crypto.randomUUID(), status: "open", title: "T" },
			options(65536),
		);
		const b = replica(
			definePulse("HistoryAgree", kept).materialize(),
			a.id,
			65537,
		);
		expect(() => sync(a, b)).toThrow("schema");
		expect(meta(b).loaded).toBe(false);
	});

	test("a store follows a document through its modes", async () => {
		const builder = definePulse("HistoryStore", plain);
		const Old = builder.materialize();
		const Middle = builder.migrateTo(kept, () => ({}));
		const Latest = Middle.migrateTo(plain, () => ({})).materialize();
		const store = new SqlitePatchStore(new Database(":memory:"));
		const push = async (pulse: Pulse<any>) => {
			const missing = meta(pulse).log.missing(
				await store.vector(meta(pulse).id),
			);
			if (missing.length) await store.append(wire(missing));
		};
		const pull = async (pulse: Pulse<any>) => {
			const missing = await store.missing(
				meta(pulse).id,
				meta(pulse).log.vector,
			);
			if (missing.length) meta(pulse).applyRows(wire(missing));
		};
		const stored = async (id: string) => (await store.missing(id, [])).length;

		const old = createPulse(
			Old,
			{ id: crypto.randomUUID(), status: "open", title: "T" },
			options(65536),
		);
		for (let i = 0; i < 20; i++) {
			old.status = `v1 ${i}`;
			await push(old);
		}
		expect(await stored(old.id)).toBe(2);

		const a = replica(Middle.materialize(), old.id, 65537);
		await pull(a);
		await push(a);
		const afterMigration = await stored(old.id);
		for (let i = 0; i < 20; i++) {
			a.status = `v2 ${i}`;
			await push(a);
		}
		expect(await stored(old.id)).toBe(afterMigration + 20);

		const b = replica(Latest, old.id, 65538);
		await pull(b);
		await push(b);
		const afterSecond = await stored(old.id);
		for (let i = 0; i < 20; i++) {
			b.status = `v3 ${i}`;
			await push(b);
		}
		// One more row for the field, however often it is written.
		expect(await stored(old.id)).toBeLessThanOrEqual(afterSecond + 2);
		const fresh = replica(Latest, old.id, 65539);
		await pull(fresh);
		expect(snapshotPulse(fresh)).toEqual(snapshotPulse(b));
		expect(fresh.status).toBe("v3 19");
	});
});
