import { Buffer } from "node:buffer";
import { expect, test } from "bun:test";
import { array, object, type Schema } from "@gin-quin/codec";
import {
	patchToRow,
	type PulsePatchRow,
} from "../source/connection/PulsePatch.js";
import { CorePatch } from "../source/core/operations.js";
import { CoreModel } from "../source/core/model.js";
import { compilePulseSchema } from "../source/core/schema.js";
import { constantView, prepareValue } from "../source/core/values.js";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	type PulseProperties,
} from "../source/index.js";
import { PatchLog } from "../source/protocol/PatchLog.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { frozen } from "../source/index.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
function offsetBuffer(bytes: readonly number[] | Uint8Array) {
	const backing = Buffer.alloc(bytes.length + 11, 0xa5);
	backing.set(bytes, 5);
	return { backing, view: backing.subarray(5, 5 + bytes.length) };
}
const bytes = (value: Uint8Array) => Array.from(value);

for (const typed of [false, true]) {
	test(`Buffer initial values, assignments, reads and snapshots are isolated (${typed ? "typed" : "legacy"})`, () => {
		type Data = PulseProperties<"BufferIsolation"> & {
			payload: Uint8Array;
			nested: { payload: Uint8Array };
			list: Uint8Array[];
		};
		const schema = object({
			payload: "uint8Array",
			nested: object({ payload: "uint8Array" }),
			list: array("uint8Array"),
		});
		const definition = typed
			? definePulse("BufferIsolation", schema).materialize()
			: definePulse<Data>("BufferIsolation").materialize();
		const initial = offsetBuffer([1, 2, 3]),
			nested = offsetBuffer([4, 5]),
			item = offsetBuffer([6]);
		const pulse = createPulse(
			definition,
			{
				payload: initial.view,
				nested: { payload: nested.view },
				list: [item.view],
			},
			options(65536),
		);
		const peer = createRuntime(definition, pulse.id, options(65537));
		try {
			for (const input of [initial, nested, item]) input.backing.fill(99);
			expect(bytes(pulse.payload)).toEqual([1, 2, 3]);
			expect(bytes(pulse.nested.payload)).toEqual([4, 5]);
			expect(bytes(pulse.list[0]!)).toEqual([6]);
			const first = snapshotPulse(pulse);
			for (const read of [pulse.payload, pulse.nested.payload, pulse.list[0]!])
				read.fill(88);
			first.payload.fill(77);
			first.nested.payload.fill(77);
			first.list[0]!.fill(77);
			expect(bytes(pulse.payload)).toEqual([1, 2, 3]);
			expect(bytes(pulse.nested.payload)).toEqual([4, 5]);
			expect(bytes(pulse.list[0]!)).toEqual([6]);
			getPulseMeta(peer).applyRows(getPulseMeta(pulse).log.missing([]));
			expect(snapshotPulse(peer)).toEqual(snapshotPulse(pulse));
			const next = offsetBuffer([10, 11]),
				nextNested = offsetBuffer([12]),
				nextItem = offsetBuffer([13, 14]);
			pulse.payload = next.view;
			pulse.nested.payload = nextNested.view;
			pulse.list.splice(0, 1, nextItem.view);
			for (const input of [next, nextNested, nextItem]) input.backing.fill(66);
			expect(bytes(pulse.payload)).toEqual([10, 11]);
			expect(bytes(pulse.nested.payload)).toEqual([12]);
			expect(bytes(pulse.list[0]!)).toEqual([13, 14]);
			getPulseMeta(peer).applyRows(
				getPulseMeta(pulse).log.missing(getPulseMeta(peer).log.vector),
			);
			expect(snapshotPulse(peer)).toEqual(snapshotPulse(pulse));
		} finally {
			destroyPulse(pulse);
			destroyPulse(peer);
		}
	});

	test(`constant Buffer leaves return independent copies (${typed ? "typed" : "legacy"})`, () => {
		const definition = typed
			? definePulse(
					"ConstantBuffer",
					object({ fixed: object({ payload: "uint8Array" }) }),
					{ constantPaths: [["fixed"]] },
				).materialize()
			: definePulse(
					"ConstantBuffer",
					object({ fixed: frozen(object({ payload: "uint8Array" })) }),
				).materialize();
		const input = offsetBuffer([21, 22, 23]);
		const fixed = { payload: input.view };
		const pulse = createPulse(definition, { fixed } as any, options(65536));
		try {
			input.backing.fill(0);
			expect(bytes(pulse.fixed.payload)).toEqual([21, 22, 23]);
			pulse.fixed.payload.fill(1);
			expect(bytes(pulse.fixed.payload)).toEqual([21, 22, 23]);
			const snapshot = snapshotPulse(pulse);
			snapshot.fixed.payload.fill(2);
			expect(bytes(pulse.fixed.payload)).toEqual([21, 22, 23]);
		} finally {
			destroyPulse(pulse);
		}
	});
}

test("portable preparation, compiled copies and constant views own Buffer slices", () => {
	const input = offsetBuffer([31, 32, 33]);
	const layout = compilePulseSchema("uint8Array").root;
	const copies = [
		prepareValue(input.view).value,
		layout.prepare(input.view).value,
		layout.clone(input.view),
		constantView(input.view),
	] as Uint8Array[];
	input.backing.fill(0);
	for (const copy of copies) expect(bytes(copy)).toEqual([31, 32, 33]);
	for (const [index, copy] of copies.entries()) {
		copy.fill(index);
		for (const other of copies.slice(index + 1))
			expect(bytes(other)).toEqual([31, 32, 33]);
	}
});

test("model builds detach Buffer leaves from prepared operation storage", () => {
	const compiled = compilePulseSchema<Schema>(
		object({ payload: "uint8Array" }),
	);
	const model = new CoreModel(
		65536,
		"buffer-model",
		"BufferModel",
		1,
		compiled,
	);
	const input = offsetBuffer([35, 36]);
	model.apply(
		new CorePatch(65536, 1, 1, model.schemaId, [
			{
				kind: 0,
				value: {
					value: {
						payload: input.view,
						id: "buffer-model",
						kind: "BufferModel",
						version: 1,
						generation: 0,
					},
					constants: [],
					texts: [],
				},
			},
		]),
	);
	input.backing.fill(0);
	expect(bytes(model.view().payload)).toEqual([35, 36]);
});

test("materialized Buffer snapshots preserve offsets and remain detached", () => {
	type Public = PulseProperties<"MaterializedBuffer"> & { payload: Uint8Array };
	const definition = definePulse(
		"MaterializedBuffer",
		object({ attachment: "uint8Array" }),
	).materialize<Public>(({ bind }) => ({ payload: bind("attachment") }));
	const input = offsetBuffer([41, 42]);
	const pulse = createPulse(
		definition,
		{ attachment: input.view },
		options(65536),
	);
	try {
		input.backing.fill(0);
		const snapshot = snapshotPulse(pulse);
		expect(bytes(snapshot.payload)).toEqual([41, 42]);
		snapshot.payload.fill(1);
		expect(bytes(pulse.payload)).toEqual([41, 42]);
	} finally {
		destroyPulse(pulse);
	}
});

function encodedRow(docId: string, clock = 1): PulsePatchRow {
	return patchToRow(
		docId,
		new CorePatch(65536, clock, clock, "", [
			{ kind: 0, value: prepareValue({ payload: new Uint8Array([51, 52]) }) },
		]),
		clock === 1 ? [] : [[65536, clock]],
	);
}

for (const pending of [false, true]) {
	test(`journal owns Buffer rows through ${pending ? "pending gaps" : "actor batches"}`, () => {
		const originals = [
			encodedRow("buffer-batch", 1),
			encodedRow("buffer-batch", 2),
		];
		const backing = originals.map((row) => offsetBuffer(row.operations));
		const incoming = originals.map((row, i) => ({
			...row,
			operations: backing[i]!.view,
		}));
		const log = new PatchLog("buffer-batch");
		if (pending) {
			expect(log.appendRemoteRows([incoming[1]!])).toEqual([]);
			backing[1]!.backing.fill(0);
			log.appendRemoteRows([incoming[0]!]);
		} else log.appendRemoteRows(incoming);
		for (const input of backing) input.backing.fill(0);
		expect(log.missing([])).toEqual(originals);
	});
}

test("rich-text Buffer attributes are detached on input and delta reads", () => {
	const definition = definePulse(
		"BufferTextAttributes",
		object({ body: "string" }),
		{ richTextPaths: [["body"]] },
	).materialize();
	const pulse = createPulse(definition, { body: "ab" }, options(65536));
	const input = offsetBuffer([71, 72]);
	try {
		pulse.body.format(0, 1, { attachment: input.view });
		input.backing.fill(0);
		const delta = pulse.body.toDelta();
		expect(bytes(delta[0]!.attributes!["attachment"] as Uint8Array)).toEqual([
			71, 72,
		]);
		(delta[0]!.attributes!["attachment"] as Uint8Array).fill(1);
		expect(
			bytes(pulse.body.toDelta()[0]!.attributes!["attachment"] as Uint8Array),
		).toEqual([71, 72]);
	} finally {
		destroyPulse(pulse);
	}
});

for (const mode of ["append", "appendRemoteRows"] as const) {
	test(`journal ${mode} owns imported offset Buffers and isolates exported bytes`, () => {
		const original = encodedRow("buffer-import"),
			imported = offsetBuffer(original.operations);
		const incoming = { ...original, operations: imported.view };
		const log = new PatchLog(original.docId);
		log[mode]([incoming]);
		imported.backing.fill(0);
		expect(bytes(log.missing([])[0]!.operations)).toEqual(
			bytes(original.operations),
		);
		log.missing([])[0]!.operations.fill(1);
		expect(bytes(log.missing([])[0]!.operations)).toEqual(
			bytes(original.operations),
		);
	});
}

for (const mode of ["appendPatch", "appendLocalPatch"] as const) {
	test(`journal ${mode} owns bytes returned by a custom lazy encoder`, () => {
		const docId = "buffer-local-encoder",
			original = encodedRow(docId),
			encoded = offsetBuffer(original.operations);
		const patch = new CorePatch(65536, 1, 1, "", [
			{ kind: 0, value: prepareValue({ payload: new Uint8Array([51, 52]) }) },
		]);
		const log = new PatchLog(docId);
		const ready = log[mode](patch, () => ({
			...original,
			operations: encoded.view,
		}));
		// Materialize the lazy encoder before mutating the caller-owned Buffer.
		expect(bytes(ready[0]!.operations)).toEqual(bytes(original.operations));
		encoded.backing.fill(0);
		expect(bytes(log.missing([])[0]!.operations)).toEqual(
			bytes(original.operations),
		);
		log.missing([])[0]!.operations.fill(1);
		expect(bytes(log.missing([])[0]!.operations)).toEqual(
			bytes(original.operations),
		);
	});
}

test("public journal callbacks cannot mutate Buffer-backed cached wire bytes", () => {
	const docId = "buffer-callback",
		original = encodedRow(docId),
		encoded = offsetBuffer(original.operations);
	const log = new PatchLog(docId);
	const patch = new CorePatch(65536, 1, 1, "", [
		{ kind: 0, value: prepareValue({ payload: new Uint8Array([51, 52]) }) },
	]);
	log.appendPatch(
		patch,
		() => ({ ...original, operations: encoded.view }),
		(available) => {
			available[0]!.operations.fill(0);
		},
	);
	expect(bytes(log.missing([])[0]!.operations)).toEqual(
		bytes(original.operations),
	);
});

test("runtime import owns the Buffer frame independently of model and journal", () => {
	const definition = definePulse(
		"BufferRuntimeImport",
		object({ payload: "uint8Array" }),
	).materialize();
	const source = createPulse(
		definition,
		{ payload: new Uint8Array([61, 62, 63]) },
		options(65536),
	);
	const peer = createRuntime(definition, source.id, options(65537));
	try {
		const originals = getPulseMeta(source).log.missing([]);
		const backing = originals.map((row) => offsetBuffer(row.operations));
		getPulseMeta(peer).applyRows(
			originals.map((row, i) => ({ ...row, operations: backing[i]!.view })),
		);
		for (const input of backing) input.backing.fill(0);
		expect(bytes(peer["payload"])).toEqual([61, 62, 63]);
		expect(getPulseMeta(peer).log.missing([])).toEqual(originals);
	} finally {
		destroyPulse(source);
		destroyPulse(peer);
	}
});
