import { array, object } from "@gin-quin/codec";
import { isDeepStrictEqual } from "node:util";
import { arch, cpus, platform } from "node:os";
import { createReplica, fixture } from "./crdt-adapters.js";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
} from "../packages/pulse/source/index.js";
import { createRuntime } from "../packages/pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../packages/pulse/source/pulses/PulseOptions.js";
import {
	decodeMessage,
	encodeMessage,
} from "../packages/pulse/source/connection/PulseMessage.js";
import { chunkRows } from "../packages/pulse/source/protocol/chunkRows.js";
import type { PulseMeta } from "../packages/pulse/source/pulses/PulseMeta.js";
import type { PulseVersionVector } from "../packages/pulse/source/connection/PulseVersionVector.js";

// Diagnostic only: identical fixture, 100 commits per peer, fresh peers/sample.
// Nested timers perturb execution; use crdt-comparison.ts for authoritative times.
const definition = definePulse(
	"Comparison",
	object({
		title: "string",
		nested: object({ count: "float64" }),
		items: array(object({ value: "float64", label: "string" })),
	}),
).materialize();
const input = fixture(10);
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
const samples: Record<string, number>[] = [];
let totals: Record<string, number> = {};
function timed<T>(name: string, run: () => T): T {
	const start = performance.now();
	try {
		return run();
	} finally {
		totals[name] = (totals[name] ?? 0) + (performance.now() - start) * 1000;
	}
}
function hook(target: object, key: string, name: string): void {
	const methods = target as Record<string, (...args: any[]) => any>;
	const original = methods[key]!;
	methods[key] = function (...args: any[]) {
		return timed(name, () => original.apply(this, args));
	};
}
function instrument(meta: PulseMeta): void {
	hook(meta.model, "validate", "preflight-inclusive");
	hook(meta.model, "build", "build-inclusive");
	hook(meta.model, "apply", "apply");
	hook(meta.log, "appendRemoteRows", "journal-inclusive");
	hook(meta.model.encoding, "encode", "value-encode");
	hook(meta.model.encoding, "decode", "value-decode");
}
function encode(meta: PulseMeta, vv: PulseVersionVector) {
	const rows = timed("missing-rows", () => meta.log.missing(vv));
	return timed("envelope-encode", () =>
		chunkRows(rows).map((chunk) =>
			encodeMessage({
				kind: 4,
				docId: meta.id,
				requestId: 0,
				vv: meta.log.vector,
				rows: chunk,
			}),
		),
	);
}
function apply(meta: PulseMeta, frames: Uint8Array[]) {
	for (const frame of frames) {
		const message = timed("envelope-decode", () => decodeMessage(frame));
		if (message.kind !== 4) throw new Error("Expected update");
		timed("apply-rows-inclusive", () => meta.applyRows(message.rows));
	}
}
for (let sample = -5; sample < 25; sample++) {
	Bun.gc(true);
	const a = createPulse(
		definition,
		{
			id: input.id,
			title: input.title,
			nested: input.nested,
			items: input.items,
		},
		options(65536),
	);
	const b = createRuntime(definition, input.id, options(65537));
	const ma = getPulseMeta(a),
		mb = getPulseMeta(b);
	apply(mb, encode(ma, []));
	for (let i = 1; i <= 100; i++) {
		a.nested.count = i;
		b["title"] = `offline-${i}`;
	}
	instrument(ma);
	instrument(mb);
	Bun.gc(true);
	totals = {};
	const start = performance.now();
	const va = timed("vectors", () => ma.log.vector),
		vb = timed("vectors", () => mb.log.vector);
	const toA = encode(mb, va),
		toB = encode(ma, vb);
	apply(ma, toA);
	apply(mb, toB);
	const sa = timed("snapshots", () => snapshotPulse(a)),
		sb = timed("snapshots", () => snapshotPulse(b));
	totals["total"] = (performance.now() - start) * 1000;
	totals["bytes"] = [...toA, ...toB].reduce(
		(sum, frame) => sum + frame.length,
		0,
	);
	totals["journal-exclusive"] =
		totals["journal-inclusive"]! - totals["preflight-inclusive"]!;
	totals["preflight-exclusive"] =
		totals["preflight-inclusive"]! - (totals["build-inclusive"] ?? 0);
	totals["patch-decode-and-runtime"] =
		totals["apply-rows-inclusive"]! -
		totals["journal-inclusive"]! -
		totals["apply"]!;
	if (
		!isDeepStrictEqual(sa, sb) ||
		sa.nested.count !== 100 ||
		sa.title !== "offline-100"
	)
		throw new Error("Lost offline edits");
	if (sample >= 0) samples.push(totals);
	destroyPulse(a);
	destroyPulse(b);
}
const medians = Object.fromEntries(
	Object.keys(samples[0]!).map((key) => [
		key,
		samples.map((sample) => sample[key] ?? 0).sort((a, b) => a - b)[12],
	]),
);
const report = {
	diagnostic: true,
	scenario: "offline-merge/100-per-peer",
	generatedAt: new Date().toISOString(),
	runtime: Bun.version,
	environment: { arch: arch(), platform: platform(), cpu: cpus()[0]?.model },
	parameters: {
		samples: 25,
		warmup: 5,
		fixtureVersion: 1,
		commitsPerPeer: 100,
	},
	samples,
	medians,
};
console.log(JSON.stringify(medians, null, 2));

// Independent high-level phase view for native json-joy; no Pulsify internals.
const comparator: Record<string, number>[] = [];
for (let sample = -5; sample < 25; sample++) {
	const a = createReplica("json-joy", input),
		b = createReplica("json-joy", undefined, 65537);
	b.importFull(a.exportFull());
	for (let i = 1; i <= 100; i++) {
		a.setCount(i);
		b.setTitle(`offline-${i}`);
	}
	Bun.gc(true);
	totals = {};
	const start = performance.now();
	const va = timed("vectors", () => a.checkpoint()),
		vb = timed("vectors", () => b.checkpoint());
	const toA = timed("exports", () => b.exportSince(va)),
		toB = timed("exports", () => a.exportSince(vb));
	timed("imports", () => {
		a.importDelta(toA);
		b.importDelta(toB);
	});
	const sa = timed("snapshots", () => a.snapshot()),
		sb = timed("snapshots", () => b.snapshot());
	totals["total"] = (performance.now() - start) * 1000;
	totals["bytes"] = toA.bytes + toB.bytes;
	if (!isDeepStrictEqual(sa, sb)) throw new Error("Comparator divergence");
	va.dispose();
	vb.dispose();
	a.dispose();
	b.dispose();
	if (sample >= 0) comparator.push(totals);
}
const comparatorMedians = Object.fromEntries(
	Object.keys(comparator[0]!).map((key) => [
		key,
		comparator.map((sample) => sample[key]!).sort((a, b) => a - b)[12],
	]),
);
console.log("json-joy diagnostic", JSON.stringify(comparatorMedians, null, 2));
const output = process.argv[2];
if (output)
	await Bun.write(
		output,
		JSON.stringify(
			{
				...report,
				comparator: {
					participant: "json-joy",
					samples: comparator,
					medians: comparatorMedians,
				},
			},
			null,
			2,
		) + "\n",
	);
