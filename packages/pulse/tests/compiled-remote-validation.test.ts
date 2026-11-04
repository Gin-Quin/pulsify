import { expect, test } from "bun:test";
import { array, createCodec, map, object, type Schema } from "@gin-quin/codec";
import {
	patchToRow,
	type PulsePatchRow,
} from "../source/connection/PulsePatch.js";
import {
	CorePatch,
	type CoreOperation,
	type ValueEncoding,
} from "../source/core/operations.js";
import { prepareValue } from "../source/core/values.js";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
} from "../source/index.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";

const definition = definePulse(
	"CompiledRemoteValidation",
	object({
		count: "uint",
		profile: object({ label: "string" }),
		values: array("uint"),
		fixed: object({ value: "uint" }),
		float: "float64",
	}),
	{ constantPaths: [["fixed"]] },
).materialize();

function create() {
	return createPulse(
		definition,
		{
			count: 0,
			profile: { label: "original" },
			values: [1],
			fixed: { value: 1 },
			float: 1,
		},
		{
			...defaultPulseOptions,
			scope: createPulseScope(),
			sessionId: 65536,
		},
	);
}

test("compiled remote preflight rejects incompatible decoded layouts before committing a batch", () => {
	const pulse = create();
	try {
		const meta = getPulseMeta(pulse);
		const root = meta.model.root!;
		const vector = meta.log.vector;
		const original = snapshotPulse(pulse);
		const clock = meta.model.nextClock,
			lamport = meta.model.lamport,
			size = meta.log.size;
		const nodes = [...meta.model.index.entries()];
		const valid = patchToRow(
			pulse.id,
			new CorePatch(65537, 1, 2, meta.model.schemaId, [
				{ kind: 1, target: root.id, field: "count", value: prepareValue(2) },
			]),
			vector,
		);
		const layout = definition.compiledSchema!.fieldAt(["values"])!.layout;
		const wrongEncoding: ValueEncoding = {
			encode: () => ({
				layout: layout.id + 2,
				data: createCodec(array("uint")).encode([7]),
			}),
			decode: meta.model.encoding.decode,
		};
		const invalid = patchToRow(
			pulse.id,
			new CorePatch(65537, 2, 3, meta.model.schemaId, [
				{
					kind: 1,
					target: root.id,
					field: "profile",
					value: prepareValue([7]),
				},
			]),
			[...vector, [65537, 2]],
			wrongEncoding,
		);
		for (const rows of [
			[valid, invalid],
			[invalid, valid],
		]) {
			expect(() => meta.applyRows(rows)).toThrow();
			expect(snapshotPulse(pulse)).toEqual(original);
			expect(meta.log.vector).toEqual(vector);
			expect(meta.log.size).toBe(size);
			expect(meta.model.nextClock).toBe(clock);
			expect(meta.model.lamport).toBe(lamport);
			expect([...meta.model.index.entries()]).toEqual(nodes);
		}
		meta.applyRows([valid]);
		expect(pulse.count).toBe(2);
	} finally {
		destroyPulse(pulse);
	}
});

test("compiled remote preflight stages all nodes and rejects malformed root, fields, references and scalars", () => {
	const cases = [
		"missing-required-root",
		"missing-required-nested",
		"unknown-field",
		"unknown-slot",
		"constant-field",
		"unknown-target",
		"uncovered-target",
		"invalid-sequence-value",
		"invalid-scalar",
		"wrong-fingerprint",
		"malformed-bytes",
		"dropped-text-marker",
		"dropped-constant-marker",
	] as const;
	for (const scenario of cases) {
		const pulse = create();
		try {
			const meta = getPulseMeta(pulse),
				root = meta.model.root!;
			const vector = meta.log.vector,
				original = snapshotPulse(pulse);
			const clock = meta.model.nextClock,
				lamport = meta.model.lamport,
				size = meta.log.size;
			const nodes = [...meta.model.index.entries()];
			const valid = patchToRow(
				pulse.id,
				new CorePatch(65537, 1, 2, meta.model.schemaId, [
					{
						kind: 1,
						target: root.id,
						field: "profile",
						value: prepareValue({ label: "staged" }),
					},
				]),
				vector,
			);
			let ops: CoreOperation[];
			let schemaId = meta.model.schemaId;
			let dependencies = [...vector, [65537, 2] as [number, number]];
			if (scenario === "missing-required-root") {
				const data: Record<string, unknown> = { ...original };
				delete data["profile"];
				ops = [{ kind: 0, value: prepareValue(data) }];
			} else if (scenario === "missing-required-nested") {
				ops = [
					{
						kind: 1,
						target: root.id,
						field: "profile",
						value: prepareValue({}),
					},
				];
			} else if (
				scenario === "dropped-text-marker" ||
				scenario === "dropped-constant-marker"
			) {
				const value = prepareValue({ label: "after", ignored: "drop" });
				if (scenario === "dropped-text-marker") value.texts = [["ignored"]];
				else value.constants = [["ignored"]];
				ops = [{ kind: 1, target: root.id, field: "profile", value }];
			} else if (scenario === "unknown-field" || scenario === "unknown-slot") {
				ops = [
					{
						kind: 1,
						target: root.id,
						field: scenario === "unknown-field" ? "unknown" : 999,
						value: prepareValue(1),
					},
				];
			} else if (scenario === "constant-field") {
				ops = [
					{
						kind: 1,
						target: root.id,
						field: "fixed",
						value: prepareValue({ value: 2 }),
					},
				];
			} else if (scenario === "unknown-target") {
				ops = [
					{
						kind: 1,
						target: "65536:1:999999",
						field: "count",
						value: prepareValue(1),
					},
				];
			} else if (scenario === "uncovered-target") {
				ops = [
					{ kind: 1, target: root.id, field: "count", value: prepareValue(1) },
				];
				dependencies = [[65537, 2]];
			} else if (scenario === "invalid-sequence-value") {
				ops = [
					{
						kind: 3,
						target: root.child("values")!.id,
						after: "",
						deletes: [],
						values: [prepareValue("wrong")],
					},
				];
			} else {
				ops = [
					{
						kind: 1,
						target: root.id,
						field: "count",
						value: prepareValue(scenario === "invalid-scalar" ? "wrong" : 1),
					},
				];
				if (scenario === "wrong-fingerprint") schemaId = "0".repeat(32);
			}
			let invalid: PulsePatchRow = patchToRow(
				pulse.id,
				new CorePatch(65537, 2, 3, schemaId, ops),
				dependencies,
			);
			if (scenario === "malformed-bytes")
				invalid = {
					...invalid,
					operations: invalid.operations.subarray(
						0,
						invalid.operations.length - 1,
					),
				};
			expect(() => meta.applyRows([invalid, valid])).toThrow();
			expect(snapshotPulse(pulse)).toEqual(original);
			expect(meta.log.vector).toEqual(vector);
			expect(meta.log.size).toBe(size);
			expect(meta.model.nextClock).toBe(clock);
			expect(meta.model.lamport).toBe(lamport);
			expect([...meta.model.index.entries()]).toEqual(nodes);
			meta.applyRows([valid]);
			expect(pulse.profile.label).toBe("staged");
		} finally {
			destroyPulse(pulse);
		}
	}
});

test("typed non-finite scalar decoding cannot bypass scalar preflight", () => {
	const pulse = create();
	try {
		const meta = getPulseMeta(pulse),
			vector = meta.log.vector,
			original = snapshotPulse(pulse);
		const invalid = patchToRow(
			pulse.id,
			new CorePatch(65537, 1, 2, meta.model.schemaId, [
				{
					kind: 1,
					target: meta.model.root!.id,
					field: "float",
					value: { value: Infinity, constants: [], texts: [] },
				},
			]),
			vector,
			meta.model.encoding,
		);
		expect(() => meta.applyRows([invalid])).toThrow();
		expect(snapshotPulse(pulse)).toEqual(original);
		expect(meta.log.vector).toEqual(vector);
	} finally {
		destroyPulse(pulse);
	}
});

test("typed decoded object extras obey the portable grammar before being dropped", () => {
	const numeric = definePulse(
		"CompiledRemoteExtras",
		object({ profile: object({ value: "float64" }), shadow: map("float64") }),
	).materialize();
	for (const key of ["ignored", "constructor"]) {
		const pulse = createPulse(
			numeric,
			{ profile: { value: 1 }, shadow: {} },
			{ ...defaultPulseOptions, scope: createPulseScope(), sessionId: 65536 },
		);
		try {
			const meta = getPulseMeta(pulse),
				vector = meta.log.vector,
				original = snapshotPulse(pulse);
			const layout = numeric.compiledSchema!.fieldAt(["shadow"])!.layout;
			const raw = { value: 2, [key]: key === "ignored" ? Infinity : 3 };
			const encoding: ValueEncoding = {
				encode: () => ({
					layout: layout.id + 2,
					data: createCodec(map("float64")).encode(raw),
				}),
				decode: meta.model.encoding.decode,
			};
			const invalid = patchToRow(
				pulse.id,
				new CorePatch(65537, 1, 2, meta.model.schemaId, [
					{
						kind: 1,
						target: meta.model.root!.id,
						field: "profile",
						value: { value: raw, constants: [], texts: [] },
					},
				]),
				vector,
				encoding,
			);
			expect(() => meta.applyRows([invalid])).toThrow();
			expect(snapshotPulse(pulse)).toEqual(original);
			expect(meta.log.vector).toEqual(vector);
		} finally {
			destroyPulse(pulse);
		}
	}
});

test("rich-text character nodes do not consume the portable value depth budget", () => {
	let schema: Schema = object({ body: "string" });
	let data: Record<string, unknown> = { body: "abc" };
	const path = ["body"];
	for (let i = 0; i < 31; i++) {
		schema = object({ child: schema });
		data = { child: data };
		path.unshift("child");
	}
	const deep = definePulse("CompiledRemoteDeepText", schema, {
		richTextPaths: [path],
	}).materialize();
	const source = createPulse(deep, data as any, {
		...defaultPulseOptions,
		scope: createPulseScope(),
		sessionId: 65536,
	});
	const peer = createRuntime(deep, source.id, {
		...defaultPulseOptions,
		scope: createPulseScope(),
		sessionId: 65537,
	});
	try {
		expect(() =>
			getPulseMeta(peer).applyRows(getPulseMeta(source).log.missing([])),
		).not.toThrow();
		expect(snapshotPulse(peer)).toEqual(snapshotPulse(source));
	} finally {
		destroyPulse(source);
		destroyPulse(peer);
	}
});
