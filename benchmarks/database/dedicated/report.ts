/**
 * Write a campaign's Markdown report: `report.ts CAMPAIGN_DIR OUTPUT.md`.
 * The tables come from the raw reports; the prose before them is the
 * hand-written `OUTPUT.intro.md` next to the output.
 */
import { readFile, writeFile } from "node:fs/promises";
import { loadCampaign, type Run, type Summary } from "./campaign.js";

const [dir, output] = process.argv.slice(2);
if (!dir || !output) throw new Error("Usage: report.ts CAMPAIGN_DIR OUTPUT.md");
const { runs, sizes } = await loadCampaign(dir);

const engines = ["postgres", "sqlite", "rocksdb", "leveldb", "lmdb"].filter(
	(id) => runs.some((run) => run.engine === id),
);
const names: Record<string, string> = {
	postgres: "PostgreSQL",
	sqlite: "SQLite",
	rocksdb: "RocksDB",
	leveldb: "LevelDB",
	lmdb: "LMDB",
};
const scenarios: [id: string, title: string, what: string][] = [
	[
		"mixed",
		"Mixed workload",
		"45% patch appends, 25% reads from a version vector, 10% full writes, 10% full reads, 10% compaction attempts.",
	],
	[
		"write_patch",
		"Append one patch",
		"One edit appended to the document's history.",
	],
	[
		"read_delta",
		"Read from a version vector",
		"The last tenth of the history: what a client that was briefly away is missing.",
	],
	[
		"read_full",
		"Read the full history",
		"Every stored segment of the document, checked and decoded.",
	],
	[
		"write_full",
		"Write a full document",
		"A new 266 KiB document in one transaction.",
	],
	[
		"compact",
		"Lossless compaction",
		"On one hot document nearly every attempt finds the range already compacted: this row mostly times that check.",
	],
];
const metrics: [
	title: string,
	better: "higher" | "lower",
	read: (s: Summary) => number,
][] = [
	["Throughput, requests/s", "higher", (s) => s.throughput_per_sec],
	["Latency p50, ms", "lower", (s) => s.service.p50_ms],
	["Latency p99, ms", "lower", (s) => s.service.p99_ms],
];

const unique = <T>(values: T[]) => [...new Set(values)];
const ascending = (a: number, b: number) => a - b;
const cores = unique(runs.map((run) => run.cores)).sort(ascending);
const histories = unique(runs.map((run) => run.edits)).sort(ascending);
const tiers = ["strict", "relaxed"].filter((tier) =>
	runs.some((run) => run.durability === tier),
);
const clients = unique(
	runs.flatMap((run) => run.cells.map((cell) => cell.clients)),
).sort(ascending);

const count = (value: number) =>
	value.toLocaleString("en-US", { maximumFractionDigits: 0 });
/** Three significant digits below 100, whole numbers above. */
const number = (value: number) =>
	value >= 100
		? count(value)
		: value.toLocaleString("en-US", {
				maximumFractionDigits: value >= 10 ? 1 : value >= 1 ? 2 : 3,
			});
const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;

const find = (
	engine: string,
	n: number,
	edits: number,
	tier: string,
	scenario: string,
	c: number,
) =>
	runs
		.find(
			(run: Run) =>
				run.engine === engine &&
				run.cores === n &&
				run.edits === edits &&
				run.durability === tier,
		)
		?.cells.find((cell) => cell.scenario === scenario && cell.clients === c)
		?.summary;

/** One row of engine values, the best one in bold, errors flagged. */
function scores(
	summaries: (Summary | undefined)[],
	better: "higher" | "lower",
	read: (s: Summary) => number,
) {
	const values = summaries.map((s) => (s && !s.errors ? read(s) : undefined));
	const valid = values.filter((v): v is number => v !== undefined);
	const best =
		valid.length > 1
			? better === "higher"
				? Math.max(...valid)
				: Math.min(...valid)
			: undefined;
	return summaries.map((summary, i) => {
		if (!summary) return "not run";
		const text = number(read(summary));
		if (summary.errors)
			return `${text} (${count(summary.errors)} ${summary.errors > 1 ? "errors" : "error"})`;
		return values[i] === best ? `**${text}**` : text;
	});
}
const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
const head = (labels: string[], numeric: number) => [
	row(labels),
	row(labels.map((_, i) => (i < labels.length - numeric ? "---" : "---:"))),
];
const engineHead = engines.map((id) => names[id]!);

const lines: string[] = [];
try {
	const intro = output.replace(/\.md$/, ".intro.md");
	lines.push((await readFile(intro, "utf8")).trimEnd(), "");
} catch {
	lines.push("# Database benchmark results", "");
}

lines.push("## Database size after the campaign", "");
lines.push(
	"Nothing is deleted during a campaign: each engine ends with every document of every cell, the same for all.",
	"The stored payload is the sum of the segment payloads read back from the engine after each cell.",
	"",
	...head(
		["Engine", "Stored payload", "Size on disk", "Disk / payload", "Of which"],
		4,
	),
);
for (const engine of engines) {
	const size = sizes[engine];
	const stored = runs
		.filter((run) => run.engine === engine)
		.flatMap((run) => run.cells)
		.reduce((total, cell) => total + cell.storedBytes, 0);
	lines.push(
		row([
			names[engine]!,
			gib(stored),
			size ? gib(size.bytes) : "not measured",
			size ? (size.bytes / stored).toFixed(2) : "",
			size?.databaseBytes
				? `tables and indexes ${gib(size.databaseBytes)}, write-ahead log ${gib(size.walBytes!)}`
				: "",
		]),
	);
}
lines.push("");

lines.push("## Mixed workload at a glance", "");
const glance = histories.includes(1000) ? 1000 : histories[0]!;
for (const tier of tiers) {
	lines.push(
		`### ${tier === "strict" ? "Strict" : "Relaxed"} durability, ${count(glance)} edits`,
		"",
		"Requests/s, then p99 latency in ms.",
		"",
		...head(["Cores", "Clients", ...engineHead], engines.length),
	);
	for (const n of cores)
		for (const c of clients) {
			const summaries = engines.map((engine) =>
				find(engine, n, glance, tier, "mixed", c),
			);
			const [throughput, p99] = [metrics[0]!, metrics[2]!].map(
				([, better, read]) => scores(summaries, better, read),
			);
			lines.push(
				row([
					n,
					c,
					// An errored cell says so once, after its second figure.
					...throughput!.map(
						(value, i) => `${value.replace(/ \(.*\)$/, "")} · ${p99![i]}`,
					),
				]),
			);
		}
	lines.push("");
}

lines.push("## Every result", "");
lines.push(
	"One table per scenario and metric. Each row is one configuration; the best engine of a row is in bold.",
	"",
);
for (const [scenario, title, what] of scenarios) {
	lines.push(`### ${title}`, "", what, "");
	for (const [metric, better, read] of metrics) {
		lines.push(
			`#### ${title}: ${metric} (${better} is better)`,
			"",
			...head(
				["Cores", "History", "Durability", "Clients", ...engineHead],
				engines.length,
			),
		);
		for (const n of cores)
			for (const edits of histories)
				for (const tier of tiers)
					for (const c of clients)
						lines.push(
							row([
								n,
								`${count(edits)} edits`,
								tier,
								c,
								...scores(
									engines.map((engine) =>
										find(engine, n, edits, tier, scenario, c),
									),
									better,
									read,
								),
							]),
						);
		lines.push("");
	}
}

await writeFile(output, `${lines.join("\n").trimEnd()}\n`);
const cells = runs.reduce((total, run) => total + run.cells.length, 0);
const errors = runs
	.flatMap((run) => run.cells)
	.reduce((total, cell) => total + cell.summary.errors, 0);
console.log(
	`${output}: ${runs.length} runs, ${cells} cells, ${errors} request errors`,
);
