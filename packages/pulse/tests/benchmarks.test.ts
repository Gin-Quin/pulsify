import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("performance comparison flags real regressions and refuses incompatible baselines", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pulsify-bench-test-"));
	try {
		const reference = {
			schemaVersion: 1,
			environment: {
				runtime: "bun-test",
				codec: "2.1.0",
				jsonJoy: "18.28.0",
				yjs: "13.6.33",
				loro: "1.17.1",
				loroBackend: "wasm-nodejs",
				platform: "test",
				arch: "test",
				cpu: "test",
			},
			parameters: { samples: 25 },
			results: [
				{
					name: "core/mutate",
					iterations: 10,
					sampleMeanUs: { median: 10 },
					metrics: { bytes: 100 },
				},
			],
			memory: { historyHeapBytes: 100_000 },
		};
		const path = join(directory, "baseline.json");
		const candidate = join(directory, "current.json");
		await Bun.write(path, JSON.stringify(reference));
		const compare = (strict: boolean) =>
			Bun.spawnSync([
				"bun",
				new URL("../../../benchmarks/compare.ts", import.meta.url).pathname,
				path,
				candidate,
				...(strict ? ["--strict"] : []),
			]);
		await Bun.write(candidate, JSON.stringify(reference));
		expect(compare(true).exitCode).toBe(0);
		const regression = structuredClone(reference);
		regression.results[0]!.sampleMeanUs.median = 20;
		regression.memory.historyHeapBytes = 250_000;
		await Bun.write(candidate, JSON.stringify(regression));
		expect(compare(false).exitCode).toBe(0);
		const result = compare(true);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.toString()).regressions).toHaveLength(2);
		regression.environment.cpu = "different";
		await Bun.write(candidate, JSON.stringify(regression));
		expect(compare(false).exitCode).not.toBe(0);
		for (const field of ["yjs", "loro", "loroBackend"] as const) {
			const incompatible = structuredClone(reference);
			incompatible.environment[field] = "different";
			await Bun.write(candidate, JSON.stringify(incompatible));
			expect(compare(false).exitCode).not.toBe(0);
		}
		const differentIterations = structuredClone(reference);
		differentIterations.results[0]!.iterations = 20;
		await Bun.write(candidate, JSON.stringify(differentIterations));
		const incompatibleIterations = compare(false);
		expect(incompatibleIterations.exitCode).not.toBe(0);
		expect(incompatibleIterations.stderr.toString()).toContain(
			"Benchmark iteration counts differ",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
