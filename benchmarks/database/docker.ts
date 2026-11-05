import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const args = process.argv.slice(2);
if (args.includes("--help")) {
	console.log(`Usage: bun run bench:database [--quick] [--samples N] [--warmup N]
  [--databases postgres,sqlite] [--profiles small,medium,large]
  [--results-dir PATH] [--test-only]

Builds an isolated Docker Compose stack, runs database conformance tests and the benchmark,
writes database.json + database.md, then removes its containers and volumes.`);
	process.exit(0);
}
const directoryIndex = args.indexOf("--results-dir");
const results = resolve(
	root,
	directoryIndex === -1
		? "benchmarks/results"
		: (args[directoryIndex + 1] ?? ""),
);
if (directoryIndex !== -1) args.splice(directoryIndex, 2);
if (args.includes("--output") || args.includes("--markdown"))
	throw new Error("Use --results-dir to choose the Docker report directory");
const testOnly = args.includes("--test-only");
if (testOnly) args.splice(args.indexOf("--test-only"), 1);
await mkdir(results, { recursive: true });
const project = `pulsify-db-bench-${process.pid}-${Date.now()}`;
const compose = [
	"docker",
	"compose",
	"-p",
	project,
	"-f",
	"benchmarks/database/compose.yaml",
];
const env: Record<string, string | undefined> = {
	...process.env,
	BENCH_RESULTS_DIR: results,
};
async function command(
	argv: string[],
	capture = false,
	required = true,
): Promise<string> {
	const child = Bun.spawn(argv, {
		cwd: root,
		env,
		stdout: capture ? "pipe" : "inherit",
		stderr: capture ? "pipe" : "inherit",
	});
	const [stdout, stderr, code] = await Promise.all([
		capture ? new Response(child.stdout).text() : Promise.resolve(""),
		capture ? new Response(child.stderr).text() : Promise.resolve(""),
		child.exited,
	]);
	if (required && code !== 0)
		throw new Error(
			`${argv.slice(0, 4).join(" ")} failed (${code}): ${stderr || stdout}`,
		);
	return stdout.trim();
}
env["BENCH_COMMIT"] = await command(["git", "rev-parse", "HEAD"], true);
env["BENCH_DIRTY"] = String(
	!!(await command(["git", "status", "--porcelain"], true)),
);
let cleaning: Promise<unknown> | undefined;
function cleanup() {
	return (cleaning ??= command(
		[...compose, "down", "--volumes", "--remove-orphans"],
		false,
		false,
	));
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		void cleanup().finally(() => process.exit(130));
	});
try {
	await command([...compose, "build", "benchmark"]);
	await command([
		...compose,
		"up",
		"-d",
		"--wait",
		"--wait-timeout",
		"90",
		"postgres",
	]);
	const ids = (await command([...compose, "ps", "-q"], true))
		.split("\n")
		.filter(Boolean);
	const images = JSON.parse(
		await command(
			["docker", "inspect", ...ids, "--format", "{{json .}}"],
			true,
		).then((output) => `[${output.split("\n").join(",")}]`),
	) as { Config: { Image: string }; Image: string }[];
	const runnerImage = await command(
		[
			"docker",
			"image",
			"inspect",
			`${project}-benchmark`,
			"--format",
			"{{.Id}}",
		],
		true,
	);
	const dockerInfo = JSON.parse(
		await command(["docker", "info", "--format", "{{json .}}"], true),
	) as Record<string, unknown>;
	env["BENCH_INFRASTRUCTURE"] = JSON.stringify({
		project,
		images: images.map((image) => ({
			reference: image.Config.Image,
			id: image.Image,
		})),
		runnerImage,
		docker: {
			version: dockerInfo["ServerVersion"],
			architecture: dockerInfo["Architecture"],
			cpus: dockerInfo["NCPU"],
			memoryBytes: dockerInfo["MemTotal"],
			kernel: dockerInfo["KernelVersion"],
		},
	});
	await command([
		...compose,
		"run",
		"--rm",
		"benchmark",
		"test",
		"benchmarks/database/store.test.ts",
		"--timeout",
		"60000",
	]);
	if (!testOnly)
		await command([
			...compose,
			"run",
			"--rm",
			"benchmark",
			"benchmarks/database/runner.ts",
			...args,
			"--output",
			"/results/database.json",
			"--markdown",
			"/results/database.md",
		]);
	console.log(`Database suite completed. Reports directory: ${results}`);
} catch (error) {
	await command([...compose, "logs", "--tail", "40"], false, false);
	throw error;
} finally {
	await cleanup();
}
