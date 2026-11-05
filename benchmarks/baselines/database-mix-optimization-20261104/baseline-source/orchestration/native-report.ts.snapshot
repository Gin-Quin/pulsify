import { readdir } from "node:fs/promises";
import { join } from "node:path";

type Stats = { p50_ms: number; p95_ms: number; p99_ms: number; max_ms: number };
type Summary = {
	requests: number;
	success: number;
	errors: number;
	throughput_per_sec: number;
	service: Stats;
	queue: Stats;
	latency: Stats;
	retries: number;
	useful_compactions: number;
	noop_compactions: number;
	useful_compactions_per_sec: number;
	removed_segments: number;
};
type Cell = {
	scenario: string;
	topology: string;
	mode: string;
	concurrency: number;
	maximum_active: number;
	seconds: number;
	summary: Summary;
	operations: Record<string, Summary>;
};
type Report = {
	arguments: { backend: string; environment: string; requests: number };
	metadata: Record<string, unknown>;
	cells: Cell[];
	materializationChecks?: number;
};
const directory = process.argv[2]!;
const reports: Report[] = [];
const filenames = (await readdir(directory)).sort();
for (const name of filenames)
	if (
		/^(docker|bare-metal)-.*\.json(?:\.gz)?$/.test(name) &&
		!/-contract\.json(?:\.gz)?$/.test(name)
	) {
		if (name.endsWith(".gz") && filenames.includes(name.slice(0, -3))) continue;
		const file = Bun.file(join(directory, name));
		reports.push(
			name.endsWith(".gz")
				? (JSON.parse(
						new TextDecoder().decode(
							Bun.gunzipSync(new Uint8Array(await file.arrayBuffer())),
						),
					) as Report)
				: ((await file.json()) as Report),
		);
	}
let markdown = "# Native Rust concurrent database benchmark\n\n";
const context = await Bun.file(join(directory, "context.json"))
	.json()
	.catch(() => ({}));
if (context.backendFailures && Object.keys(context.backendFailures).length)
	markdown += `**Incomplete backend matrices:** ${JSON.stringify(context.backendFailures)}\n\n`;
if (context.unsupported && Object.keys(context.unsupported).length)
	markdown += `**Deployments not run:** ${JSON.stringify(context.unsupported)}\n\n`;
markdown +=
	"All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.\n\n";
markdown +=
	"The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.\n\n";
markdown +=
	"These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.\n\n";
markdown +=
	"Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.\n\n";
markdown +=
	"| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |\n|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n";
let cells = 0,
	requests = 0,
	errors = 0;
for (const report of reports)
	for (const cell of report.cells) {
		const s = cell.summary;
		cells++;
		requests += s.requests;
		errors += s.errors;
		markdown += `|${report.arguments.environment}|${report.arguments.backend}|${cell.scenario}|${cell.topology}|${cell.mode}|${cell.concurrency}|${s.throughput_per_sec.toFixed(1)}|${s.service.p50_ms.toFixed(3)}|${s.service.p95_ms.toFixed(3)}|${s.service.p99_ms.toFixed(3)}|${s.latency.p99_ms.toFixed(3)}|${s.errors}|${s.retries}|${s.useful_compactions}/${s.noop_compactions}|\n`;
	}
markdown +=
	"\n## Operations within the mixed workload\n\nPer-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.\n\n";
markdown +=
	"| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |\n|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n";
for (const report of reports)
	for (const cell of report.cells.filter((c) => c.scenario === "mixed"))
		for (const [op, s] of Object.entries(cell.operations))
			markdown += `|${report.arguments.environment}|${report.arguments.backend}|${cell.topology}|${cell.mode}|${cell.concurrency}|${op}|${s.requests}|${s.throughput_per_sec.toFixed(1)}|${s.service.p50_ms.toFixed(3)}|${s.service.p95_ms.toFixed(3)}|${s.service.p99_ms.toFixed(3)}|${s.latency.p99_ms.toFixed(3)}|${s.errors}|${s.retries}|${s.useful_compactions}/${s.noop_compactions}|\n`;
markdown += `\n${cells} completed cells, ${requests} requests, ${errors} errors, ${reports.reduce((n, r) => n + (r.materializationChecks ?? 0), 0)} representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.\n`;
await Bun.write(join(directory, "REPORT.md"), markdown);
console.log(
	`Native campaign report: ${join(directory, "REPORT.md")} (${cells} cells, ${requests} requests, ${errors} errors)`,
);
