import { SQL } from "bun";
import { PostgresPatchStore } from "../packages/pulse/source/storage/postgres.js";
import type { StoredPatchRow } from "../packages/pulse/source/storage/rows.js";

const url = process.env["PULSIFY_POSTGRES_URL"];
if (!url)
	throw new Error(
		"Set PULSIFY_POSTGRES_URL to a disposable benchmark database",
	);
const sql = new SQL(url);
const store = new PostgresPatchStore((statement, values) =>
	sql.unsafe(statement, values as never[]),
);
await store.initialize();
const results: Array<Record<string, unknown>> = [];
try {
	for (const count of [1, 100, 1000]) {
		const appendTimes: number[] = [],
			queryTimes: number[] = [];
		for (let run = 0; run < 8; run++) {
			const docId = `storage-bench-${crypto.randomUUID()}`;
			const rows: StoredPatchRow[] = Array.from(
				{ length: count },
				(_, index) => ({
					docId,
					sid: 70001,
					clock: index + 1,
					span: 1,
					dependencies: index ? [[70001, index + 1]] : [],
					operations: new Uint8Array(128).fill(73),
				}),
			);
			let started = performance.now();
			await store.append(rows);
			appendTimes.push(performance.now() - started);
			started = performance.now();
			const missing = await store.missing(docId, [
				[70001, Math.max(1, count - 9)],
			]);
			queryTimes.push(performance.now() - started);
			if (missing.length !== Math.min(count, 10))
				throw new Error("Benchmark delta mismatch");
			await sql.unsafe("DELETE FROM pulsify_op_rows WHERE doc_id=$1", [docId]);
			await sql.unsafe("DELETE FROM pulsify_doc_clocks WHERE doc_id=$1", [
				docId,
			]);
		}
		const upperMedian = (times: number[]): number =>
			times.slice(2).sort((a, b) => a - b)[Math.floor((times.length - 2) / 2)]!;
		results.push({
			rows: count,
			payloadBytesPerRow: 128,
			appendUpperMedianMs: upperMedian(appendTimes),
			deltaTenUpperMedianMs: upperMedian(queryTimes),
			measuredRuns: 6,
			warmupRuns: 2,
		});
	}
	console.log(
		JSON.stringify(
			{
				runtime: Bun.version,
				database: (await sql.unsafe("SHOW server_version"))[0]?.server_version,
				results,
			},
			null,
			2,
		),
	);
} finally {
	await sql.close();
}
