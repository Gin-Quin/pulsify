// Diagnostic timers perturb execution; the complete suite remains authoritative.
import { object, array } from "@gin-quin/codec";
import {
	createPulse,
	definePulse,
	createPulseScope,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	exportPulseUpdates,
	applyPulseUpdates,
} from "../packages/pulse/source/index.js";
import { decodeMessage } from "../packages/pulse/source/connection/PulseMessage.js";
import { createRuntime } from "../packages/pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../packages/pulse/source/pulses/PulseOptions.js";
import { fixture } from "./crdt-adapters.js";
if (process.argv.includes("--warm-suite")) {
	const original = process.argv;
	process.argv = [
		original[0]!,
		new URL("./crdt-comparison.ts", import.meta.url).pathname,
		"--output",
		"/tmp/grouped-profile-warm.json",
		"--markdown",
		"/tmp/grouped-profile-warm.md",
	];
	await import("./crdt-comparison.js");
	process.argv = original;
}
const D = definePulse(
	"Comparison",
	object({
		title: "string",
		nested: object({ count: "float64" }),
		items: array(object({ value: "float64", label: "string" })),
	}),
).materialize();
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
const samples: Record<string, number>[] = [];
for (let i = -10; i < 40; i++) {
	const input = fixture(10);
	const a = createPulse(
			D,
			{
				id: input.id,
				title: input.title,
				nested: input.nested,
				items: input.items,
			},
			options(65536),
		),
		b = createRuntime(D, a.id, options(65537)) as typeof a;
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	const ma = getPulseMeta(a),
		mb = getPulseMeta(b);
	for (let j = 1; j <= 100; j++) {
		a.nested.count = j;
		b.title = `offline-${j}`;
	}
	const totals: Record<string, number> = {};
	const time = <T>(key: string, fn: () => T) => {
		const start = performance.now();
		try {
			return fn();
		} finally {
			totals[key] = (totals[key] ?? 0) + (performance.now() - start) * 1000;
		}
	};
	for (const meta of [ma, mb])
		for (const [target, key] of [
			[meta.log, "appendContiguousRun"],
			[meta.model, "validateScalarRun"],
			[meta.model, "apply"],
		] as const) {
			const object = target as any,
				original = object[key];
			object[key] = function (...args: any[]) {
				return time(key, () => original.apply(this, args));
			};
		}
	Bun.gc(true);
	const start = performance.now();
	const va = ma.log.vector,
		vb = mb.log.vector;
	const toA = time("export", () =>
			exportPulseUpdates(b, va, { peerVersion: 2 }),
		),
		toB = time("export", () => exportPulseUpdates(a, vb, { peerVersion: 2 }));
	for (const [meta, frames] of [
		[ma, toA],
		[mb, toB],
	] as const)
		for (const frame of frames) {
			const message = time("decode", () => decodeMessage(frame));
			if (!("rows" in message)) throw Error();
			time("runtime", () => meta.applyRows(message.rows));
		}
	time("snapshot", () => {
		snapshotPulse(a);
		snapshotPulse(b);
	});
	totals["total"] = (performance.now() - start) * 1000;
	if (i >= 0) samples.push(totals);
	destroyPulse(a);
	destroyPulse(b);
}
console.log(
	JSON.stringify(
		Object.fromEntries(
			Object.keys(samples[0]!).map((key) => [
				key,
				samples.map((s) => s[key] ?? 0).sort((a, b) => a - b)[20],
			]),
		),
		null,
		2,
	),
);
