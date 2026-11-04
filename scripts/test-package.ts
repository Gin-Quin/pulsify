import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), "pulsify-consumer-"));
const archive = join(directory, "pulsify-core.tgz");
async function run(command: string[], cwd: string): Promise<string> {
	const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code !== 0) throw new Error(`${command.join(" ")}\n${stdout}\n${stderr}`);
	return stdout;
}
try {
	await run(
		["bun", "pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet"],
		`${root}packages/pulse`,
	);
	await Bun.write(
		join(directory, "package.json"),
		JSON.stringify({
			name: "pulsify-consumer",
			private: true,
			type: "module",
			dependencies: { "@pulsify/core": `file:${archive}` },
		}),
	);
	await Bun.write(join(directory, ".npmrc"), Bun.file(`${root}.npmrc`));
	await run(["bun", "install", "--ignore-scripts"], directory);
	await Bun.write(
		join(directory, "consumer.mts"),
		Bun.file(`${root}fixtures/consumer.mts`),
	);
	await Bun.write(
		join(directory, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				skipLibCheck: false,
				module: "NodeNext",
				moduleResolution: "NodeNext",
				target: "ES2023",
				lib: ["ESNext", "DOM"],
				types: [],
			},
			files: ["consumer.mts"],
		}),
	);
	await run([`${root}node_modules/.bin/tsc`, "-p", "tsconfig.json"], directory);
	const smoke = (await Bun.file(`${root}tests/runtime-smoke.mjs`).text())
		.replaceAll("../packages/pulse/dist/index.js", "@pulsify/core")
		.replaceAll("../packages/pulse/dist/protocol.js", "@pulsify/core/protocol");
	await Bun.write(join(directory, "runtime.mjs"), smoke);
	await run(["node", "runtime.mjs"], directory);
	console.log(
		JSON.stringify({
			package: "packed tarball",
			declarations: "NodeNext strict passed",
			runtime: "Node passed",
			sharedClasses: "passed",
		}),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
