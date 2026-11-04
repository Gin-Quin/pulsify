import { expect, test } from "bun:test";
import { object, optional, union } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	subscribePulse,
} from "../source/index.js";
import {
	CorePatch,
	ScalarPatch,
	type CoreOperation,
} from "../source/core/operations.js";
import { prepareValue } from "../source/core/values.js";
import { patchToRow } from "../source/connection/PulsePatch.js";
import { MAX_LOG_ROWS, PatchLog } from "../source/protocol/PatchLog.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";

const options = (sessionId = 65536) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
const Definition = definePulse(
	"ScalarJournal",
	object({
		count: "float64",
		rounded: "float32",
		title: "string",
		flag: "boolean",
		maybe: optional("string"),
		value: "unknown",
	}),
).materialize();
const input = () => ({
	id: "scalar-journal",
	count: 0,
	rounded: 0,
	title: "initial",
	flag: false,
	value: { previous: 1 },
});

test("scalar patch bodies stay lazy and produce the unchanged immutable row format", () => {
	class TracedPatch extends ScalarPatch {
		materialized = 0;
		protected override createOperations(): CoreOperation[] {
			this.materialized++;
			return super.createOperations();
		}
	}
	const patch = new TracedPatch(65536, 1, 1, "", "65536:1:0", "value", 5);
	const log = new PatchLog("lazy-scalar");
	log.appendLocalPatch(patch, patchToRow);
	expect(patch.materialized).toBe(0);
	const rows = log.missing([]);
	expect(patch.materialized).toBe(1);
	expect(rows).toEqual([
		patchToRow(
			"lazy-scalar",
			new CorePatch(65536, 1, 1, "", [
				{
					kind: 1,
					target: "65536:1:0",
					field: "value",
					value: prepareValue(5),
				},
			]),
			[],
		),
	]);
	rows[0]!.operations.fill(0);
	expect(log.missing([])[0]!.operations.some((byte) => byte !== 0)).toBe(true);
	expect(patch.materialized).toBe(1);
});

test("scalar commits match generic commits and preserve every historical row after long edits", () => {
	const fast = createPulse(Definition, input(), options()),
		generic = createPulse(Definition, input(), options());
	const a = getPulseMeta(fast),
		b = getPulseMeta(generic);
	const target = b.model.root!;
	const set = (key: string, value: unknown) => {
		const field = target.layout!.fieldsByKey.get(key)!;
		b.model.commit([
			{
				kind: 1,
				target: target.id,
				field: field.id,
				value: b.model.normalize(prepareValue(value), field.layout),
			},
		]);
	};
	try {
		for (let i = 0; i < 200; i++) {
			const value = i === 0 ? -0 : i;
			fast.count = value;
			set("count", value);
			fast.rounded = value / 3;
			set("rounded", value / 3);
			fast.title = `title-${i}é🌍`;
			set("title", fast.title);
			fast.flag = !!(i % 2);
			set("flag", fast.flag);
			fast.maybe = i % 2 ? undefined : String(i);
			set("maybe", fast.maybe);
			(fast as any).value = i % 3 ? null : i;
			set("value", (fast as any).value);
		}
		expect(snapshotPulse(fast)).toEqual(snapshotPulse(generic));
		const original = a.log.missing([]);
		expect(original).toEqual(b.log.missing([]));
		expect(original).toHaveLength(1201);
		for (let i = 0; i < 100; i++) {
			fast.count = i;
			set("count", i);
		}
		expect(a.log.missing([]).slice(0, original.length)).toEqual(original);
		expect(a.log.missing([])).toEqual(b.log.missing([]));
		const restored = createRuntime(Definition, fast.id, options(65537));
		try {
			getPulseMeta(restored).applyRows(a.log.missing([]));
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(fast));
		} finally {
			destroyPulse(restored);
		}
	} finally {
		destroyPulse(fast);
		destroyPulse(generic);
	}
});

test("scalar writes keep validation, stale-child guards, notifications and scope lifecycle", () => {
	const config = options(),
		pulse = createPulse(Definition, input(), config),
		meta = getPulseMeta(pulse);
	const id = pulse.id;
	const old = (pulse as any).value;
	const calls: number[] = [];
	const unsubscribe = subscribePulse(pulse, (current) => {
		calls.push(current.count);
	});
	let rowEvents = 0;
	meta.rowListeners.add(() => {
		rowEvents++;
		expect(meta.log.vector).toEqual([[65536, meta.model.nextClock]]);
		expect(meta.log.missing([])).toHaveLength(meta.model.nextClock - 1);
	});
	try {
		expect(createPulse(Definition, input(), config)).toBe(pulse);
		pulse.count = 2;
		expect(calls).toEqual([0, 2]);
		expect(rowEvents).toBe(1);
		expect(meta.lastError).toBeUndefined();
		(pulse as any).value = null;
		expect(() => {
			old.previous = 2;
		}).toThrow("replaced or removed");
		const before = snapshotPulse(pulse),
			vector = meta.log.vector;
		for (const edit of [
			() => {
				pulse.count = NaN;
			},
			() => {
				pulse.count = Infinity;
			},
			() => {
				pulse.title = "\ud800";
			},
			() => {
				(pulse as any).count = "wrong";
			},
			() => {
				(pulse as any).id = "other";
			},
		]) {
			expect(edit).toThrow();
			expect(snapshotPulse(pulse)).toEqual(before);
			expect(meta.log.vector).toEqual(vector);
		}
		unsubscribe();
		destroyPulse(pulse);
		expect(config.scope.pulses.has(id)).toBe(false);
		expect(() => {
			pulse.count = 3;
		}).toThrow("destroyed");
		expect(() => meta.model.set(meta.model.root!, "count", 3)).toThrow(
			"destroyed",
		);
		expect(rowEvents).toBe(2);
		const replacement = createPulse(Definition, input(), config);
		try {
			expect(replacement).not.toBe(pulse);
		} finally {
			destroyPulse(replacement);
		}
	} finally {
		destroyPulse(pulse);
	}
});

test("scalar commits reject exhausted clocks and history quotas without changing state", () => {
	for (const clock of ["lamport", "nextClock"] as const) {
		const pulse = createPulse(Definition, input(), options()),
			meta = getPulseMeta(pulse);
		try {
			meta.model[clock] = Number.MAX_SAFE_INTEGER;
			const vector = meta.log.vector;
			expect(() => {
				pulse.count = 2;
			}).toThrow();
			expect(pulse.count).toBe(0);
			expect(meta.log.vector).toEqual(vector);
			expect(meta.log.size).toBe(1);
			expect(meta.model[clock]).toBe(Number.MAX_SAFE_INTEGER);
		} finally {
			destroyPulse(pulse);
		}
	}
	const pulse = createPulse(Definition, input(), options()),
		meta = getPulseMeta(pulse);
	try {
		for (let i = 1; i < MAX_LOG_ROWS; i++) pulse.count = i;
		const before = pulse.count,
			vector = meta.log.vector,
			lamport = meta.model.lamport;
		expect(() => {
			pulse.count = -1;
		}).toThrow("history limit");
		expect(pulse.count).toBe(before);
		expect(meta.log.vector).toEqual(vector);
		expect(meta.model.lamport).toBe(lamport);
		expect(meta.log.size).toBe(MAX_LOG_ROWS);
	} finally {
		destroyPulse(pulse);
	}
});

test("runtime rejects NUL document IDs before registering a pulse", () => {
	const config = options();
	expect(() =>
		createPulse(Definition, { ...input(), id: "bad\0id" }, config),
	).toThrow("Invalid pulse ID");
	expect(config.scope.pulses.size).toBe(0);
});

test("union and lazy root histories retain managed metadata and editable nested IDs", () => {
	const objectRoot = object({
		title: "string",
		nested: object({ count: "uint" }),
	});
	const definitions = [
		definePulse(
			"UnionRootReplay",
			union({
				tagName: "type",
				tagType: "string",
				variants: { note: objectRoot.fields },
			}),
		).materialize(),
		definePulse("LazyRootReplay", () => objectRoot).materialize(),
	];
	for (const definition of definitions) {
		const source = createPulse(
			definition,
			{
				title: "initial",
				nested: { count: 1 },
				...(definition.kind === "UnionRootReplay" ? { type: "note" } : {}),
			} as any,
			options(),
		);
		const restored = createRuntime(definition, source.id, options(65537));
		try {
			const a = getPulseMeta(source),
				b = getPulseMeta(restored);
			b.applyRows(a.log.missing([]));
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(source));
			expect(restored.id).toBe(source.id);
			expect(restored.kind).toBe(definition.kind);
			expect(restored.version).toBe(1);
			(source as any).nested.count = 2;
			b.applyRows(a.log.missing(b.log.vector));
			(restored as any).title = "from restored";
			a.applyRows(b.log.missing(a.log.vector));
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(source));
			const fresh = createRuntime(definition, source.id, options(65538));
			try {
				getPulseMeta(fresh).applyRows(b.log.missing([]));
				expect(snapshotPulse(fresh)).toEqual(snapshotPulse(source));
			} finally {
				destroyPulse(fresh);
			}
		} finally {
			destroyPulse(source);
			destroyPulse(restored);
		}
	}
});
