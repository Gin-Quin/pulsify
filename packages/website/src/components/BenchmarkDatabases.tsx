import { createMemo, createSignal, For } from "solid-js";
import { BenchmarkTable } from "./BenchmarkTable";
import { SourceLink } from "./BenchmarkTimings";
import { engineNames, formatCount, formatScore, scenarioNames, type ComparisonRow, type DatabaseCampaign, type DatabaseSummary } from "~/data/benchmarks";
import data from "~/data/generated/database-results.json";
import legacy from "../../../../benchmarks/baselines/database-20261104/database.json";
import postgres from "../../../../docs/storage-postgres-final-20261104.json";
import nativeMix from "../../../../benchmarks/baselines/database-mix-optimization-20261104/COMPARISON.json";
import dockerMix from "../../../../benchmarks/baselines/database-mix-optimization-20261104/DOCKER-COMPARISON.json";
import mediumMix from "../../../../benchmarks/baselines/database-mix-optimization-20261104/MEDIUM-COMPARISON.json";
import styles from "./Benchmarks.module.css";

const campaigns = data as DatabaseCampaign[];
const backendOrder = ["postgres", "sqlite", "alloydb", "orioledb", "pgrust-row", "pgrust-columnar", "foundationdb"];
const operations = ["write_full", "read_full", "write_patch", "compact", "read_delta", "mixed"];
const unique = <T,>(items: T[]) => [...new Set(items)];
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

type DatabaseMetric = { id: string; label: string; unit: string; direction: "lower" | "higher"; read: (summary: DatabaseSummary) => number };
const databaseMetrics: DatabaseMetric[] = [
	{ id: "throughput", label: "Successful requests / second", unit: "req/s", direction: "higher", read: s => s.throughput_per_sec },
	...["service", "queue", "latency"].flatMap(kind => ["p50_ms", "p95_ms", "p99_ms", "max_ms"].map(percentile => ({
		id: `${kind}.${percentile}`, label: `${kind === "latency" ? "End-to-end" : kind === "service" ? "Service" : "Queue"} ${percentile.replace("_ms", "")}`,
		unit: "ms", direction: "lower" as const,
		read: (s: DatabaseSummary) => s[kind as "service" | "queue" | "latency"][percentile as "p50_ms" | "p95_ms" | "p99_ms" | "max_ms"],
	}))),
	{ id: "errors", label: "Request errors", unit: "errors", direction: "lower", read: s => s.errors },
	{ id: "retries", label: "Recorded retries", unit: "retries", direction: "lower", read: s => s.retries },
	{ id: "useful", label: "Useful compactions / second", unit: "compactions/s", direction: "higher", read: s => s.useful_compactions_per_sec },
	{ id: "removed", label: "Segments removed", unit: "segments", direction: "higher", read: s => s.removed_segments },
];

export function DatabaseBenchmarks() {
	const [campaignId, setCampaignId] = createSignal("engines");
	const campaign = createMemo(() => campaigns.find(c => c.id === campaignId())!);
	const [requestedProfile, setProfile] = createSignal("large");
	const profiles = () => unique(campaign().runs.map(r => r.profile));
	const profile = () => profiles().includes(requestedProfile()) ? requestedProfile() : profiles()[0];
	const [requestedEnv, setEnv] = createSignal("docker");
	const environments = () => unique(campaign().runs.filter(r => r.profile === profile()).map(r => r.environment));
	const environment = () => environments().includes(requestedEnv()) ? requestedEnv() : environments()[0];
	const runs = createMemo(() => campaign().runs.filter(r => r.environment === environment() && r.profile === profile()));
	const [requestedConcurrency, setConcurrency] = createSignal(128);
	const concurrencies = () => unique(runs().flatMap(r => r.cells.map(c => c.concurrency))).sort((a, b) => a - b);
	const concurrency = () => concurrencies().includes(requestedConcurrency()) ? requestedConcurrency() : concurrencies().at(-1)!;
	const [requestedTopology, setTopology] = createSignal("hot");
	const topologies = () => unique(runs().flatMap(r => r.cells.map(c => c.topology)));
	const topology = () => topologies().includes(requestedTopology()) ? requestedTopology() : topologies()[0];
	const [requestedMode, setMode] = createSignal("saturation");
	const modes = () => unique(runs().flatMap(r => r.cells.filter(c => c.topology === topology()).map(c => c.mode)));
	const mode = () => modes().includes(requestedMode()) ? requestedMode() : modes()[0];
	const [metricId, setMetric] = createSignal("throughput");
	const metric = () => databaseMetrics.find(m => m.id === metricId())!;
	const columns = () => backendOrder.filter(id => runs().some(r => r.backend === id)).map(id => ({ id, label: engineNames[id], detail: id === "alloydb" ? "Local Omni 17.10.0" : id.startsWith("pgrust") ? "0.4-beta" : id === "postgres" ? "16" : id === "orioledb" ? "PG 17.11 / beta 19" : undefined }));
	const matched = (run: typeof data[number]["runs"][number]) => run.cells.filter(c => c.concurrency === concurrency() && c.topology === topology() && c.mode === mode());
	const scenarios = () => operations.filter(scenario => runs().some(r => matched(r).some(c => c.scenario === scenario)));
	const rows = (breakdown = false): ComparisonRow[] => (breakdown ? operations.filter(o => o !== "mixed") : scenarios()).map(scenario => ({
		id: scenario, label: scenarioNames[scenario], detail: breakdown ? "Within the mixed batch" : scenario === "mixed" ? "45 / 25 / 10 / 10 / 10 mix" : scenario === "compact" ? "Attempts include no-ops" : "1,000 requests",
		values: Object.fromEntries(runs().map(run => {
			const cell = matched(run).find(c => c.scenario === (breakdown ? "mixed" : scenario));
			const summary = breakdown ? cell?.operations[scenario] : cell?.summary;
			return [run.backend, {
				value: summary ? metric().read(summary) : undefined,
				missing: run.cells.length < run.plannedCells ? "Not reached · failed series" : "Not measured",
				failed: !!summary?.errors,
				detail: summary ? (summary.errors ? `${formatCount(summary.errors)} errors · ${formatCount(summary.success)} completed` : scenario === "compact" ? `${formatCount(summary.useful_compactions)} useful / ${formatCount(summary.noop_compactions)} no-op` : `p99 ${formatScore(summary.service.p99_ms)} ms · ${summary.errors} errors`) : undefined,
			}];
		})),
	}));
	return (
		<section id="databases" class={styles.section} aria-labelledby="databases-title">
			<div class={styles.sectionHead}><div><p class={styles.eyebrow}>03 / Durable storage</p><h2 id="databases-title">Every backend. Under load.</h2></div><SourceLink path="benchmarks/database/README.md">Method & configuration</SourceLink></div>
			<p class={styles.lead}>Native Rust clients, real Pulsify histories, concurrent reads and durable writes. Explore every checkpointed cell, the recovery probes and the later mixed-workload tuning campaigns.</p>
			<div class={styles.facts}><div><strong>957,000</strong><span>Checkpointed engine-campaign requests</span></div><div><strong>584</strong><span>Recorded request errors, retained</span></div><div><strong>18 / 20</strong><span>Main matrices completed</span></div></div>
			<div class={styles.toolbar}>
				<label class={`${styles.field} ${styles.runField}`}>Campaign<select value={campaignId()} onChange={e => setCampaignId(e.currentTarget.value)}><For each={campaigns}>{c => <option value={c.id}>{c.label}</option>}</For></select></label>
				<label class={styles.field}>Profile<select value={profile()} onChange={e => setProfile(e.currentTarget.value)}><For each={profiles()}>{p => <option value={p}>{p === "large" ? "Large · 1,000 prior edits" : "Medium · 100 prior edits"}</option>}</For></select></label>
				<label class={styles.field}>Deployment<select value={environment()} onChange={e => setEnv(e.currentTarget.value)}><For each={environments()}>{env => <option value={env}>{env === "docker" ? "Docker · Linux ARM64" : "Native · macOS ARM64"}</option>}</For></select></label>
				<label class={styles.field}>Clients<select value={concurrency()} onChange={e => setConcurrency(Number(e.currentTarget.value))}><For each={concurrencies()}>{c => <option value={c}>{c} concurrent</option>}</For></select></label>
				<label class={styles.field}>Topology<select value={topology()} onChange={e => setTopology(e.currentTarget.value)}><For each={topologies()}>{t => <option value={t}>{t === "hot" ? "Hot · one scope" : "Spread · eight scopes"}</option>}</For></select></label>
				<label class={styles.field}>Admission<select value={mode()} onChange={e => setMode(e.currentTarget.value)}><For each={modes()}>{m => <option value={m}>{m === "burst" ? "Burst · includes queue" : "Saturation · closed loop"}</option>}</For></select></label>
				<label class={styles.field}>Metric<select value={metricId()} onChange={e => setMetric(e.currentTarget.value)}><For each={databaseMetrics}>{m => <option value={m.id}>{m.label}</option>}</For></select></label>
			</div>
			<aside class={styles.callout}><p>{campaign().note}</p><SourceLink path={campaign().path}>Campaign report</SourceLink></aside>
			<BenchmarkTable caption={`Database ${metric().label.toLowerCase()}`} unit={metric().unit} direction={metric().direction} columns={columns()} rows={rows()} />
			<p class={styles.note}>Highlights compare the same workload within one deployment. Throughput counts successful requests. Compaction-attempt throughput includes no-ops; select useful compactions/s to compare actual work. Docker large runs cap each container at 4 GiB with no swap; medium Docker used the VM defaults.</p>
			<details class={styles.disclosure}><summary>Mixed-workload operation breakdown <span>Same filters and metric as above</span></summary><p class={styles.note}>Each operation’s rate is its completed count divided by the whole mixed batch duration, not standalone operation capacity.</p><BenchmarkTable caption="Operations within the mixed workload" unit={metric().unit} direction={metric().direction} columns={columns()} rows={rows(true)} /></details>
			<details class={styles.disclosure} open><summary>Matrix status & original records <span>All checkpoints, including incomplete series</span></summary>
				<div class={styles.tableWrap} role="region" aria-label="Database matrix status" tabindex="0"><table class={`${styles.table} ${styles.statusTable}`}>
					<caption>Source records for the selected profile and deployment</caption><thead><tr><th scope="col">Engine</th><th scope="col">Checkpointed cells</th><th scope="col">Request errors</th><th scope="col">Status</th><th scope="col">Evidence</th></tr></thead><tbody><For each={runs()}>{r => <tr><th scope="row" title={r.version}>{engineNames[r.backend]}<small>{r.backend === "sqlite" ? r.version : "Hover for recorded version"}</small></th><td>{r.cells.length} / {r.plannedCells}</td><td data-failed={r.cells.some(c => c.summary.errors > 0) || undefined}>{formatCount(r.cells.reduce((sum, c) => sum + c.summary.errors, 0))}</td><td><span class={styles.status} data-incomplete={r.cells.length < r.plannedCells || undefined}>{r.cells.length < r.plannedCells ? "Incomplete · backend failure" : "Complete"}</span></td><td><SourceLink path={r.path}>Raw JSON{r.path.endsWith(".gz") ? " (gzip)" : ""}</SourceLink></td></tr>}</For></tbody>
				</table></div>
			</details>
			<MixedOptimization />
			<LegacyStorage />
		</section>
	);
}

function MixedOptimization() {
	const [selection, setSelection] = createSignal("native");
	const comparison = () => selection() === "native" ? nativeMix : selection() === "docker" ? dockerMix : mediumMix;
	const rows = () => comparison().rows.map(row => {
		const [env, backend, clients, topology, mode] = row.key.split("/");
		return { id: row.key, label: `${engineNames[backend]} · ${clients} clients`, detail: `${env === "bare-metal" ? "Native" : "Docker"} · ${topology} · ${mode}`, values: { before: { value: median(row.before.map(s => s.throughput_per_sec)) }, after: { value: median(row.after.map(s => s.throughput_per_sec)), detail: `${row.gainPercent >= 0 ? "+" : ""}${formatScore(row.gainPercent)}% throughput` } } };
	});
	return (
		<details class={styles.disclosure}>
			<summary>Mixed-workload optimization results <span>Before / after, with repeated-run medians</span></summary>
			<p class={styles.note}>The primary large native comparison uses three baseline and three optimized campaigns with identical fixtures. Docker and medium each use one before/after pair, with less evidence about variance. These are separate from the original engine comparison.</p>
			<label class={styles.field}>Comparison<select value={selection()} onChange={e => setSelection(e.currentTarget.value)}><option value="native">Large native · 128 clients · 3 + 3 runs</option><option value="docker">Large Docker · 128 clients · 1 + 1 run</option><option value="medium">Medium native · 1 / 16 / 64 clients · 1 + 1 run</option></select></label>
			<BenchmarkTable caption="Mixed-workload adapter optimization" unit="successful req/s" direction="higher" columns={[{ id: "before", label: "Before", detail: "Median campaign throughput" }, { id: "after", label: "Optimized", detail: "Median campaign throughput" }]} rows={rows()} />
			<SourceLink path="benchmarks/baselines/database-mix-optimization-20261104/README.md">Audited comparisons & source snapshots</SourceLink>
		</details>
	);
}

function LegacyStorage() {
	const [profile, setProfile] = createSignal("large");
	const [statistic, setStatistic] = createSignal("medianMs");
	const scenarios = () => unique(legacy.measurements.map(m => m.scenario));
	const rows = () => scenarios().map(scenario => ({ id: scenario, label: scenarioNames[scenario] ?? scenario.replaceAll("_", " "), values: Object.fromEntries(legacy.measurements.filter(m => m.profile === profile() && m.scenario === scenario).map(m => [m.backend, { value: statistic() === "medianMs" ? m.medianMs : m.p95Ms }])) }));
	return (
		<>
			<details class={styles.disclosure}>
				<summary>Archived sequential storage suite <span>All 81 measurements · PostgreSQL, SQLite & FoundationDB</span></summary>
				<p class={styles.note}>Historical Docker / Bun suite: 3 warmups + 12 measured samples per case. FoundationDB used a Python JSON/base64 pipe per primitive; its transport costs are included. These scores are separate from the native Rust campaign above.</p>
				<div class={styles.toolbar}><label class={styles.field}>Archived profile<select value={profile()} onChange={e => setProfile(e.currentTarget.value)}><option value="small">Small · 20 prior edits</option><option value="medium">Medium · 100 prior edits</option><option value="large">Large · 1,000 prior edits</option></select></label><label class={styles.field}>Archived statistic<select value={statistic()} onChange={e => setStatistic(e.currentTarget.value)}><option value="medianMs">Median</option><option value="p95Ms">p95</option></select></label></div>
				<BenchmarkTable caption="Historical sequential storage measurements" unit="ms/op" columns={[{ id: "postgres", label: "PostgreSQL", detail: "16.15 · Bun SQL / TCP" }, { id: "sqlite", label: "SQLite", detail: "3.53.4 · bun:sqlite" }, { id: "foundationdb", label: "FoundationDB", detail: "7.3.77 · Python pipe" }]} rows={rows()} />
				<SourceLink path="benchmarks/baselines/database-20261104/database.json">All raw samples & metadata</SourceLink>
			</details>
			<details class={styles.disclosure}>
				<summary>Production PostgreSQL adapter measurements <span>Correctness-hardened revision · 3 batch sizes</span></summary>
				<p class={styles.note}>Bun 1.4.4 / PostgreSQL 16.15 over localhost TCP in Docker. Durable logged writes, 128-byte opaque payloads, 2 warmups and 6 measured runs. The statistic is the fourth sorted sample of six (upper middle), rather than the arithmetic median. Batch sizes are different workloads and are not ranked against one another.</p>
				<div class={styles.tableWrap} role="region" aria-label="Production PostgreSQL adapter measurements" tabindex="0"><table class={styles.table}><caption>Final production adapter revision · milliseconds</caption><thead><tr><th scope="col">Rows per append</th><th scope="col">Append, upper middle</th><th scope="col">Delta, upper middle</th><th scope="col">Delta rows returned</th></tr></thead><tbody><For each={postgres.results}>{r => <tr><th scope="row">{formatCount(r.rows)}</th><td>{formatScore(r.appendUpperMedianMs)}</td><td>{formatScore(r.deltaTenUpperMedianMs)}</td><td>{r.rows === 1 ? 1 : 10}</td></tr>}</For></tbody></table></div>
				<SourceLink path="docs/storage-postgres-final-20261104.json">All warmup & measured samples</SourceLink> · <SourceLink path="docs/STORAGE-BENCHMARKS.md">Historical optimization measurements</SourceLink>
			</details>
		</>
	);
}
