import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { cpus, release } from "node:os";
import {
	destroyPulse,
	snapshotPulse,
} from "../../packages/pulse/source/index.js";
import { postgresRepository, sqliteRepository } from "./adapters/sql.js";
import {
	applyRows,
	fixture,
	profiles,
	receiver,
	type Fixture,
	type Profile,
} from "./fixtures.js";
import {
	markdown,
	statistics,
	type Measurement,
	type Report,
} from "./report.js";
import { BenchmarkStore } from "./store.js";
import type { SegmentRepository } from "./types.js";

function argument(name: string, fallback: string): string {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : (process.argv[index + 1] ?? "");
}
function integer(name: string, fallback: number, min: number) {
	const value = Number(argument(name, String(fallback)));
	if (!Number.isSafeInteger(value) || value < min || value > 1000)
		throw new Error(`Invalid ${name}`);
	return value;
}
const allowed = new Set([
	"--quick",
	"--help",
	"--samples",
	"--warmup",
	"--databases",
	"--profiles",
	"--output",
	"--markdown",
]);
for (const arg of process.argv.slice(2))
	if (arg.startsWith("--") && !allowed.has(arg))
		throw new Error(`Unknown argument ${arg}`);
if (process.argv.includes("--help")) {
	console.log(
		"Database benchmark: --quick --samples N --warmup N --databases postgres,sqlite --profiles small,medium,large --output PATH --markdown PATH",
	);
	process.exit(0);
}
const quick = process.argv.includes("--quick");
const samples = integer("--samples", quick ? 3 : 12, 1),
	warmup = integer("--warmup", quick ? 1 : 3, 0);
const selectedProfiles = argument(
	"--profiles",
	quick ? "small" : "small,medium,large",
).split(",") as Profile[];
for (const profile of selectedProfiles)
	if (!Object.hasOwn(profiles, profile))
		throw new Error(`Unknown profile ${profile}`);
const databases = argument("--databases", "postgres,sqlite").split(",");
for (const database of databases)
	if (!["postgres", "sqlite"].includes(database))
		throw new Error(`Unknown database ${database}`);
const factories: Record<string, () => Promise<SegmentRepository>> = {
	postgres: () =>
		postgresRepository(
			process.env["PULSIFY_POSTGRES_URL"] ??
				"postgres://postgres:pulsify-benchmark@postgres/pulsify_benchmark",
		),
	sqlite: async () =>
		sqliteRepository(`/tmp/pulsify-bench-${crypto.randomUUID()}.sqlite`),
};
const report: Report = {
	formatVersion: 1,
	environment: {
		startedAt: new Date().toISOString(),
		bun: Bun.version,
		platform: process.platform,
		architecture: process.arch,
		kernel: release(),
		cpu: cpus()[0]?.model,
		logicalCpus: cpus().length,
		commit: process.env["BENCH_COMMIT"] ?? "unknown",
		dirty: process.env["BENCH_DIRTY"] ?? "unknown",
		infrastructure: JSON.parse(
			process.env["BENCH_INFRASTRUCTURE"] ?? "{}",
		) as unknown,
	},
	parameters: {
		samples,
		warmup,
		profiles: selectedProfiles.map((name) => ({ name, ...profiles[name] })),
		databases,
		concurrency: 1,
		compression: "lossless zlib deflate level 6",
		seed: 20261104,
	},
	backends: {},
	measurements: [],
};
function verify(
	f: Fixture,
	rows: Awaited<ReturnType<BenchmarkStore["read"]>>["rows"],
	incremental = false,
) {
	const peer = receiver(f.docId);
	try {
		if (incremental) applyRows(peer, f.prefix);
		applyRows(peer, rows);
		deepStrictEqual(snapshotPulse(peer), f.expected);
	} finally {
		destroyPulse(peer);
	}
}
const scenarios = [
	"write_full",
	"write_patch",
	"read_full",
	"load_full",
	"read_delta",
	"sync_delta",
	"compact",
	"read_full_compacted",
	"read_delta_compacted",
];

for (const database of databases) {
	const repository = await factories[database]!();
	report.backends[database] = repository.metadata;
	const store = new BenchmarkStore(repository);
	try {
		// Initialize the binding before even the first warmup timer.
		await store.vector("benchmark-readiness");
		for (const profile of selectedProfiles) {
			const records = new Map<string, Measurement>(
				scenarios.map((scenario) => [
					scenario,
					{
						backend: database,
						profile,
						scenario,
						warmupMs: [],
						samplesMs: [],
						medianMs: 0,
						p95Ms: 0,
						details: {},
						detailsSamples: [],
					},
				]),
			);
			for (let sample = -warmup; sample < samples; sample++) {
				// Fixture generation and every assertion are outside timed regions.
				const f = fixture(profile);
				async function measure<T>(
					scenario: string,
					work: () => Promise<T>,
				): Promise<T> {
					const start = performance.now();
					const value = await work();
					const elapsed = performance.now() - start;
					const record = records.get(scenario)!;
					(sample < 0 ? record.warmupMs : record.samplesMs).push(elapsed);
					return value;
				}
				await measure("write_full", () => store.append(f.initial));
				deepStrictEqual((await store.read(f.docId)).rows, f.initial);
				await store.append(f.patches.slice(0, -1).flat());
				await measure("write_patch", () => store.append(f.patches.at(-1)!));
				deepStrictEqual(await store.vector(f.docId), f.vector);
				const full = await measure("read_full", () => store.read(f.docId));
				verify(f, full.rows);
				const loaded = await measure("load_full", async () => {
					const peer = receiver(f.docId);
					try {
						const result = await store.read(f.docId);
						applyRows(peer, result.rows);
						return { peer, snapshot: snapshotPulse(peer) };
					} catch (error) {
						destroyPulse(peer);
						throw error;
					}
				});
				try {
					deepStrictEqual(loaded.snapshot, f.expected);
				} finally {
					destroyPulse(loaded.peer);
				}
				const delta = await measure("read_delta", () =>
					store.read(f.docId, f.remote),
				);
				verify(f, delta.rows, true);
				const partial = receiver(f.docId);
				try {
					applyRows(partial, f.prefix);
					const snapshot = await measure("sync_delta", async () => {
						const result = await store.read(f.docId, f.remote);
						applyRows(partial, result.rows);
						return snapshotPulse(partial);
					});
					deepStrictEqual(snapshot, f.expected);
				} finally {
					destroyPulse(partial);
				}
				ok(delta.rows.length < full.rows.length);
				ok(delta.payloadBytes < full.payloadBytes);
				const removed = await measure("compact", () => store.compact(f.docId));
				ok(removed > 0);
				deepStrictEqual(await store.vector(f.docId), f.vector);
				const packed = await measure("read_full_compacted", () =>
					store.read(f.docId),
				);
				verify(f, packed.rows);
				const packedDelta = await measure("read_delta_compacted", () =>
					store.read(f.docId, f.remote),
				);
				verify(f, packedDelta.rows, true);
				deepStrictEqual(packedDelta.rows, delta.rows);
				equal((await store.read(f.docId, f.vector)).rows.length, 0);
				const detail = (value: typeof full) => ({
					rows: value.rows.length,
					segments: value.segments,
					payloadBytes: value.payloadBytes,
				});
				records.get("write_full")!.details = {
					rows: f.initial.length,
					operationBytes: f.initial.reduce(
						(n, row) => n + row.operations.length,
						0,
					),
				};
				records.get("write_patch")!.details = {
					rows: f.patches.at(-1)!.length,
					operationBytes: f.patches
						.at(-1)!
						.reduce((n, row) => n + row.operations.length, 0),
				};
				records.get("read_full")!.details = detail(full);
				records.get("load_full")!.details = detail(full);
				records.get("read_delta")!.details = detail(delta);
				records.get("sync_delta")!.details = detail(delta);
				records.get("read_full_compacted")!.details = detail(packed);
				records.get("read_delta_compacted")!.details = detail(packedDelta);
				records.get("compact")!.details = {
					removedSegments: removed,
					beforePayloadBytes: full.payloadBytes,
					afterPayloadBytes: packed.payloadBytes,
					savedPayloadPercent:
						100 * (1 - packed.payloadBytes / full.payloadBytes),
				};
				if (sample >= 0)
					for (const record of records.values())
						record.detailsSamples.push(record.details);
			}
			for (const record of records.values()) {
				Object.assign(record, statistics(record.samplesMs));
				report.measurements.push(record);
			}
			console.log(
				`${database}/${profile}: ${samples} samples, all replay and vector checks passed`,
			);
		}
	} finally {
		await repository.close();
	}
}
report.environment["completedAt"] = new Date().toISOString();
const output = argument("--output", "benchmarks/results/database.json"),
	md = argument("--markdown", "benchmarks/results/database.md");
for (const path of [output, md])
	await mkdir(dirname(path), { recursive: true });
await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
await Bun.write(md, markdown(report));
console.log(`Reports: ${output} and ${md}`);
