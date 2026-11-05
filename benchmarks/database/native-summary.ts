/** Summarize completed, failed and interrupted phases without merging fresh probes into a full series. */
import { readdir, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

type Stats = { p99_ms: number };
type Summary = {
	requests: number;
	errors: number;
	throughput_per_sec: number;
	service: Stats;
	latency: Stats;
	useful_compactions: number;
	noop_compactions: number;
};
type Cell = {
	scenario: string;
	topology: string;
	mode: string;
	concurrency: number;
	maximum_active: number;
	summary: Summary;
	verification: unknown[];
	events: unknown[];
};
type Report = {
	arguments: {
		backend: string;
		environment: string;
		requests: number;
		concurrency: string;
		scenarios: string;
		topologies: string;
		modes: string;
	};
	cells: Cell[];
	materializationChecks?: number;
};
type Entry = {
	phase: string;
	directory: string;
	name: string;
	report: Report;
	expected: number;
};
const root = resolve(
	process.argv[2] ?? "benchmarks/baselines/database-engines-20261104",
);
const entries: Entry[] = [];
async function readDirectory(directory: string, phase: string) {
	const names = await readdir(join(root, directory)).catch(
		() => [] as string[],
	);
	for (const name of names.sort()) {
		if (
			!/^(docker|bare-metal)-.*\.json(?:\.gz)?$/.test(name) ||
			/-contract\.json/.test(name)
		)
			continue;
		if (name.endsWith(".gz") && names.includes(name.slice(0, -3))) continue;
		const file = Bun.file(join(root, directory, name));
		const report = (
			name.endsWith(".gz")
				? JSON.parse(
						new TextDecoder().decode(
							Bun.gunzipSync(new Uint8Array(await file.arrayBuffer())),
						),
					)
				: await file.json()
		) as Report;
		const a = report.arguments;
		const expected = [a.concurrency, a.scenarios, a.topologies, a.modes].reduce(
			(n, value) => n * value.split(",").length,
			1,
		);
		for (const c of report.cells) {
			if (c.events.length !== a.requests || c.summary.requests !== a.requests)
				throw new Error(`Incomplete event list: ${directory}/${name}`);
		}
		entries.push({ phase, directory, name, report, expected });
	}
}
await readDirectory("medium", "medium");
await readDirectory("large", "large");
await readDirectory("large-docker", "large");
for (const name of await readdir(join(root, "supplemental")).catch(
	() => [] as string[],
))
	await readDirectory(`supplemental/${name}`, "fresh probe");
if (!entries.length) throw new Error("No native database reports found");
const main = entries.filter((e) => e.phase !== "fresh probe"),
	probes = entries.filter((e) => e.phase === "fresh probe");
const names: Record<string, string> = {
	postgres: "PostgreSQL",
	sqlite: "SQLite",
	alloydb: "AlloyDB Omni",
	orioledb: "OrioleDB",
	"pgrust-row": "pgrust row",
	"pgrust-columnar": "pgrust columnar",
};
const deployments = ["bare-metal", "docker"];
const pairs = deployments.flatMap((environment) =>
	Object.keys(names)
		.filter(
			(db) => environment === "docker" || !["alloydb", "orioledb"].includes(db),
		)
		.map((backend) => ({ environment, backend })),
);
const label = (env: string) =>
	env === "docker" ? "Docker Linux" : "macOS native";
function cell(
	phase: string,
	environment: string,
	backend: string,
	scenario = "mixed",
	topology = "hot",
	mode = "saturation",
	concurrency = phase === "large" ? 128 : 64,
) {
	return main
		.find(
			(e) =>
				e.phase === phase &&
				e.report.arguments.environment === environment &&
				e.report.arguments.backend === backend,
		)
		?.report.cells.find(
			(c) =>
				c.scenario === scenario &&
				c.topology === topology &&
				c.mode === mode &&
				c.concurrency === concurrency,
		);
}
const perf = (c?: Cell) =>
	c
		? `${c.summary.throughput_per_sec.toFixed(1)} / ${c.summary.service.p99_ms.toFixed(1)}${c.summary.errors ? ` (${c.summary.errors} errors)` : ""}`
		: "not completed";
const totals = (es: Entry[]) => ({
	cells: es.reduce((n, e) => n + e.report.cells.length, 0),
	requests: es.reduce(
		(n, e) => n + e.report.cells.reduce((m, c) => m + c.summary.requests, 0),
		0,
	),
	errors: es.reduce(
		(n, e) => n + e.report.cells.reduce((m, c) => m + c.summary.errors, 0),
		0,
	),
	replays: es.reduce((n, e) => n + (e.report.materializationChecks ?? 0), 0),
	exactHistories: es.reduce(
		(n, e) => n + e.report.cells.reduce((m, c) => m + c.verification.length, 0),
		0,
	),
});
const attempts = (await Bun.file(join(root, "supplemental/attempts.json"))
	.json()
	.catch(() => [])) as {
	operation: string;
	topology: string;
	mode: string;
	environment: string;
	code: number;
	guard: string | null;
}[];
const status = {
	freshAttemptGroups: attempts.length,
	failedFreshAttemptGroups: attempts.filter((a) => a.code !== 0).length,
	main: totals(main),
	freshProbes: totals(probes),
	completedMatrices: main.filter((e) => e.report.cells.length === e.expected)
		.length,
	reportedMatrices: main.length,
	plannedMatrices: 20,
	plannedMainRequests: 960000,
};
let md = `# Database engine load summary — 2026-11-04\n\n${status.main.cells} checkpointed main cells, ${status.main.requests.toLocaleString("en-US")} requests, **${status.main.errors} recorded request errors**, ${status.main.replays} Pulsify model replays and ${status.main.exactHistories.toLocaleString("en-US")} exact storage histories. ${status.completedMatrices}/${status.plannedMatrices} main matrices completed. Fresh recovery probes are counted separately.\n\n**Counts include completed cells only.** Requests interrupted before a cell checkpoint are not counted as successes or zero errors. Fatal backend failures and the host reboot are recorded in the phase contexts, container states and [intervention log](INTERVENTIONS.md). The native columnar incident has [separate diagnostics](columnar-memory-incident.json).\n\nThe mix is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads and 10% compaction attempts. Every checkpointed cell has 1,000 requests. All measured clients are Rust, with real Pulsify fixture/replay verification.\n\nMedium: 64 paragraphs, 100 prior edits, 1/16/64 clients. Large: 256 paragraphs, 1,000 prior edits, 128 clients. Medium Docker was uncapped; after the native large memory incident and reboot, large Docker uses **4 GiB RAM and no swap per test container**. Native uses OS/default engine memory management. These profiles are not one continuous scaling curve.\n\n## Matrix status\n\n| Profile | Deployment | Engine | Completed cells | Recorded request errors | Pulsify replays |\n|---|---|---|---:|---:|---:|\n`;
for (const e of main) {
	const a = e.report.arguments;
	md += `|${e.phase}|${label(a.environment)}|${names[a.backend]}|${e.report.cells.length}/${e.expected}|${totals([e]).errors}|${e.report.materializationChecks ?? 0}|\n`;
}
md +=
	"\n## Large mixed load: 128 clients, hot scope, saturation\n\nSuccessful requests/s and service p99. A missing score means the full series did not reach this cell; fresh probes below are not silently substituted.\n\n| Deployment | Engine | req/s / p99 ms | errors | useful/noop compactions | observed active |\n|---|---|---:|---:|---:|---:|\n";
for (const p of pairs) {
	const c = cell("large", p.environment, p.backend);
	md += `|${label(p.environment)}|${names[p.backend]}|${perf(c)}|${c?.summary.errors ?? "—"}|${c ? `${c.summary.useful_compactions}/${c.summary.noop_compactions}` : "—"}|${c?.maximum_active ?? "—"}|\n`;
}
md +=
	"\n## Large mix: spread and burst\n\nSpread targets eight scopes. Hot burst end-to-end p99 includes the sender queue for all 1,000 simultaneously admitted requests.\n\n| Deployment | Engine | spread saturation req/s / service p99 ms | hot burst req/s | hot burst end-to-end p99 ms |\n|---|---|---:|---:|---:|\n";
for (const p of pairs) {
	const b = cell("large", p.environment, p.backend, "mixed", "hot", "burst");
	md += `|${label(p.environment)}|${names[p.backend]}|${perf(cell("large", p.environment, p.backend, "mixed", "spread"))}|${b?.summary.throughput_per_sec.toFixed(1) ?? "—"}|${b?.summary.latency.p99_ms.toFixed(1) ?? "—"}|\n`;
}
md +=
	"\n## Single-operation loads: large, 128 clients, spread, saturation\n\nEntries are successful req/s / service p99 ms. Spread compaction uses 1,000 separate 33-row seeded histories; useful work is distinguished from hot-scope no-ops.\n";
for (const environment of deployments) {
	const ps = pairs.filter((p) => p.environment === environment);
	md += `\n### ${label(environment)}\n\n| Operation |${ps.map((p) => names[p.backend]).join("|")}|\n|---|${ps.map(() => "---:|").join("")}\n`;
	for (const op of [
		"write_full",
		"read_full",
		"write_patch",
		"compact",
		"read_delta",
	])
		md += `|${op}|${ps.map((p) => perf(cell("large", environment, p.backend, op, "spread"))).join("|")}|\n`;
}
md +=
	"\n## Medium hot mixed load\n\nEach entry is req/s / service p99 ms.\n\n| Deployment | Engine | 1 client | 16 clients | 64 clients |\n|---|---|---:|---:|---:|\n";
for (const p of pairs)
	md += `|${label(p.environment)}|${names[p.backend]}|${[1, 16, 64].map((n) => perf(cell("medium", p.environment, p.backend, "mixed", "hot", "saturation", n))).join("|")}|\n`;
md +=
	"\n## Fresh isolated recovery probes\n\nThese use fresh server instances and do not inherit the preceding full-write/cleanup/compaction series. Their scores are separate observations, not replacements for missing main cells.\n\n| Deployment | Engine | Operation | Topology | Mode | Clients | req/s / service p99 ms | errors | Evidence |\n|---|---|---|---|---|---:|---:|---:|---|\n";
for (const e of probes)
	for (const c of e.report.cells)
		md += `|${label(e.report.arguments.environment)}|${names[e.report.arguments.backend]}|${c.scenario}|${c.topology}|${c.mode}|${c.concurrency}|${perf(c)}|${c.summary.errors}|[report](${e.directory}/REPORT.md)|\n`;
md +=
	"\n### Attempt outcomes, including failures without a cell checkpoint\n\n| Operation | Topology | Mode | Deployment request | Exit code | Safety guard |\n|---|---|---|---|---:|---|\n";
for (const a of attempts)
	md += `|${a.operation}|${a.topology}|${a.mode}|${a.environment}|${a.code}|${a.guard ?? "none"}|\n`;
md += `\n${status.freshProbes.cells} fresh probe cells, ${status.freshProbes.requests.toLocaleString("en-US")} requests, ${status.freshProbes.errors} recorded request errors.\n\n## Interpretation and evidence\n\n- [Medium detailed table](medium/REPORT.md) and [context](medium/context.json).\n- [Native large checkpoints](large/REPORT.md) and [context](large/context-native.json).\n- [Bounded Docker large table](large-docker/REPORT.md) and [context](large-docker/context.json); container-state files record OOM/exit status.\n- [FoundationDB cleanup audit](FOUNDATIONDB-CLEANUP.md) and [archived Rust results](../../database/archive/FOUNDATIONDB-RESULTS.md).\n\nBinary payloads, immutable histories, causal frontiers and lossless compaction are checked. Both OrioleDB tables use orioledb; both pgrust columnar tables use pgrcolumnar, with a non-unique point index replacing its unsupported primary key. Actual index definitions are recorded. Columnar vectors use locked transactional DELETE+INSERT because this beta lacks unique indexes/ON CONFLICT.\n\nThese are finite batches on one Apple M4 Mac, with a shared Rust reference adapter. It uses application SQL transactions; the production PostgreSQL adapter has a separate one-call PL/pgSQL path. Docker SQLite uses the runner writable layer; server data uses named volumes. Logical cleanup is DELETE + CHECKPOINT and does not reset physical files/tombstones. Engine maintenance can affect later cells. Results do not establish steady-state capacity, a universal Docker penalty, replicated durability or managed-cloud performance. AlloyDB here is local Omni 17.10.0. Aurora is excluded by the requested open-source condition.\n`;
await mkdir(root, { recursive: true });
await Bun.write(join(root, "SUMMARY.md"), md);
await Bun.write(join(root, "SUMMARY.json"), JSON.stringify(status, null, 2));
console.log(JSON.stringify(status));
