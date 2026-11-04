import { expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	snapshotPulse,
	type PulseProperties,
	type RichText,
} from "../source/index";

test("materialized rich text snapshots infer plain strings and preserve detached binary leaves", () => {
	type Public = PulseProperties<"MaterializedSnapshot"> & {
		content: RichText;
		payload: Uint8Array;
	};
	const Definition = definePulse(
		"MaterializedSnapshot",
		object({
			body: "string",
			attachment: "uint8Array",
		}),
		{ richTextPaths: [["body"]] },
	).materialize<Public>(({ bind }) => ({
		content: bind("body"),
		payload: bind("attachment"),
	}));
	const initialBytes = new Uint8Array([1, 2, 3]);
	const pulse = createPulse(
		Definition,
		{ body: "é🌍", attachment: initialBytes },
		{
			scope: createPulseScope(),
			sessionId: 65536,
		},
	);
	try {
		pulse.content.format(1, 1, { bold: true });
		pulse.content.insert(2, "!");
		initialBytes[0] = 99;
		const snapshot = snapshotPulse(pulse);
		const text: string = snapshot.content;
		const bytes: Uint8Array = snapshot.payload;
		expect(text).toBe("é🌍!");
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
		expect(Object.hasOwn(snapshot, "body")).toBe(false);
		expect(Object.hasOwn(snapshot, "attachment")).toBe(false);
		// @ts-expect-error Snapshot text has no collaborative mutation API.
		snapshot.content.insert;
		snapshot.content = "detached";
		snapshot.payload[0] = 88;
		expect(pulse.content.text).toBe("é🌍!");
		expect(pulse.payload).toEqual(new Uint8Array([1, 2, 3]));
		expect(pulse.content.toDelta()).toEqual([
			{ insert: "é" },
			{ insert: "🌍", attributes: { bold: true } },
			{ insert: "!" },
		]);
	} finally {
		destroyPulse(pulse);
	}
});

test("plain binary snapshots preserve Uint8Array type and copy initial input", () => {
	const Definition = definePulse(
		"BinarySnapshot",
		object({ bytes: "uint8Array" }),
	).materialize();
	const initial = new Uint8Array([10, 20]);
	const pulse = createPulse(
		Definition,
		{ bytes: initial },
		{ scope: createPulseScope() },
	);
	try {
		initial.fill(0);
		const snapshot = snapshotPulse(pulse);
		const bytes: Uint8Array = snapshot.bytes;
		expect(bytes).toEqual(new Uint8Array([10, 20]));
		bytes.fill(255);
		expect(pulse.bytes).toEqual(new Uint8Array([10, 20]));
	} finally {
		destroyPulse(pulse);
	}
});
