import { expect, spyOn, test } from "bun:test";
import { array, bigint, map, object, optional, union } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	type PulseProperties,
} from "../source/index.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";

const options = (sessionId = 65536) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});

test("compiled snapshots preserve deleted optional fields in objects, arrays and maps", () => {
	const item = object({ maybe: optional("string"), title: "string" });
	const definition = definePulse(
		"SnapshotDeleted",
		object({ profile: item, rows: array(item), values: map(item) }),
	).materialize();
	const pulse = createPulse(
		definition,
		{
			profile: { maybe: "profile", title: "Profile" },
			rows: [{ maybe: "row", title: "Row" }],
			values: { entry: { maybe: "map", title: "Map" } },
		},
		options(),
	);
	const clone = spyOn(getPulseMeta(pulse).model.root!.layout!, "snapshot");
	try {
		delete pulse.profile.maybe;
		delete pulse.rows[0]!.maybe;
		delete pulse.values["entry"]!.maybe;
		const snapshot = snapshotPulse(pulse);
		expect(clone).toHaveBeenCalledTimes(1);
		for (const value of [
			snapshot.profile,
			snapshot.rows[0]!,
			snapshot.values["entry"]!,
		])
			expect(Object.hasOwn(value, "maybe")).toBe(false);
		expect(snapshot).toStrictEqual(
			structuredClone(getPulseMeta(pulse).model.view()),
		);
		pulse.profile.maybe = "Reinserted";
		const reordered = snapshotPulse(pulse);
		expect(clone).toHaveBeenCalledTimes(2);
		expect(Object.keys(reordered.profile)).toEqual(["title", "maybe"]);
	} finally {
		clone.mockRestore();
		destroyPulse(pulse);
	}
});

test("a deleted root optional uses the shape-preserving snapshot fallback", () => {
	const definition = definePulse(
		"SnapshotRootDeleted",
		object({ maybe: optional("string"), title: "string" }),
	).materialize();
	const pulse = createPulse(
		definition,
		{ maybe: "Present", title: "Title" },
		options(),
	);
	const clone = spyOn(getPulseMeta(pulse).model.root!.layout!, "snapshot");
	try {
		delete pulse.maybe;
		const snapshot = snapshotPulse(pulse);
		expect(clone).not.toHaveBeenCalled();
		expect(Object.hasOwn(snapshot, "maybe")).toBe(false);
		pulse.maybe = "Again";
		const reordered = snapshotPulse(pulse);
		expect(clone).toHaveBeenCalledTimes(1);
		expect(Object.keys(reordered)).toEqual(
			Object.keys(getPulseMeta(pulse).model.view()),
		);
	} finally {
		clone.mockRestore();
		destroyPulse(pulse);
	}
});

test("compiled snapshots retain stored nested fields retired by a schema migration", () => {
	const builder = definePulse(
		"SnapshotRetired",
		object({ profile: object({ retained: "string", retired: "string" }) }),
	);
	const oldDefinition = builder.materialize();
	type Latest = PulseProperties<"SnapshotRetired"> & {
		profile: { retained: string };
	};
	const definition = builder
		// Older migrators can leave retired storage fields in place. Exercise
		// that runtime history even though the current type API asks for profile.
		.migrate<Latest>("retire nested field", () => ({}) as never)
		.schema(object({ profile: object({ retained: "string" }) }))
		.materialize();
	const old = createPulse(
		oldDefinition,
		{ profile: { retained: "Keep", retired: "Historical" } },
		options(),
	);
	const pulse = createRuntime(definition, old.id, options(65537));
	try {
		getPulseMeta(pulse).applyRows(getPulseMeta(old).log.missing([]));
		expect(pulse.version).toBe(2);
		expect(getPulseMeta(pulse).model.view().profile.retired).toBe("Historical");
		const clone = spyOn(getPulseMeta(pulse).model.root!.layout!, "snapshot");
		try {
			const snapshot = snapshotPulse(pulse);
			expect(clone).toHaveBeenCalledTimes(1);
			expect(snapshot).toStrictEqual(
				structuredClone(getPulseMeta(pulse).model.view()),
			);
			expect(Reflect.get(snapshot["profile"], "retired")).toBe("Historical");
		} finally {
			clone.mockRestore();
		}
	} finally {
		destroyPulse(old);
		destroyPulse(pulse);
	}
});

test("full codec kind unions snapshot metadata, bigint, float32, constants and rich text", () => {
	const schema = union({
		tagName: "kind",
		tagType: "string",
		variants: {
			SnapshotFull: {
				id: "string",
				generation: "uint",
				version: "uint",
				rounded: "float32",
				large: bigint(),
				body: "string",
				fixed: object({
					payload: "uint8Array",
					values: array("float32"),
					large: bigint(),
				}),
			},
			OtherSnapshot: {
				id: "string",
				generation: "uint",
				version: "uint",
				label: "string",
			},
		},
	});
	const definition = definePulse("SnapshotFull", schema, {
		constantPaths: [["fixed"]],
		richTextPaths: [["body"]],
	}).materialize();
	const pulse = createPulse(
		definition,
		{
			id: "full-codec-snapshot",
			rounded: -1e-100,
			large: 123456789012345678901234567890n,
			body: "é🌍",
			fixed: {
				payload: new Uint8Array([1, 2]),
				values: [1 / 3, -1e-100],
				large: -123456789012345678901234567890n,
			},
		},
		options(),
	);
	const clone = spyOn(getPulseMeta(pulse).model.root!.layout!, "snapshot");
	try {
		pulse.body.format(1, 1, { bold: true });
		pulse.body.insert(2, "!");
		const snapshot = snapshotPulse(pulse);
		expect(clone).toHaveBeenCalledTimes(1);
		expect(snapshot).toStrictEqual(
			structuredClone(getPulseMeta(pulse).model.view()),
		);
		expect(snapshot.kind).toBe("SnapshotFull");
		expect(snapshot.id).toBe("full-codec-snapshot");
		expect(snapshot.version).toBe(1);
		expect(snapshot.generation).toBe(0);
		expect(Object.is(snapshot.rounded, -0)).toBe(true);
		expect(Object.is(snapshot.fixed.values[1], -0)).toBe(true);
		expect(snapshot.fixed.values[0]).toBe(Math.fround(1 / 3));
		expect(snapshot.large).toBe(123456789012345678901234567890n);
		expect(snapshot.fixed.large).toBe(-123456789012345678901234567890n);
		expect(snapshot.body).toBe("é🌍!");
		snapshot.fixed.payload[0] = 99;
		snapshot.fixed.values[0] = 99;
		expect(pulse.fixed.payload[0]).toBe(1);
		expect(pulse.fixed.values[0]).toBe(Math.fround(1 / 3));
	} finally {
		clone.mockRestore();
		destroyPulse(pulse);
	}
});

test("typed push and unshift validate atomically and keep empty calls out of history", () => {
	const definition = definePulse(
		"AppendWrappers",
		object({ rows: array(object({ value: "uint" })) }),
	).materialize();
	const pulse = createPulse(definition, { rows: [{ value: 1 }] }, options());
	const meta = getPulseMeta(pulse);
	const stale = pulse.rows;
	let currentMethods: Array<(...items: { value: number }[]) => number> = [];
	try {
		const vector = meta.log.vector,
			clock = meta.model.nextClock;
		expect(pulse.rows.push()).toBe(1);
		expect(pulse.rows.unshift()).toBe(1);
		for (const append of [pulse.rows.push, pulse.rows.unshift]) {
			expect(() => append({ value: 2 }, { value: -1 })).toThrow();
			expect(meta.log.vector).toEqual(vector);
			expect(meta.model.nextClock).toBe(clock);
			expect([...pulse.rows]).toEqual([{ value: 1 }]);
		}
		expect(pulse.rows.push({ value: 2 }, { value: 3 })).toBe(3);
		expect(pulse.rows.unshift({ value: 0 })).toBe(4);
		expect(pulse.rows.map((item) => item.value)).toEqual([0, 1, 2, 3]);
		pulse.rows = [];
		for (const append of [stale.push, stale.unshift])
			expect(() => append()).toThrow("replaced or removed");
		currentMethods = [pulse.rows.push, pulse.rows.unshift];
	} finally {
		destroyPulse(pulse);
	}
	for (const append of currentMethods) expect(() => append()).toThrow();
});
