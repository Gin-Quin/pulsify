import { createMemo, createSignal, For, Show } from "solid-js";
import { BenchmarkTable, Info } from "./BenchmarkTable";
import { SourceLink } from "./BenchmarkTimings";
import {
	engineNames,
	formatCount,
	scenarioHelp,
	scenarioNames,
	type ComparisonRow,
	type DatabaseRun,
	type DatabaseSummary,
} from "~/data/benchmarks";
import data from "~/data/generated/database-results.json";
import styles from "./Benchmarks.module.css";

const allRuns = data as DatabaseRun[];
const versions: Record<string, string> = {
	postgres: "16",
	alloydb: "17.10",
	orioledb: "PG 17.11 · beta 19",
	"pgrust-row": "0.4-beta",
	"pgrust-columnar": "0.4-beta",
	rocksdb: "11.8",
	"rocksdb-mutex": "11.8 · no TransactionDB",
	leveldb: "1.22",
	lmdb: "0.9.70",
};
const backends = [
	"postgres",
	"sqlite",
	"rocksdb",
	"rocksdb-mutex",
	"leveldb",
	"lmdb",
	"alloydb",
	"orioledb",
	"pgrust-row",
	"pgrust-columnar",
];
const deployments: Record<string, string> = {
	docker: "Docker · Linux",
	"bare-metal": "Native · macOS",
	vps: "VPS · Linux",
	unikraft: "Unikraft Cloud · 1 vCPU",
	"docker-1cpu": "Docker · 1 core",
};
const tierNames: Record<string, string> = {
	strict: "Strict",
	relaxed: "Relaxed",
};

/** What skews one engine's column against its neighbours. Nothing when the column is a fair comparison. */
function columnBias(run: DatabaseRun, mixedCampaigns: boolean) {
	const notes: string[] = [];
	if (
		run.backend === "lmdb" &&
		run.environment === "bare-metal" &&
		run.durability === "strict"
	)
		notes.push(
			"Only LMDB asks macOS for a full flush to the drive; the other engines’ fsync stops at the drive cache. LMDB pays a cost here that they skip.",
		);
	if (run.backend === "leveldb")
		notes.push(
			"LevelDB has no transactions: its adapter adds a mutex and one write batch per transaction. It runs with RocksDB’s 64 MiB write buffer and without compression.",
		);
	if (run.backend === "rocksdb-mutex")
		notes.push(
			"RocksDB without its transaction layer: a mutex and one write batch per transaction, like the LevelDB adapter.",
		);
	if (run.separateSession)
		notes.push(
			"Measured in a later session than its neighbours, with a rebuilt runner. Compare it with RocksDB on the one-core deployment, where they ran together.",
		);
	if (mixedCampaigns && run.campaign === "2026-11-04")
		notes.push(
			"Measured on 4 November in another scenario order: the mix ran last, on a used store. Measured again on 11 November with the mix first, PostgreSQL and SQLite scored 5% to 86% higher on it.",
		);
	return notes.join(" ") || undefined;
}

/** What skews a whole deployment's table. */
function tableBias(environment: string, durability: string) {
	if (environment === "bare-metal" && durability === "strict")
		return "On macOS, fsync stops at the drive cache: the strict tier is fully strict on Linux only.";
	if (environment === "vps")
		return "A shared VPS with other workloads and a nearly full disk. It runs no database server, so only embedded engines were measured.";
	if (environment === "unikraft")
		return "One vCPU shared by the clients and the database. Whether fsync reaches stable storage on its volume is not established.";
	if (environment === "docker-1cpu")
		return "One Linux container pinned to a single core of the Mac.";
}
const operations = [
	"write_full",
	"read_full",
	"write_patch",
	"compact",
	"read_delta",
	"mixed",
];
const metrics = {
	throughput: {
		label: "Throughput",
		unit: "requests/s",
		direction: "higher",
		read: (s: DatabaseSummary) => s.throughput_per_sec,
	},
	p50: {
		label: "Latency p50",
		unit: "ms",
		direction: "lower",
		read: (s: DatabaseSummary) => s.service.p50_ms,
	},
	p99: {
		label: "Latency p99",
		unit: "ms",
		direction: "lower",
		read: (s: DatabaseSummary) => s.service.p99_ms,
	},
} as const;
type Metric = keyof typeof metrics;

/** A row of mutually exclusive options, all visible at once. */
function Choice<T extends string | number>(props: {
	label: string;
	help?: string;
	value: T;
	options: [T, string][];
	onChange: (value: T) => void;
}) {
	return (
		<fieldset class={styles.choice}>
			<legend>
				{props.label}
				<Show when={props.help}>{(help) => <Info text={help()} />}</Show>
			</legend>
			<div>
				<For each={props.options}>
					{([value, label]) => (
						<label>
							<input
								type="radio"
								name={props.label}
								checked={props.value === value}
								onChange={() => props.onChange(value)}
							/>
							{label}
						</label>
					)}
				</For>
			</div>
		</fieldset>
	);
}

export function DatabaseBenchmarks() {
	const [profile, setProfile] = createSignal("large");
	const [requestedEnvironment, setEnvironment] = createSignal("docker");
	const [requestedDurability, setDurability] = createSignal("strict");
	const [requestedClients, setClients] = createSignal(128);
	const [metricId, setMetric] = createSignal<Metric>("throughput");
	const metric = () => metrics[metricId()];
	// Each choice falls back to what the choices before it leave available.
	// Memos, not plain functions: each table cell reads these, and a plain function would re-filter every run per cell.
	const inProfile = createMemo(() => {
		const id = profile();
		return allRuns.filter((r) => r.profile === id);
	});
	const environments = createMemo(() =>
		Object.keys(deployments).filter((id) =>
			inProfile().some((r) => r.environment === id),
		),
	);
	const environment = createMemo(() =>
		environments().includes(requestedEnvironment())
			? requestedEnvironment()
			: environments()[0]!,
	);
	const inDeployment = createMemo(() =>
		inProfile().filter((r) => r.environment === environment()),
	);
	const tiers = createMemo(() =>
		Object.keys(tierNames).filter((id) =>
			inDeployment().some((r) => r.durability === id),
		),
	);
	const durability = createMemo(() =>
		tiers().includes(requestedDurability())
			? requestedDurability()
			: tiers()[0]!,
	);
	const runs = createMemo(() =>
		inDeployment().filter((r) => r.durability === durability()),
	);
	const clientCounts = createMemo(() =>
		[...new Set(runs().flatMap((r) => r.cells.map((c) => c.concurrency)))].sort(
			(a, b) => a - b,
		),
	);
	const clients = createMemo(() =>
		clientCounts().includes(requestedClients())
			? requestedClients()
			: clientCounts().at(-1)!,
	);
	const mixedCampaigns = createMemo(
		() => new Set(runs().map((r) => r.campaign)).size > 1,
	);
	const columns = createMemo(() =>
		backends.flatMap((id) => {
			const run = runs().find((r) => r.backend === id);
			return run
				? [
						{
							id,
							label: engineNames[id],
							detail: versions[id],
							help: columnBias(run, mixedCampaigns()),
						},
					]
				: [];
		}),
	);
	const rows = createMemo((): ComparisonRow[] =>
		operations.map((scenario) => ({
			id: scenario,
			label: scenarioNames[scenario],
			help: scenarioHelp[scenario],
			values: Object.fromEntries(
				runs().map((run) => {
					const summary = run.cells.find(
						(c) => c.scenario === scenario && c.concurrency === clients(),
					)?.summary;
					return [
						run.backend,
						{
							value: summary && metric().read(summary),
							missing: run.incomplete ? "Backend failed" : undefined,
							failed: !!summary?.errors,
							detail: summary?.errors
								? `${formatCount(summary.errors)} errors`
								: undefined,
						},
					];
				}),
			),
		})),
	);
	return (
		<section
			id="databases"
			class={styles.section}
			aria-labelledby="databases-title"
		>
			<div class={styles.sectionHead}>
				<h2 id="databases-title">Databases</h2>
				<SourceLink path="benchmarks/database/RESULTS.md">
					Full report
				</SourceLink>
			</div>
			<p class={styles.lead}>
				Each storage backend serving real Pulsify histories: batches of 1,000
				requests from concurrent clients on one document. Strict flushes every
				commit to disk before acknowledging it; relaxed acknowledges first.
			</p>
			<div class={styles.toolbar}>
				<Choice
					label="Document history"
					value={profile()}
					onChange={setProfile}
					options={[
						["medium", "100 edits"],
						["large", "1,000 edits"],
					]}
				/>
				<Choice
					label="Deployment"
					value={environment()}
					onChange={setEnvironment}
					options={environments().map((id) => [id, deployments[id]!])}
				/>
				<Show when={tiers().length > 1}>
					<Choice
						label="Durability"
						help="Strict flushes each commit to disk before confirming it. Relaxed confirms writes before flushing: a crash can lose recently confirmed writes. Compare engines within the same durability tier."
						value={durability()}
						onChange={setDurability}
						options={tiers().map((id) => [id, tierNames[id]!])}
					/>
				</Show>
				<Show when={clientCounts().length > 1}>
					<Choice
						label="Concurrent clients"
						help="Number of clients sending requests to the same document at once. Each client waits for its previous request to finish before sending the next. More clients increase contention on the database."
						value={clients()}
						onChange={setClients}
						options={clientCounts().map((c) => [c, String(c)])}
					/>
				</Show>
				<Choice
					label="Metric"
					value={metricId()}
					onChange={setMetric}
					options={(Object.keys(metrics) as Metric[]).map((id) => [
						id,
						metrics[id].label,
					])}
				/>
			</div>
			<BenchmarkTable
				caption={`${metric().label} · ${clients()} concurrent clients`}
				note={tableBias(environment(), durability())}
				unit={metric().unit}
				direction={metric().direction}
				columns={columns()}
				rows={rows()}
			/>
		</section>
	);
}
