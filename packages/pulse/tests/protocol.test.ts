import { describe, expect, test } from "bun:test";
import {
	decodeMessage,
	encodeMessage,
	PulseMessageSchema,
	OPERATIONS_VERSION,
	type PulseMessage,
} from "../source/connection/PulseMessage";
import { createCodec } from "@gin-quin/codec";
import {
	decodeOperations,
	encodeOperations,
	rowToPatch,
} from "../source/connection/PulsePatch";
import { PatchLog } from "../source/protocol/PatchLog";
import { createPulse, getPulseMeta, destroyPulse } from "../source/index";
import { createRuntime } from "../source/pulses/PulseRuntime";
import { defaultPulseOptions } from "../source/pulses/PulseOptions";
import type { CoreOperation } from "../source/core/operations";
import type { PreparedValue } from "../source/core/values";
import { Document, data, options } from "./helpers";

const prepared = (value: unknown): PreparedValue => ({
	value,
	constants: [],
	texts: [],
});

const messages: PulseMessage[] = [
	{
		kind: 1,
		docId: "hello/🌍",
		requestId: 1,
		vv: [[65536, Number.MAX_SAFE_INTEGER]],
	},
	{
		kind: 2,
		docId: "hello",
		requestId: 1,
		vv: [],
		found: false,
		complete: true,
		rows: [],
	},
	{ kind: 3, docId: "hello", requestId: 2, vv: [], rows: [] },
	{ kind: 4, docId: "hello", requestId: 0, vv: [], rows: [] },
	{ kind: 5, docId: "hello", requestId: 2, vv: [[65536, 128]] },
	{
		kind: 6,
		docId: "hello",
		requestId: 3,
		code: "NOT_FOUND",
		message: "No document",
	},
];
describe("binary protocol", () => {
	test("binary constants own their bytes after decoding", () => {
		const bytes = encodeOperations([
			{ kind: 0, value: prepared(new Uint8Array([1, 2, 3])) },
		]);
		const decoded = decodeOperations(bytes);
		bytes.fill(0);
		expect(decoded[0]).toEqual({
			kind: 0,
			value: prepared(new Uint8Array([1, 2, 3])),
		});
	});
	test("all variants round-trip and result buffers remain independent", () => {
		for (const message of messages) {
			const encoded = encodeMessage(message);
			const saved = encoded.slice();
			encodeMessage(messages[0]!);
			expect(encoded).toEqual(saved);
			expect(decodeMessage(encoded)).toEqual(message);
		}
	});
	test("every truncation and trailing byte is rejected", () => {
		for (const message of messages) {
			const bytes = encodeMessage(message);
			for (let n = 0; n < bytes.length; n++)
				expect(() => decodeMessage(bytes.subarray(0, n))).toThrow();
			expect(() => decodeMessage(new Uint8Array([...bytes, 0]))).toThrow(
				"Trailing bytes",
			);
		}
	});
	test("unsupported versions, unknown tags and invalid causal vectors are rejected", () => {
		expect(() => decodeMessage(new Uint8Array([2, 1]))).toThrow("Unsupported");
		expect(() =>
			decodeMessage(new Uint8Array([1, OPERATIONS_VERSION, 99])),
		).toThrow("Cannot decode message");
		const unchecked = createCodec(PulseMessageSchema);
		const body = unchecked.encode({
			kind: 1,
			docId: "x",
			requestId: 1,
			vv: [
				[65536, 1],
				[65536, 2],
			],
		});
		expect(() =>
			decodeMessage(new Uint8Array([1, OPERATIONS_VERSION, ...body])),
		).toThrow("sorted actors");
	});
	test("all operation variants preserve payloads, optional fields and constants", () => {
		const operations: CoreOperation[] = [
			{ kind: 0, value: prepared(undefined) },
			{ kind: 0, value: prepared(null) },
			{
				kind: 0,
				value: prepared({
					unicode: "é🌍",
					zero: 0,
					negative: -12.5,
					bool: false,
					array: [null, undefined, new Uint8Array([0, 255])],
				}),
			},
			{ kind: 1, target: "65536:1:0", field: "x", value: prepared([65536, 1]) },
			{ kind: 1, target: "65536:1:0", field: 0, value: prepared("typed slot") },
			{ kind: 2, target: "65536:1:0", field: "optional" },
			{
				kind: 3,
				target: "65536:1:1",
				after: "65536:1:2",
				deletes: ["65536:1:3"],
				values: [prepared("é🌍"), prepared(null)],
			},
			{
				kind: 4,
				target: "65536:1:1",
				entry: "65536:1:2",
				value: prepared({ x: 2 }),
			},
			{
				kind: 5,
				target: "65536:1:4",
				entries: ["65536:1:5"],
				attributes: { bold: true, color: "red" },
			},
		];
		const decoded = decodeOperations(encodeOperations(operations));
		expect(decoded).toEqual(operations);
	});
	test("random frames either round-trip or report decoding errors", () => {
		let seed = 911;
		for (let n = 0; n < 1000; n++) {
			const bytes = new Uint8Array(3 + (n % 48));
			bytes.set([1, OPERATIONS_VERSION]);
			for (let i = 2; i < bytes.length; i++) {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				bytes[i] = seed & 255;
			}
			try {
				const message = decodeMessage(bytes);
				expect(decodeMessage(encodeMessage(message))).toEqual(message);
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
			}
		}
	});
});
describe("causal patch journal", () => {
	function rows() {
		const pulse = createPulse(Document, data("journal"), {
			...options(),
			sessionId: 65536,
		});
		try {
			pulse.title = "next";
			pulse.nested.count = 3;
			return getPulseMeta(pulse).log.missing([]);
		} finally {
			destroyPulse(pulse);
		}
	}
	test("out-of-order segments wait for predecessors and exact duplicates are harmless", () => {
		const all = rows();
		const log = new PatchLog("journal");
		expect(log.append([all[2]!])).toEqual([]);
		expect(log.vector).toEqual([]);
		expect(log.append([all[1]!])).toEqual([]);
		expect(log.pendingCount).toBe(2);
		expect(log.append([all[0]!])).toHaveLength(3);
		expect(log.pendingCount).toBe(0);
		expect(log.append(all)).toEqual([]);
		expect(log.size).toBe(3);
		expect(log.missing(log.vector)).toEqual([]);
	});
	test("conflicts, overlaps and false span metadata are rejected", () => {
		const all = rows();
		const log = new PatchLog("journal");
		log.append(all);
		const first = all[0]!;
		expect(() => log.append([{ ...first, span: first.span + 1 }])).toThrow(
			"Conflicting",
		);
		// The journal accepts generic spans even though the current engine emits
		// one transaction per row. Its interval protection must remain intact.
		const ranges = new PatchLog("journal");
		ranges.append([{ ...first, span: 2 }]);
		expect(() => ranges.append([{ ...first, clock: 2 }])).toThrow(
			"Overlapping",
		);
		expect(() => rowToPatch({ ...first, span: first.span + 1 })).toThrow();
		// Payload decoding is schema-independent; graph-reference coverage is
		// checked by the runtime before it commits either model or journal.
		const target = createRuntime(Document, "journal", {
			...defaultPulseOptions,
			...options(),
			sessionId: 65538,
		});
		try {
			const meta = getPulseMeta(target);
			meta.applyRows([first]);
			const vector = meta.log.vector;
			expect(() =>
				meta.applyRows([{ ...all[1]!, dependencies: [] }]),
			).toThrow();
			expect(meta.log.vector).toEqual(vector);
		} finally {
			destroyPulse(target);
		}
		expect(log.size).toBe(3);
	});
	test("remote invalid data cannot modify the live model or journal", () => {
		const source = createPulse(Document, data("guarded"), {
			...options(),
			sessionId: Number.MAX_SAFE_INTEGER,
		});
		const target = createPulse(Document, data("other"), {
			...options(),
			sessionId: 65536,
		});
		const log = getPulseMeta(target).log;
		const vector = log.vector;
		expect(() =>
			getPulseMeta(target).applyRows(
				getPulseMeta(source)
					.log.missing([])
					.map((row) => ({ ...row, docId: target.id })),
			),
		).toThrow();
		expect(log.vector).toEqual(vector);
	});
	test("callers cannot mutate persisted bytes through input or output rows", () => {
		const first = rows()[0]!;
		const log = new PatchLog("journal");
		log.append([first]);
		const expected = log.missing([])[0]!.operations.slice();
		first.operations.fill(0);
		log.missing([])[0]!.operations.fill(1);
		expect(log.missing([])[0]!.operations).toEqual(expected);
	});
});
