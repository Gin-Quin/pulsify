import { createMemo, createSignal, For, Show } from "solid-js";
import { BenchmarkTable, Info } from "./BenchmarkTable";
import { SourceLink } from "./BenchmarkTimings";
import {
	engineNames,
	formatCount,
	scenarioHelp,
	scenarioNames,
	type ComparisonRow,
	type DatabaseCampaign,
	type DatabaseSummary,
} from "~/data/benchmarks";
import data from "~/data/generated/database-results.json";
import styles from "./Benchmarks.module.css";

const { runs: allRuns, sizes } = data as DatabaseCampaign;
const versions: Record<string, string> = {
	postgres: "18.6",
	sqlite: "3.51",
	rocksdb: "11.8",
	leveldb: "1.22",
	lmdb: "0.9.70",
};
const backends = ["postgres", "sqlite", "rocksdb", "leveldb", "lmdb"];
const tierNames: Record<string, string> = {
	strict: "Strict",
	relaxed: "Relaxed",
};
/** What sets one engine's column apart from its neighbours. */
const columnNotes: Record<string, string> = {
	postgres:
		"The only server here: its clients reach it through a Unix socket and share the cores with it. The other engines run inside the client process.",
	leveldb:
		"LevelDB has no transactions: its adapter adds a mutex and one write batch per transaction.",
};
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

const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
const coreCounts = unique(allRuns.map((r) => r.cores));
const histories = unique(allRuns.map((r) => r.edits));
const clientCounts = unique(
	allRuns.flatMap((r) => r.cells.map((c) => c.clients)),
);
/** Geometric mean of an engine's throughput over every option: scenarios span orders of magnitude, so an arithmetic mean would only rank compaction. */
const overall = (engine: string) => {
	const logs = allRuns
		.filter((r) => r.engine === engine)
		.flatMap((r) => r.cells.map((c) => c.summary.throughput_per_sec))
		.filter((v) => v > 0)
		.map(Math.log);
	return logs.reduce((sum, v) => sum + v, 0) / logs.length;
};
/** Fixed whatever the filters: best overall engine first. */
const columns = backends
	.filter((id) => allRuns.some((r) => r.engine === id))
	.sort((a, b) => overall(b) - overall(a))
	.map((id) => ({
		id,
		label: engineNames[id],
		detail: versions[id],
		help: columnNotes[id],
	}));
const sizeRows: ComparisonRow[] = [
	{
		id: "size",
		label: "Size on disk",
		help: "The engine’s whole data directory after the last batch. Nothing is deleted during the campaign, so every engine holds the same documents.",
		values: Object.fromEntries(
			Object.entries(sizes).map(([engine, size]) => [
				engine,
				{
					value: size.bytes / 2 ** 30,
					detail: `${(size.bytes / size.storedBytes).toFixed(2)} × the stored payload`,
				},
			]),
		),
	},
];

export function DatabaseBenchmarks() {
	const [cores, setCores] = createSignal(coreCounts.at(-1)!);
	const [edits, setEdits] = createSignal(
		histories.includes(1000) ? 1000 : histories[0]!,
	);
	const [durability, setDurability] = createSignal("strict");
	const [clients, setClients] = createSignal(clientCounts.at(-1)!);
	const [metricId, setMetric] = createSignal<Metric>("throughput");
	const metric = () => metrics[metricId()];
	// A memo, not a plain function: each table cell reads it, and a plain function would re-filter every run per cell.
	const runs = createMemo(() =>
		allRuns.filter(
			(r) =>
				r.cores === cores() &&
				r.edits === edits() &&
				r.durability === durability(),
		),
	);
	const rows = createMemo((): ComparisonRow[] =>
		operations.map((scenario) => ({
			id: scenario,
			label: scenarioNames[scenario],
			help: scenarioHelp[scenario],
			values: Object.fromEntries(
				runs().map((run) => {
					const summary = run.cells.find(
						(c) => c.scenario === scenario && c.clients === clients(),
					)?.summary;
					return [
						run.engine,
						{
							value: summary && metric().read(summary),
							failed: summary?.errors
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
				Each storage backend serving real Pulsify histories on the same
				dedicated server (12-core AMD EPYC 4484PX, 96 GB, NVMe, Ubuntu 24.04):
				batches of 2,000 requests from concurrent clients on one document.
				Strict flushes every commit to disk before acknowledging it; relaxed
				acknowledges first.
			</p>
			<div class={styles.toolbar}>
				<Choice
					label="Cores"
					help="Cores online on the server. The clients and the database share them."
					value={cores()}
					onChange={setCores}
					options={coreCounts.map((n) => [n, String(n)])}
				/>
				<Choice
					label="Document history"
					help="Edits already stored for the document the clients work on. The document itself is the same: 256 paragraphs, 266 KiB."
					value={edits()}
					onChange={setEdits}
					options={histories.map((n) => [n, `${formatCount(n)} edits`])}
				/>
				<Choice
					label="Durability"
					help="Strict flushes each commit to disk before confirming it. Relaxed confirms writes before flushing: a crash can lose recently confirmed writes. Compare engines within the same durability tier."
					value={durability()}
					onChange={setDurability}
					options={Object.entries(tierNames)}
				/>
				<Choice
					label="Concurrent clients"
					help="Number of clients sending requests to the same document at once. Each client waits for its previous request to finish before sending the next. More clients increase contention on the database."
					value={clients()}
					onChange={setClients}
					options={clientCounts.map((c) => [c, String(c)])}
				/>
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
				caption={`${metric().label} · ${cores()} ${cores() === 1 ? "core" : "cores"} · ${clients()} concurrent clients`}
				unit={metric().unit}
				direction={metric().direction}
				columns={columns}
				fixedOrder
				rows={rows()}
			/>
			<BenchmarkTable
				caption="Database size after every batch"
				unit="GiB"
				direction="lower"
				columns={columns}
				fixedOrder
				rows={sizeRows}
			/>
		</section>
	);
}
