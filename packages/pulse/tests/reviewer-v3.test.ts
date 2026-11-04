import { expect, test } from "bun:test";
import { map, object } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { MAX_LOG_ROWS } from "../source/protocol/PatchLog.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});

test("reviewer v3: float32 root map keeps managed metadata outside its element layout", () => {
	const definition = definePulse(
		"ReviewRootMapFloat",
		map("float32"),
	).materialize();
	const source = createPulse(definition, { count: 1 / 3 }, options(65536));
	const metadata = getPulseMeta(source);
	const peer = createRuntime(definition, metadata.id, options(65537));
	try {
		expect(source.id).toBe(metadata.id);
		expect(source.kind).toBe("ReviewRootMapFloat");
		getPulseMeta(peer).applyRows(metadata.log.missing([]));
		expect(snapshotPulse(peer)).toEqual(snapshotPulse(source));
	} finally {
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("reviewer v3: rich-text root map keeps managed metadata as plain primitives", () => {
	const definition = definePulse("ReviewRootMapText", map("string"), {
		richTextPaths: [["*"]],
	}).materialize();
	const source = createPulse(definition, { title: "Hello" }, options(65536));
	try {
		expect(source.id).toBe(getPulseMeta(source).id);
		expect(source.kind).toBe("ReviewRootMapText");
		expect(source["title"]!.text).toBe("Hello");
	} finally {
		destroyPulse(source);
	}
});

test("reviewer v3: an attributed rich-text insertion rejects a full history atomically", () => {
	const definition = definePulse(
		"ReviewTextQuota",
		object({ count: "uint", body: "string" }),
		{ richTextPaths: [["body"]] },
	).materialize();
	const pulse = createPulse(
		definition,
		{ count: 0, body: "a" },
		options(65536),
	);
	try {
		for (let count = 1; count < MAX_LOG_ROWS - 1; count++) pulse.count = count;
		const meta = getPulseMeta(pulse);
		expect(meta.log.size).toBe(MAX_LOG_ROWS - 1);
		pulse.body.insert(1, "b", { bold: true });
		expect(meta.log.size).toBe(MAX_LOG_ROWS);
		expect(pulse.body.toDelta()).toEqual([
			{ insert: "a" },
			{ insert: "b", attributes: { bold: true } },
		]);
		const before = snapshotPulse(pulse),
			vector = meta.log.vector;
		expect(() => pulse.body.insert(2, "c", { italic: true })).toThrow(
			"history limit",
		);
		expect(snapshotPulse(pulse)).toEqual(before);
		expect(meta.log.vector).toEqual(vector);
		expect(meta.log.size).toBe(MAX_LOG_ROWS);
	} finally {
		destroyPulse(pulse);
	}
});
