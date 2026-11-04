import { cpus, arch, platform, release } from "node:os";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	createReplica,
	fixture,
	type Data,
	type Engine,
	type Packet,
	type Replica,
} from "./crdt-adapters";

const args = process.argv.slice(2);
const argument = (key: string, fallback: string) => {
	const i = args.indexOf(key);
	return i < 0 ? fallback : (args[i + 1] ?? fallback);
};
const quick = args.includes("--quick");
const samples = quick ? 8 : 25;
const warmup = quick ? 2 : 5;
const filter = argument("--filter", "");
const output = resolve(
	argument("--output", "benchmarks/results/crdt-comparison.json"),
);
const markdown = resolve(
	argument("--markdown", "benchmarks/CRDT-COMPARISON.md"),
);
const seed = 0x51f15e;
let randomState = seed;
function shuffled<T>(values: readonly T[]): T[] {
	const result = [...values];
	for (let i = result.length - 1; i > 0; i--) {
		randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
		const j = randomState % (i + 1);
		[result[i], result[j]] = [result[j]!, result[i]!];
	}
	return result;
}
type Participant = {
	label: string;
	engine: Engine;
	direct?: boolean;
	v1?: boolean;
};
const engines: Participant[] = [
	{ label: "pulsify", engine: "pulsify" },
	{ label: "json-joy", engine: "json-joy" },
	{ label: "yjs-v2", engine: "yjs" },
	{ label: "loro", engine: "loro" },
];
const formats: Participant[] = [
	...engines,
	{ label: "yjs-v1", engine: "yjs", v1: true },
];
const layers: Participant[] = [
	{ label: "native-json-joy", engine: "json-joy" },
	{ label: "pulsify-direct", engine: "pulsify", direct: true },
	{ label: "pulsify-proxy", engine: "pulsify" },
];
const create = (participant: Participant, data?: Data, actor = 65536) =>
	createReplica(
		participant.engine,
		data,
		actor,
		participant.direct ?? false,
		participant.v1 ?? false,
	);
const assert = (condition: boolean, message: string) => {
	if (!condition) throw new Error(message);
};
const same = (a: unknown, b: unknown) =>
	assert(
		isDeepStrictEqual(a, b),
		"Benchmark replicas did not converge to the expected data",
	);
type State = {
	run(): void;
	verify(): void;
	dispose(): void;
	metrics?: Record<string, number>;
};
type Result = {
	name: string;
	scenario: string;
	participant: string;
	iterations: number;
	sampleMeanUs: { median: number; p95: number; min: number; max: number };
	opsPerSecond: number;
	metrics?: Record<string, number>;
};
const results: Result[] = [];
const descriptions: Record<string, string> = {};
function benchmark(
	scenario: string,
	description: string,
	participants: Participant[],
	iterations: number,
	prepare: (participant: Participant) => State,
): void {
	if (filter && !scenario.includes(filter)) return;
	descriptions[scenario] = description;
	const collected = new Map(
		participants.map((participant) => [
			participant.label,
			{ times: [] as number[], metrics: {} as Record<string, number[]> },
		]),
	);
	for (let sample = -warmup; sample < samples; sample++)
		for (const participant of shuffled(participants)) {
			Bun.gc(true);
			const state = prepare(participant);
			try {
				Bun.gc(true);
				const start = performance.now();
				for (let i = 0; i < iterations; i++) state.run();
				const time = ((performance.now() - start) * 1000) / iterations;
				state.verify();
				if (sample >= 0) {
					const data = collected.get(participant.label)!;
					data.times.push(time);
					for (const [key, value] of Object.entries(state.metrics ?? {}))
						(data.metrics[key] ??= []).push(value);
				}
			} finally {
				state.dispose();
			}
		}
	for (const participant of participants) {
		const data = collected.get(participant.label)!;
		data.times.sort((a, b) => a - b);
		const percentile = (p: number) =>
			data.times[
				Math.min(data.times.length - 1, Math.floor(data.times.length * p))
			]!;
		const median = percentile(0.5);
		const metrics = Object.fromEntries(
			Object.entries(data.metrics).map(([key, values]) => [
				key,
				values.reduce((a, b) => a + b, 0) / values.length,
			]),
		);
		results.push({
			name: `crdt/${scenario}/${participant.label}`,
			scenario,
			participant: participant.label,
			iterations,
			sampleMeanUs: {
				median,
				p95: percentile(0.95),
				min: data.times[0]!,
				max: data.times.at(-1)!,
			},
			opsPerSecond: 1_000_000 / median,
			...(Object.keys(metrics).length ? { metrics } : {}),
		});
		console.error(
			`${scenario}/${participant.label}: ${median.toFixed(2)} µs/op`,
		);
	}
}

for (const size of [10, 1000])
	for (const encoded of [false, true]) {
		const input = fixture(size);
		benchmark(
			`${encoded ? "create+encode" : "create"}/${size}`,
			`Create an editable ${size}-item graph${encoded ? " and export a transferable initial state" : ""}; cleanup is outside timing.`,
			encoded ? formats : engines,
			size === 1000 ? 2 : 20,
			(participant) => {
				const replicas: Replica[] = [];
				const metrics = { bytes: 0 };
				let totalBytes = 0;
				return {
					run() {
						const replica = create(participant, input);
						replicas.push(replica);
						if (encoded) totalBytes += replica.exportFull().bytes;
					},
					verify() {
						same(replicas.at(-1)!.snapshot(), input);
						if (encoded) metrics.bytes = totalBytes / replicas.length;
					},
					dispose() {
						for (const replica of replicas) replica.dispose();
					},
					...(encoded ? { metrics } : {}),
				};
			},
		);
	}
for (const repeated of [false, true])
	benchmark(
		`export-${repeated ? "repeat" : "first"}/1000`,
		`Export a prepared 1000-item document ${repeated ? "after one untimed export, without any edit" : "for the first time"}; construction, import verification and cleanup are outside timing.`,
		formats,
		1,
		(participant) => {
			const input = fixture(1000);
			const replica = create(participant, input);
			if (repeated) replica.exportFull();
			let exported: Packet;
			const metrics = { bytes: 0 };
			return {
				run() {
					exported = replica.exportFull();
					metrics.bytes = exported.bytes;
				},
				verify() {
					const receiver = create(participant, undefined, 65537);
					try {
						receiver.importFull(exported);
						same(receiver.snapshot(), input);
						same(replica.snapshot(), input);
					} finally {
						receiver.dispose();
					}
				},
				metrics,
				dispose() {
					replica.dispose();
				},
			};
		},
	);

function read(participant: Participant): State {
	const replica = create(participant, fixture(10));
	replica.readCount();
	let sum = 0;
	return {
		run() {
			sum += replica.readCount();
		},
		verify() {
			assert(sum === 0, "Read checksum");
		},
		dispose() {
			replica.dispose();
		},
	};
}
benchmark(
	"read-count/10",
	"Read a cached editable nested count; initial container lookup is outside timing.",
	engines,
	10000,
	read,
);
function mutate(participant: Participant, history: number): State {
	const replica = create(participant, fixture(10));
	for (let i = 1; i <= history; i++) replica.setCount(i);
	replica.readCount();
	let value = history;
	return {
		run() {
			replica.setCount(++value);
		},
		verify() {
			assert(replica.readCount() === value, "Mutation checksum");
		},
		dispose() {
			replica.dispose();
		},
	};
}
for (const history of [0, 1000, 5000])
	benchmark(
		`mutate/history-${history}`,
		"One committed count update through each library's default local API; Pulsify retains its native patch without encoding. Encoding is measured separately in edit+encode.",
		engines,
		quick ? 50 : 200,
		(participant) => mutate(participant, history),
	);
benchmark(
	"list-append/10",
	"Append a new editable two-field object to the list and commit once per append (adapted from B1.8; objects replace upstream's numbers).",
	engines,
	quick ? 20 : 100,
	(participant) => {
		const replica = create(participant, fixture(10));
		let value = 10;
		return {
			run() {
				replica.append({ value, label: `item-${value++}` });
			},
			verify() {
				const data = replica.snapshot();
				assert(
					data.items.length === value && data.items.at(-1)!.value === value - 1,
					"Append checksum",
				);
			},
			dispose() {
				replica.dispose();
			},
		};
	},
);
benchmark(
	"edit+encode/10",
	"Capture a version, commit one count edit, encode its incremental update; verify all encoded packets on a peer outside timing.",
	formats,
	quick ? 20 : 100,
	(participant) => {
		const a = create(participant, fixture(10));
		const b = create(participant, undefined, 65537);
		b.importFull(a.exportFull());
		const updates: Packet[] = [];
		const metrics = { bytes: 0 };
		let value = 0;
		let totalBytes = 0;
		return {
			run() {
				const version = a.checkpoint();
				try {
					a.setCount(++value);
					const update = a.exportSince(version);
					totalBytes += update.bytes;
					updates.push(update);
				} finally {
					version.dispose();
				}
			},
			verify() {
				for (const update of updates) b.importDelta(update);
				same(a.snapshot(), b.snapshot());
				metrics.bytes = totalBytes / updates.length;
			},
			metrics,
			dispose() {
				a.dispose();
				b.dispose();
			},
		};
	},
);
for (const size of [10, 1000])
	benchmark(
		`delta-roundtrip/${size}`,
		"Version-vector capture + edit + delta encoding + peer import + peer count read; synchronous CPU-only, without transport or acknowledgement.",
		formats,
		size === 1000 ? (quick ? 2 : 5) : quick ? 10 : 50,
		(participant) => {
			const a = create(participant, fixture(size));
			const b = create(participant, undefined, 65537);
			b.importFull(a.exportFull());
			a.readCount();
			b.readCount();
			let value = 0;
			let count = 0;
			let totalBytes = 0;
			const metrics = { bytes: 0 };
			return {
				run() {
					const version = b.checkpoint();
					try {
						a.setCount(++value);
						const update = a.exportSince(version);
						totalBytes += update.bytes;
						b.importDelta(update);
						assert(b.readCount() === value, "Delta not applied");
						count++;
					} finally {
						version.dispose();
					}
				},
				verify() {
					same(a.snapshot(), b.snapshot());
					metrics.bytes = totalBytes / count;
				},
				metrics,
				dispose() {
					a.dispose();
					b.dispose();
				},
			};
		},
	);
for (const size of [10, 1000])
	benchmark(
		`initial-load+materialize/${size}`,
		"Construct an empty replica, import an initial state and materialize a detached JSON view. Export is prepared outside timing; cleanup is outside timing.",
		formats,
		size === 1000 ? 2 : 10,
		(participant) => {
			const input = fixture(size);
			const seed = create(participant, input);
			const full = seed.exportFull();
			const loaded: Replica[] = [];
			let last: Data | undefined;
			return {
				run() {
					const replica = create(participant, undefined, 65537);
					loaded.push(replica);
					replica.importFull(full);
					last = replica.snapshot();
				},
				verify() {
					same(last, input);
				},
				metrics: { bytes: full.bytes },
				dispose() {
					seed.dispose();
					for (const replica of loaded) replica.dispose();
				},
			};
		},
	);
benchmark(
	"offline-merge/100-per-peer",
	"Two initialized peers make 100 committed offline edits each; time vector capture, two-way delta encode/import and materialization. Edits are outside timing.",
	formats,
	1,
	(participant) => {
		const a = create(participant, fixture(10));
		const b = create(participant, undefined, 65537);
		b.importFull(a.exportFull());
		for (let i = 1; i <= 100; i++) {
			a.setCount(i);
			b.setTitle(`offline-${i}`);
		}
		let sa: Data | undefined;
		let sb: Data | undefined;
		const metrics = { bytes: 0 };
		return {
			run() {
				const va = a.checkpoint();
				const vb = b.checkpoint();
				try {
					const toA = b.exportSince(va);
					const toB = a.exportSince(vb);
					metrics.bytes = toA.bytes + toB.bytes;
					a.importDelta(toA);
					b.importDelta(toB);
					sa = a.snapshot();
					sb = b.snapshot();
				} finally {
					va.dispose();
					vb.dispose();
				}
			},
			verify() {
				same(sa, sb);
				assert(
					sa!.nested.count === 100 && sa!.title === "offline-100",
					"Offline edits lost",
				);
			},
			metrics,
			dispose() {
				a.dispose();
				b.dispose();
			},
		};
	},
);
benchmark(
	"upstream-map-conflict/16-peers",
	"Adapted B3.1: 16 peers sharing a baseline concurrently update one map key; time importing all deltas and materializing one peer. Setup/encoding and a reference merge are outside timing.",
	formats,
	1,
	(participant) => {
		const seed = create(participant, fixture(10));
		const full = seed.exportFull();
		const peers = Array.from({ length: 16 }, (_, i) =>
			create(participant, undefined, 65537 + i),
		);
		for (const peer of peers) peer.importFull(full);
		const base = peers[0]!.checkpoint();
		const updates: Packet[] = [];
		try {
			for (let i = 0; i < peers.length; i++) {
				peers[i]!.setCount(i + 1);
				updates.push(peers[i]!.exportSince(base));
			}
		} finally {
			base.dispose();
		}
		const reference = create(participant, undefined, 65600);
		reference.importFull(full);
		for (const update of [...updates].reverse()) reference.importDelta(update);
		const expected = reference.snapshot();
		let observed: Data | undefined;
		return {
			run() {
				for (const update of updates) peers[0]!.importDelta(update);
				observed = peers[0]!.snapshot();
			},
			verify() {
				same(observed, expected);
				assert(
					observed!.nested.count >= 1 && observed!.nested.count <= 16,
					"Conflict resolution failed",
				);
			},
			metrics: {
				bytes: updates.reduce((sum, update) => sum + update.bytes, 0),
			},
			dispose() {
				seed.dispose();
				reference.dispose();
				for (const peer of peers) peer.dispose();
			},
		};
	},
);
benchmark(
	"proxy-overhead/read-count",
	"Same cached nested field, native API versus the Pulsify pipeline bypassing proxies versus the public proxy.",
	layers,
	10000,
	read,
);
for (const history of [0, 1000, 5000])
	benchmark(
		`proxy-overhead/mutate-history-${history}`,
		"Native json-joy versus identical Pulsify commit/native-journal pipeline with and without proxy traps; no encoding during local writes, encoded rows are verified identical after export.",
		layers,
		quick ? 50 : 200,
		(participant) => mutate(participant, history),
	);

const version = async (name: string) =>
	(
		await Bun.file(
			new URL(`./node_modules/${name}/package.json`, import.meta.url),
		).json()
	).version as string;
const git = (arguments_: string[]) =>
	Bun.spawnSync(["git", ...arguments_])
		.stdout.toString()
		.trim();
const report = {
	schemaVersion: 2,
	suite: "crdt-comparison",
	generatedAt: new Date().toISOString(),
	commit: git(["rev-parse", "HEAD"]),
	dirty: !!git(["status", "--porcelain"]),
	environment: {
		runtime: `bun-${Bun.version}`,
		codec: "2.1.0",
		jsonJoy: await version("json-joy"),
		yjs: await version("yjs"),
		loro: await version("loro-crdt"),
		loroBackend: "wasm-nodejs",
		platform: platform(),
		release: release(),
		arch: arch(),
		cpu: cpus()[0]?.model,
		cores: cpus().length,
	},
	parameters: {
		samples,
		warmup,
		quick,
		filter,
		seed,
		fixtureVersion: 1,
		defaultYjsFormat: "V2",
		gcBeforeSamples: true,
		ordering: "seeded shuffled engine blocks",
	},
	descriptions,
	results,
	memory: {},
};
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
const { renderComparison } = await import("./crdt-report");
await mkdir(dirname(markdown), { recursive: true });
await Bun.write(markdown, renderComparison(report));
console.log(
	JSON.stringify({ report: output, markdown, cases: results.length }),
);
