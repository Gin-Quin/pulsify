/** Audit complete, repeated native mixed campaigns and compare their medians. */
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing argument or result");
	return value;
}
function paths(flag: string): string[] {
	return argv.flatMap((value, i) =>
		value === flag ? [resolve(required(argv[i + 1]))] : [],
	);
}
type Summary = {
	throughput_per_sec: number;
	service: { p99_ms: number };
	errors: number;
	success: number;
	useful_compactions: number;
	removed_segments: number;
};
type Cell = {
	scenario: string;
	concurrency: number;
	topology: string;
	mode: string;
	summary: Summary;
	events: { job: number; operation: string; error: string | null }[];
	verification: {
		exact_rows: number;
		frames: string[];
		materialized?: boolean;
	}[];
};
type Report = { cells: Cell[]; materializationChecks: number };
const baseline = paths("--baseline");
const candidate = paths("--candidate");
const output = paths("--output")[0];
if (!baseline.length || !candidate.length || !output)
	throw new Error(
		"Use repeated --baseline DIR and --candidate DIR, plus --output FILE.md",
	);
const median = (values: number[]) => {
	const sorted = values.toSorted((a, b) => a - b);
	const n = sorted.length;
	return n % 2
		? required(sorted[n >> 1])
		: (required(sorted[n / 2 - 1]) + required(sorted[n / 2])) / 2;
};
const range = (values: number[]) =>
	`${Math.min(...values)}–${Math.max(...values)}`;
const groups = [];
for (const directories of [baseline, candidate]) {
	const cells = new Map<string, Cell[]>();
	const sourceHashes = new Set<string>();
	const fixtureHashes = new Set<string>();
	let requests = 0;
	let replays = 0;
	let histories = 0;
	for (const directory of directories) {
		const context = await Bun.file(join(directory, "context.json")).json();
		if (!context.completedAt || Object.keys(context.backendFailures).length)
			throw new Error(`Incomplete campaign: ${directory}`);
		sourceHashes.add(context.sourceSha256);
		fixtureHashes.add(context.fixtureSha256);
		for (const backend of context.selectedDatabases) {
			const environment =
				context.command[context.command.indexOf("--environment") + 1];
			const report: Report = await Bun.file(
				join(directory, `${environment}-${backend}.json`),
			).json();
			const expectedCells = context.concurrency.length * 4;
			if (report.cells.length !== expectedCells)
				throw new Error(`Incomplete matrix: ${directory}`);
			if (report.materializationChecks !== report.cells.length * 2)
				throw new Error(`Missing model replay proofs: ${directory}`);
			replays += report.materializationChecks;
			for (const cell of report.cells) {
				const n = context.requests;
				if (
					cell.scenario !== "mixed" ||
					cell.events.length !== n ||
					cell.summary.errors ||
					cell.summary.success !== n
				)
					throw new Error(`Invalid mixed cell: ${directory}`);
				if (
					new Set(cell.events.map((e) => e.job)).size !== n ||
					cell.events.some((e) => e.error !== null)
				)
					throw new Error(`Invalid request records: ${directory}`);
				for (const [op, fraction] of Object.entries({
					write_patch: 0.45,
					read_delta: 0.25,
					write_full: 0.1,
					read_full: 0.1,
					compact: 0.1,
				}))
					if (
						cell.events.filter((e) => e.operation === op).length !==
						n * fraction
					)
						throw new Error(`Wrong mix: ${directory}/${op}`);
				if (cell.verification.filter((v) => v.materialized).length !== 2)
					throw new Error(`Missing model replay proofs: ${directory}`);
				if (cell.verification.some((v) => v.exact_rows < 1 || v.frames.length))
					throw new Error(`Unverified replay: ${directory}`);
				const key = `${environment}/${backend}/${cell.concurrency}/${cell.topology}/${cell.mode}`;
				const values = cells.get(key) ?? [];
				values.push(cell);
				cells.set(key, values);
				requests += n;
				histories += cell.verification.length;
			}
		}
	}
	if (sourceHashes.size !== 1 || fixtureHashes.size !== 1)
		throw new Error(
			"Each comparison group must use one source and fixture hash",
		);
	if (
		[...cells.values()].some((values) => values.length !== directories.length)
	)
		throw new Error("Campaign matrices differ across repetitions");
	groups.push({
		cells,
		sourceHashes: [...sourceHashes],
		fixtureHashes: [...fixtureHashes],
		requests,
		replays,
		histories,
	});
}
const before = required(groups[0]);
const after = required(groups[1]);
if (
	JSON.stringify(before.fixtureHashes) !== JSON.stringify(after.fixtureHashes)
)
	throw new Error("Baseline and candidate fixtures differ");
if (before.cells.size !== after.cells.size)
	throw new Error("Comparison matrices differ");
let md = `# Mixed workload optimization comparison\n\n${baseline.length} baseline runs and ${candidate.length} optimized runs; median completed requests/s per cell. Same fixture SHA-256: \`${before.fixtureHashes[0]}\`. Exact 45/25/10/10/10 mix, durable commits, fresh private database per campaign.\n\n${before.requests + after.requests} audited requests, zero request errors, ${before.replays + after.replays} Pulsify materialization proofs and ${before.histories + after.histories} exact histories.\n\n| Deployment / engine / clients / topology / admission | Before req/s | After req/s | Gain | p99 before → after ms |\n|---|---:|---:|---:|---:|\n`;
let passed = true;
const rows = [];
for (const [key, values] of before.cells) {
	const optimized = after.cells.get(key);
	if (!optimized) throw new Error(`Missing candidate: ${key}`);
	const rate = (v: Cell[]) =>
		median(v.map((c) => c.summary.throughput_per_sec));
	const p99 = (v: Cell[]) => median(v.map((c) => c.summary.service.p99_ms));
	const gain = (rate(optimized) / rate(values) - 1) * 100;
	passed &&= gain >= 30;
	md += `| ${key} | ${rate(values).toFixed(1)} | ${rate(optimized).toFixed(1)} | +${gain.toFixed(1)}% | ${p99(values).toFixed(1)} → ${p99(optimized).toFixed(1)} |\n`;
	rows.push({
		key,
		before: values.map((c) => c.summary),
		after: optimized.map((c) => c.summary),
		gainPercent: gain,
	});
}
md += `\n**Every cell ≥30%: ${passed ? "PASS" : "FAIL"}.**\n\nCompaction is attempted on every scheduled request; useful work varies with races. Useful compactions and removed segments are reported as min–max across repetitions.\n\n| Cell | Useful before → after | Removed segments before → after |\n|---|---:|---:|\n`;
for (const row of rows)
	md += `| ${row.key} | ${range(row.before.map((s) => s.useful_compactions))} → ${range(row.after.map((s) => s.useful_compactions))} | ${range(row.before.map((s) => s.removed_segments))} → ${range(row.after.map((s) => s.removed_segments))} |\n`;
md +=
	"\nThese are finite batches on one workstation. Results characterize these storage adapters and deployments. The jittered SQLite busy handler can trade additional wakeups/CPU for shorter lock waits; no claim is made about long-running capacity or CPU efficiency.\n";
await Bun.write(output, md);
await Bun.write(
	output.replace(/\.md$/, ".json"),
	JSON.stringify({ baseline, candidate, passed, rows }, null, 2),
);
console.log(md);
if (!passed) process.exitCode = 1;
