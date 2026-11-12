/** Read the raw reports that `campaign.sh` leaves: one folder per engine. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export interface Summary {
	requests: number;
	success: number;
	errors: number;
	throughput_per_sec: number;
	service: { p50_ms: number; p99_ms: number };
}
export interface Run {
	engine: string;
	cores: number;
	/** Edits in the history of the document the clients work on. */
	edits: number;
	durability: string;
	/** What the engine reports about its own configuration. */
	database: Record<string, unknown>;
	cells: {
		scenario: string;
		clients: number;
		summary: Summary;
		/** Payload bytes the cell left in the database, read back after it. */
		storedBytes: number;
	}[];
}
export interface Size {
	/** Size of the engine's whole data directory after the last cell. */
	bytes: number;
	/** PostgreSQL only: the tables and indexes, and the write-ahead log beside them. */
	databaseBytes?: number;
	walBytes?: number;
}

export async function loadCampaign(dir: string) {
	const runs: Run[] = [];
	const sizes: Record<string, Size> = {};
	const folders = await readdir(dir, { withFileTypes: true });
	for (const folder of folders.filter((entry) => entry.isDirectory())) {
		const engine = folder.name;
		const files = await readdir(join(dir, engine));
		if (files.includes("size.json"))
			sizes[engine] = JSON.parse(
				await readFile(join(dir, engine, "size.json"), "utf8"),
			);
		for (const file of files.filter((name) => name.endsWith(".json.gz"))) {
			const report = JSON.parse(
				gunzipSync(await readFile(join(dir, engine, file))).toString(),
			);
			runs.push({
				engine,
				cores: report.metadata.cpus,
				edits: Number(report.metadata.profile.replace("edits-", "")),
				durability: report.arguments.durability,
				database: report.metadata.database,
				cells: report.cells.map(
					(cell: {
						scenario: string;
						concurrency: number;
						summary: Summary;
						stored_payload_bytes: number;
					}) => ({
						scenario: cell.scenario,
						clients: cell.concurrency,
						summary: cell.summary,
						storedBytes: cell.stored_payload_bytes,
					}),
				),
			});
		}
	}
	return { runs, sizes };
}
