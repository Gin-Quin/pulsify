import { describe, expect, test } from "bun:test";
import {
	decodeMessage,
	encodeMessage,
	PulseMessageSchema,
	type PulseMessage,
} from "../source/connection/PulseMessage";
import { createCodec } from "@gin-quin/codec";
import {
	decodeOperations,
	encodeOperations,
	rowToPatch,
} from "../source/connection/PulsePatch";
import { PatchLog } from "../source/protocol/PatchLog";
import { createPulse, getPulseMeta } from "../source/index";
import type { JsonCodecOperation } from "json-joy/lib/json-crdt-patch/codec/verbose";
import { Document, data, options } from "./helpers";

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
			{ op: "new_con", value: new Uint8Array([1, 2, 3]) },
		]);
		const decoded = decodeOperations(bytes);
		bytes.fill(0);
		expect(decoded[0]).toEqual({
			op: "new_con",
			value: new Uint8Array([1, 2, 3]),
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
		expect(() => decodeMessage(new Uint8Array([1, 1, 99]))).toThrow(
			"Cannot decode message",
		);
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
		expect(() => decodeMessage(new Uint8Array([1, 1, ...body]))).toThrow(
			"sorted actors",
		);
	});
	test("all operation variants preserve payloads, optional fields and constants", () => {
		const operations: JsonCodecOperation[] = [
			{ op: "new_con" },
			{ op: "new_con", value: undefined },
			{ op: "new_con", value: null },
			{
				op: "new_con",
				value: {
					unicode: "é🌍",
					zero: 0,
					negative: -12.5,
					bool: false,
					array: [null, undefined, new Uint8Array([0, 255])],
				},
			},
			{ op: "new_con", value: [65536, 1], timestamp: true },
			...(
				[
					"new_val",
					"new_obj",
					"new_vec",
					"new_str",
					"new_bin",
					"new_arr",
				] as const
			).map((op) => ({ op })),
			{ op: "ins_val", obj: [0, 0], value: [65536, 2] },
			{ op: "ins_obj", obj: [65536, 2], value: [["x", [65536, 3]]] },
			{ op: "ins_vec", obj: 1, value: [[0, 2]] },
			{ op: "ins_str", obj: 1, after: 1, value: "é🌍" },
			{ op: "ins_bin", obj: 1, after: 1, value: "AP8=" },
			{ op: "ins_arr", obj: 1, after: 1, values: [2, [65536, 3]] },
			{ op: "upd_arr", obj: 1, ref: 2, value: 3 },
			{ op: "del", obj: 1, what: [[65536, 3, 2]] },
			{ op: "nop" },
			{ op: "nop", len: 12 },
		];
		const decoded = decodeOperations(encodeOperations(operations));
		expect(decoded.map((op) => op.op)).toEqual(operations.map((op) => op.op));
		for (let i = 1; i < operations.length; i++)
			expect(decoded[i]).toEqual(operations[i]);
		expect(decoded[0]).toEqual({ op: "new_con", value: undefined });
	});
	test("random frames either round-trip or report decoding errors", () => {
		let seed = 911;
		for (let n = 0; n < 1000; n++) {
			const bytes = new Uint8Array(3 + (n % 48));
			bytes.set([1, 1]);
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
		pulse.title = "next";
		pulse.nested.count = 3;
		return getPulseMeta(pulse).log.missing([]);
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
		expect(() => log.append([{ ...first, clock: first.clock + 1 }])).toThrow(
			"Overlapping",
		);
		expect(() => rowToPatch({ ...first, span: first.span + 1 })).toThrow(
			"span mismatch",
		);
		expect(() => rowToPatch({ ...all[1]!, dependencies: [] })).toThrow(
			"not causally covered",
		);
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
		).toThrow("incompatible");
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
