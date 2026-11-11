/** Publish the compact summaries the benchmarks page displays; everything else stays in the repo. */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { DatabaseRun, TimingRun } from "../src/data/benchmarks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const baselines = resolve(root, "benchmarks/baselines");
const output = resolve(root, "packages/website/src/data/generated");
const readJSON = async (path: string) => {
	const bytes = await readFile(path);
	return JSON.parse(
		(path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString(),
	);
};

// ponytail: the release reference is pinned by file name; point these at the new baselines after a new campaign.
const timing: Record<string, TimingRun> = {};
for (const [suite, file] of [["crdt", "core-compact-20261111.json"]]) {
	const { generatedAt, environment, parameters, results } = await readJSON(
		resolve(baselines, file),
	);
	timing[suite] = {
		path: `benchmarks/baselines/${file}`,
		generatedAt,
		environment,
		parameters,
		results: results.filter(
			(result: { name: string }) => !result.name.includes("proxy-overhead"),
		),
	};
}

// The page shows one workload shape: a single hot scope under closed-loop saturation.
// ponytail: campaign folders are listed by hand; add the next campaign's folders here.
const campaigns: [date: string, root: string, folders: string[]][] = [
	[
		"2026-11-04",
		"database-engines-20261104",
		["medium", "large", "large-docker"],
	],
	[
		"2026-11-11",
		"database-engines-20261111",
		["mac-strict", "mac-relaxed", "vps", "unikraft", "lsm-variants"],
	],
];
// Engines without interactive transactions did not finish their matrix: their
// numbers measure the workaround more than the engine, so the page leaves them out.
// In-memory stores are also excluded from the database comparison.
const hidden = new Set(["scylla", "clickhouse", "valkey", "dragonfly"]);
let database: DatabaseRun[] = [];
for (const [campaign, root, folders] of campaigns) {
	for (const folder of folders) {
		const dir = resolve(baselines, root, folder);
		for (const file of (await readdir(dir)).sort()) {
			if (!/^(bare-metal|docker|vps|unikraft)-.*\.json(\.gz)?$/.test(file))
				continue;
			const data = await readJSON(resolve(dir, file));
			if (!data.cells?.length) continue;
			const args = data.arguments;
			if (hidden.has(args.backend)) continue;
			const planned = [
				args.scenarios,
				args.modes,
				args.topologies,
				args.concurrency,
			].reduce((total, value) => total * String(value).split(",").length, 1);
			// The LSM variants ran in their own session, pinned to one core and unpinned.
			// Unpinned, they join the Docker table as a separate session; RocksDB itself
			// is already there from the main campaign.
			const separateSession = args.environment === "docker-allcpu";
			if (separateSession && args.backend === "rocksdb") continue;
			database.push({
				backend: args.backend,
				environment: separateSession ? "docker" : args.environment,
				profile: data.metadata.profile,
				durability: args.durability ?? "strict",
				campaign,
				separateSession,
				incomplete: data.cells.length < planned,
				cells: data.cells
					.filter(
						(cell: { topology: string; mode: string }) =>
							cell.topology === "hot" && cell.mode === "saturation",
					)
					.map(
						({
							scenario,
							concurrency,
							summary,
						}: DatabaseRun["cells"][number]) => ({
							scenario,
							concurrency,
							summary,
						}),
					),
			});
		}
	}
}
// An engine measured again in a later campaign replaces its earlier run.
const slot = (run: DatabaseRun) =>
	[run.backend, run.environment, run.profile, run.durability].join("|");
const latest = new Map<string, string>();
for (const run of database)
	if ((latest.get(slot(run)) ?? "") < run.campaign)
		latest.set(slot(run), run.campaign);
database = database.filter((run) => latest.get(slot(run)) === run.campaign);

await mkdir(output, { recursive: true });
for (const [name, data] of Object.entries({
	"timing-results": timing,
	"database-results": database,
})) {
	await writeFile(resolve(output, `${name}.json`), `${JSON.stringify(data)}\n`);
}
console.log(
	`Benchmarks: ${timing.crdt.results.length} CRDT results, ${database.reduce((n, run) => n + run.cells.length, 0)} database cells.`,
);
