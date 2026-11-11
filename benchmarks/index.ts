import { cpus, arch, platform, release, totalmem } from "node:os";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCodec } from "@gin-quin/codec";
import { Model, s } from "json-joy/lib/json-crdt";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	loadPulse,
	PulseRelay,
	type Connector,
	type Pulse,
	type PulseProperties,
} from "../packages/pulse/source/index";
import {
	decodeMessage,
	encodeMessage,
	PulseMessageSchema,
	type PulseMessage,
} from "../packages/pulse/source/connection/PulseMessage";
import { toNodeBuilder } from "./json-joy-builder";
import {
	decodeOperations,
	encodeOperations,
} from "../packages/pulse/source/connection/PulsePatch";

const args = process.argv.slice(2);
const quick = args.includes("--quick");
const samples = quick ? 8 : 25;
const warmup = quick ? 2 : 5;
const argument = (key: string, fallback: string) => {
	const i = args.indexOf(key);
	return i < 0 ? fallback : (args[i + 1] ?? fallback);
};
const output = resolve(argument("--output", "benchmarks/results/latest.json"));
const filter = argument("--filter", "");
type State = {
	run(): void | Promise<void>;
	dispose?(): void | Promise<void>;
	metrics?: Record<string, number>;
};
type Result = {
	name: string;
	iterations: number;
	sampleMeanUs: { median: number; p95: number; min: number; max: number };
	opsPerSecond: number;
	metrics?: Record<string, number>;
};
const results: Result[] = [];
const percentile = (values: number[], fraction: number) =>
	values[Math.min(values.length - 1, Math.floor(values.length * fraction))]!;
async function benchmark(
	name: string,
	iterations: number,
	prepare: () => State | Promise<State>,
) {
	if (filter && !name.includes(filter)) return;
	const times: number[] = [];
	const metrics: Record<string, number[]> = {};
	for (let sample = -warmup; sample < samples; sample++) {
		const state = await prepare();
		const start = performance.now();
		for (let i = 0; i < iterations; i++) {
			const returned = state.run();
			if (returned) await returned;
		}
		const elapsed = ((performance.now() - start) * 1000) / iterations;
		if (sample >= 0) {
			times.push(elapsed);
			for (const [key, value] of Object.entries(state.metrics ?? {}))
				(metrics[key] ??= []).push(value);
		}
		await state.dispose?.();
	}
	times.sort((a, b) => a - b);
	const median = percentile(times, 0.5);
	results.push({
		name,
		iterations,
		sampleMeanUs: {
			median,
			p95: percentile(times, 0.95),
			min: times[0]!,
			max: times.at(-1)!,
		},
		opsPerSecond: 1_000_000 / median,
		...(Object.keys(metrics).length
			? {
					metrics: Object.fromEntries(
						Object.entries(metrics).map(([key, values]) => [
							key,
							values.reduce((a, b) => a + b, 0) / values.length,
						]),
					),
				}
			: {}),
	});
	console.error(
		`${name}: ${median.toFixed(2)} µs/op (median of ${samples} sample means)`,
	);
}
type Doc = PulseProperties<"Bench"> & {
	title: string;
	nested: { count: number };
	items: { value: number; label: string }[];
};
const Doc = definePulse<Doc>("Bench").materialize();
const input = (size: number) => ({
	id: "benchmark",
	title: "Performance é🌍",
	nested: { count: 0 },
	items: Array.from({ length: size }, (_, i) => ({
		value: i,
		label: `item-${i}`,
	})),
});
const scope = () => ({ scope: createPulseScope(), sessionId: 65536 });
await benchmark("protocol/compile-schema", quick ? 50 : 200, () => ({
	run() {
		createCodec(PulseMessageSchema);
	},
}));
for (const count of [0, 1, 100]) {
	const pulse = createPulse(Doc, input(count), scope());
	const message: PulseMessage =
		count === 0
			? { kind: 1, docId: pulse.id, requestId: 1, vv: [] }
			: {
					kind: 4,
					docId: pulse.id,
					requestId: 1,
					vv: getPulseMeta(pulse).log.vector,
					rows: getPulseMeta(pulse).log.missing([]),
				};
	const binary = encodeMessage(message);
	const iterations = count === 100 ? 200 : 1000;
	await benchmark(`codec/encode/${count}`, iterations, () => ({
		run() {
			encodeMessage(message);
		},
		metrics: { bytes: binary.length },
	}));
	await benchmark(`codec/decode/${count}`, iterations, () => ({
		run() {
			decodeMessage(binary);
		},
		metrics: { bytes: binary.length },
	}));
	if (count) {
		const operations = decodeOperations(
			getPulseMeta(pulse).log.missing([])[0]!.operations,
		);
		const encoded = encodeOperations(operations);
		await benchmark(
			`operations/encode/${count}`,
			count === 100 ? 100 : 500,
			() => ({
				run() {
					encodeOperations(operations);
				},
				metrics: { bytes: encoded.length },
			}),
		);
		await benchmark(
			`operations/decode/${count}`,
			count === 100 ? 100 : 500,
			() => ({
				run() {
					decodeOperations(encoded);
				},
				metrics: { bytes: encoded.length },
			}),
		);
	}
	destroyPulse(pulse);
}
for (const size of [10, 1000]) {
	const values = input(size);
	const stored = { ...values, kind: "Bench", version: 1, generation: 0 };
	await benchmark(`core/create/${size}`, size === 1000 ? 2 : 20, () => {
		const pulses: Pulse<Doc>[] = [];
		return {
			run() {
				pulses.push(createPulse(Doc, values, scope()));
			},
			dispose() {
				for (const pulse of pulses) destroyPulse(pulse);
			},
		};
	});
	await benchmark(`json-joy/create/${size}`, size === 1000 ? 2 : 20, () => {
		const models: Model[] = [];
		return {
			run() {
				const model = Model.create(toNodeBuilder(stored), 65536);
				model.api.flush();
				models.push(model);
			},
			dispose() {
				models.length = 0;
			},
		};
	});
}
await benchmark("core/read-nested", 10000, () => {
	const pulse = createPulse(Doc, input(10), scope());
	let sum = 0;
	return {
		run() {
			sum += pulse.nested.count;
		},
		dispose() {
			if (sum !== 0) throw new Error("Read result changed");
			destroyPulse(pulse);
		},
	};
});
for (const history of [0, 1000, 5000]) {
	await benchmark(`core/mutate/history-${history}`, quick ? 50 : 200, () => {
		const pulse = createPulse(Doc, input(10), scope());
		const nested = pulse.nested;
		for (let i = 1; i <= history; i++) nested.count = i;
		let value = history;
		return {
			run() {
				nested.count = ++value;
			},
			dispose() {
				destroyPulse(pulse);
			},
		};
	});
}
await benchmark("json-joy/mutate", quick ? 50 : 200, () => {
	const model = Model.create(
		toNodeBuilder({ ...input(10), kind: "Bench", version: 1, generation: 0 }),
		65536,
	);
	model.api.flush();
	const nested = model.api.obj(["nested"]);
	let value = 0;
	return {
		run() {
			nested.set({ count: s.con(++value) });
			model.api.flush();
		},
	};
});

for (const latency of [0, 5])
	await benchmark(
		`sync/update/one-way-${latency}ms`,
		latency ? 2 : 10,
		async () => {
			const relay = new PulseRelay();
			let sentBytes = 0;
			let receivedBytes = 0;
			let sentFrames = 0;
			let receivedFrames = 0;
			const memory = createMemoryConnector(relay);
			const connector: Connector = {
				kind: "remote",
				async open(input) {
					const session = await memory.open({
						...input,
						onMessage(bytes) {
							receivedBytes += bytes.length;
							receivedFrames++;
							if (latency) setTimeout(() => input.onMessage(bytes), latency);
							else input.onMessage(bytes);
						},
					});
					return {
						close: session.close,
						async send(bytes) {
							sentBytes += bytes.length;
							sentFrames++;
							if (latency)
								await new Promise((resolve) => setTimeout(resolve, latency));
							await session.send(bytes);
						},
					};
				},
			};
			const a = createPulse(Doc, input(10), {
				...scope(),
				connectors: [connector],
			});
			await connectPulse(a).synced;
			const b = await loadPulse(Doc, a.id, {
				scope: createPulseScope(),
				sessionId: 65537,
				connectors: [connector],
				waitFor: "all",
			});
			sentBytes = receivedBytes = sentFrames = receivedFrames = 0;
			const metrics = {
				sentBytes: 0,
				receivedBytes: 0,
				sentFrames: 0,
				receivedFrames: 0,
			};
			return {
				async run() {
					a.nested.count++;
					await getPulseMeta(a).connections[0]!.syncBack();
					while (b.nested.count !== a.nested.count)
						await new Promise((resolve) => setTimeout(resolve, 0));
					Object.assign(metrics, {
						sentBytes,
						receivedBytes,
						sentFrames,
						receivedFrames,
					});
				},
				metrics,
				dispose() {
					destroyPulse(a);
					destroyPulse(b);
					if (relay.peerCount) throw new Error("Session leak");
				},
			};
		},
	);

for (const size of [10, 1000])
	await benchmark(
		`sync/initial-load/${size}`,
		size === 1000 ? 2 : 10,
		async () => {
			const connector = createMemoryConnector();
			const seed = createPulse(Doc, input(size), {
				...scope(),
				connectors: [connector],
			});
			await connectPulse(seed).synced;
			const loaded: Pulse<Doc>[] = [];
			return {
				async run() {
					const replica = await loadPulse(Doc, seed.id, {
						scope: createPulseScope(),
						connectors: [connector],
						waitFor: "all",
					});
					loaded.push(replica);
					if (replica.items.length !== size)
						throw new Error("Incomplete initial sync");
				},
				dispose() {
					for (const replica of loaded) destroyPulse(replica);
					destroyPulse(seed);
				},
			};
		},
	);
await benchmark("sync/reconnect/100-offline-edits", 1, async () => {
	const connector = createMemoryConnector();
	const a = createPulse(Doc, input(10), {
		...scope(),
		connectors: [connector],
	});
	await connectPulse(a).synced;
	const b = await loadPulse(Doc, a.id, {
		scope: createPulseScope(),
		connectors: [connector],
		waitFor: "all",
	});
	disconnectPulse(a);
	for (let i = 1; i <= 100; i++) a.nested.count = i;
	return {
		async run() {
			await connectPulse(a).synced;
			while (b.nested.count !== 100)
				await new Promise((resolve) => setTimeout(resolve, 0));
		},
		dispose() {
			destroyPulse(a);
			destroyPulse(b);
		},
	};
});

const memory: Record<string, number> = {};
if (!filter || "memory".includes(filter)) {
	Bun.gc(true);
	const before = process.memoryUsage().heapUsed;
	const pulse = createPulse(Doc, input(10), scope());
	const count = quick ? 1000 : 5000;
	for (let i = 0; i < count; i++) pulse.nested.count = i;
	Bun.gc(true);
	memory["historyRows"] = getPulseMeta(pulse).log.size;
	memory["historyHeapBytes"] = process.memoryUsage().heapUsed - before;
	destroyPulse(pulse);
	Bun.gc(true);
	const baseline = process.memoryUsage().heapUsed;
	for (let i = 0; i < 1000; i++) {
		const value = createPulse(Doc, input(10), scope());
		destroyPulse(value);
	}
	Bun.gc(true);
	memory["lifecycleHeapDeltaBytes"] = process.memoryUsage().heapUsed - baseline;
}
const git = (args: string[]) =>
	Bun.spawnSync(["git", ...args], { stdout: "pipe" })
		.stdout.toString()
		.trim();
const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	commit: git(["rev-parse", "HEAD"]),
	dirty: !!git(["status", "--porcelain"]),
	environment: {
		runtime: `bun-${Bun.version}`,
		codec: "2.1.0",
		jsonJoy: "18.28.0",
		platform: platform(),
		release: release(),
		arch: arch(),
		cpu: cpus()[0]?.model,
		cores: cpus().length,
		totalMemoryBytes: totalmem(),
	},
	parameters: {
		samples,
		warmup,
		quick,
		filter,
		creationTiming: "fixtures and cleanup outside timing",
		mutationTiming: "cached nested handles; equal iteration counts",
		initialLoadTiming: "receiver cleanup outside timing",
	},
	results,
	memory,
};
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
