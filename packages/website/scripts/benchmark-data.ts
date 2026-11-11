/** Publish compact, lossless summaries; the original samples and events stay in the repo. */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { DatabaseCampaign, DatabaseCell, TimingRun } from "../src/data/benchmarks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const baselines = resolve(root, "benchmarks/baselines");
const output = resolve(root, "packages/website/src/data/generated");
const readJSON = async (path: string) => {
	const bytes = await readFile(path);
	return JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString());
};
const sourcePath = (path: string) => relative(root, path).split("\\").join("/");

const timingLabels: Record<string, string> = {
	"core-hybrid-20261104": "Release reference · Native hybrid v3",
	"core-hybrid-b6d020d-20261104": "Hybrid v3 · Earlier revision",
	"core-grouped-20261104": "Native grouped v2",
	"core-native-20261104": "Initial native v2",
	"pre-grouped-92baffb-20261104": "Native v2 · Before grouped transport",
	"core-start-20261104": "Previous engine · Before native rewrite",
	"crdt-comparison": "Previous engine · Final comparison",
	"crdt-comparison-before-independent-audit": "Previous engine · Before fairness audit",
	"crdt-comparison-before-lazy-encoding": "Previous engine · Before deferred encoding",
	"crdt-comparison-before-runtime-simplification": "Previous engine · Before runtime simplification",
	"crdt-comparison-with-schema-validation": "Previous engine · With generic validation",
	"core-hybrid-supplementary-20261104": "Release reference · Native hybrid v3",
	"core-grouped-supplementary-20261104": "Native grouped v2",
	"local-bun": "Previous engine · Final supplementary run",
	"local-bun-before-independent-audit": "Previous engine · Before fairness audit",
	"local-bun-before-lazy-encoding": "Previous engine · Before deferred encoding",
	"local-bun-before-runtime-simplification": "Previous engine · Before runtime simplification",
	"local-bun-with-schema-validation": "Previous engine · With generic validation",
};

const timing: { crdt: TimingRun[]; supplementary: TimingRun[] } = { crdt: [], supplementary: [] };
for (const file of (await readdir(baselines)).sort()) {
	if (!file.endsWith(".json")) continue;
	const path = resolve(baselines, file);
	const run = await readJSON(path);
	if (!run.results?.length) continue;
	const id = file.slice(0, -5);
	if (!timingLabels[id]) throw new Error(`Label the new benchmark reference: ${id}`);
	timing[run.suite === "crdt-comparison" ? "crdt" : "supplementary"].push({
		...run, id, path: sourcePath(path), label: timingLabels[id],
		historical: !id.startsWith("core-hybrid-") || id === "core-hybrid-b6d020d-20261104",
	});
}
for (const runs of Object.values(timing)) runs.sort((a, b) => Number(a.historical) - Number(b.historical) || a.label.localeCompare(b.label));

const campaigns: DatabaseCampaign[] = [];
async function campaign(id: string, label: string, directory: string, folders: string[], note: string, report: string) {
	const item: DatabaseCampaign = { id, label, note, path: report, runs: [] };
	for (const folder of folders) {
		const dir = resolve(baselines, directory, folder);
		for (const file of (await readdir(dir)).sort()) {
			if (!/^(bare-metal|docker)-.*\.json(\.gz)?$/.test(file)) continue;
			const path = resolve(dir, file);
			const data = await readJSON(path);
			if (!data.cells?.length) continue;
			const args = data.arguments;
			const planned = [args.scenarios, args.modes, args.topologies, args.concurrency]
				.reduce((total, value) => total * String(value).split(",").length, 1);
			item.runs.push({
				path: sourcePath(path), backend: args.backend, environment: args.environment,
				profile: data.metadata.profile,
				version: args.backend === "sqlite" ? `SQLite ${data.metadata.sqliteVersion}` : data.metadata.database?.version ?? (args.backend === "foundationdb" ? "FoundationDB 7.3.77 · native C API 730" : "Version recorded in campaign context"),
				plannedCells: planned,
				cells: data.cells.map((cell: DatabaseCell) => ({
					scenario: cell.scenario, mode: cell.mode, topology: cell.topology,
					concurrency: cell.concurrency, maximum_active: cell.maximum_active,
					summary: cell.summary, operations: cell.operations,
				})),
			});
		}
	}
	if (item.runs.length) campaigns.push(item);
}

await campaign("engines", "Engine comparison · All six engines", "database-engines-20261104", ["medium", "large", "large-docker"],
	"Original engine comparison, before the later PostgreSQL / SQLite adapter optimizations. The two large pgrust columnar matrices are incomplete: native recorded 584 timeouts; Docker stopped after a backend OOM. Missing cells are not successful results.",
	"benchmarks/database/RESULTS.md");
const supplemental = "database-engines-20261104/supplemental";
await campaign("fresh-probes", "Fresh isolated recovery probes", supplemental, (await readdir(resolve(baselines, supplemental), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name),
	"Fresh pgrust columnar servers, separate from the main campaign. These successful checkpoints do not replace missing main-series scores. Both fresh spread-compaction attempts also failed with OOM before a checkpoint; see the attempt log.",
	`benchmarks/baselines/${supplemental}/attempts.json`);
await campaign("foundationdb", "Archive · Native FoundationDB comparison", "database-native-20261104", ["medium", "large"],
	"Historical Rust clients, including the native FoundationDB C API. This is a separate campaign, with four exhausted compaction retries. FoundationDB support has since been removed.",
	"benchmarks/database/archive/FOUNDATIONDB-RESULTS.md");
const mixDirectory = "database-mix-optimization-20261104";
for (const folder of (await readdir(resolve(baselines, mixDirectory), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()) {
	if (!/^(baseline|optimized|experiment)-/.test(folder) || folder.includes("failure")) continue;
	await campaign(folder, `Mixed-load tuning · ${folder.replaceAll("-", " ")}`, mixDirectory, [folder],
		"A separate retained mixed-workload tuning run. Compare the same deployment, fixture, concurrency and admission mode. Individual runs are not repeated-run medians; the audited comparison is linked below.",
		`benchmarks/baselines/${mixDirectory}/README.md`);
}

await mkdir(output, { recursive: true });
for (const [name, data] of Object.entries({ "timing-results": timing, "database-results": campaigns })) {
	await writeFile(resolve(output, `${name}.json`), `${JSON.stringify(data)}\n`);
}
console.log(`Benchmarks: ${timing.crdt.length} CRDT runs, ${timing.supplementary.length} protocol runs, ${campaigns.reduce((n, c) => n + c.runs.reduce((sum, run) => sum + run.cells.length, 0), 0)} database cells.`);
