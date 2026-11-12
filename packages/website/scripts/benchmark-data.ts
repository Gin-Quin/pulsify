/** Publish the compact summaries the benchmarks page displays; everything else stays in the repo. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { loadCampaign } from "../../../benchmarks/database/dedicated/campaign";
import type { DatabaseCampaign, TimingRun } from "../src/data/benchmarks";

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

// The page shows one campaign: every engine on the same dedicated server.
// ponytail: the campaign folder is named by hand; point it at the next campaign.
const campaign = "database-f4-metal-small-20261111";
const { runs, sizes } = await loadCampaign(resolve(baselines, campaign));
const database: DatabaseCampaign = {
	runs: runs.map(({ engine, cores, edits, durability, cells }) => ({
		engine,
		cores,
		edits,
		durability,
		cells: cells.map(({ scenario, clients, summary }) => ({
			scenario,
			clients,
			summary: {
				errors: summary.errors,
				throughput_per_sec: summary.throughput_per_sec,
				service: {
					p50_ms: summary.service.p50_ms,
					p99_ms: summary.service.p99_ms,
				},
			},
		})),
	})),
	sizes: Object.fromEntries(
		Object.entries(sizes).map(([engine, size]) => [
			engine,
			{
				bytes: size.bytes,
				storedBytes: runs
					.filter((run) => run.engine === engine)
					.flatMap((run) => run.cells)
					.reduce((total, cell) => total + cell.storedBytes, 0),
			},
		]),
	),
};

await mkdir(output, { recursive: true });
for (const [name, data] of Object.entries({
	"timing-results": timing,
	"database-results": database,
})) {
	await writeFile(resolve(output, `${name}.json`), `${JSON.stringify(data)}\n`);
}
console.log(
	`Benchmarks: ${timing.crdt.results.length} CRDT results, ${database.runs.reduce((n, run) => n + run.cells.length, 0)} database cells.`,
);
