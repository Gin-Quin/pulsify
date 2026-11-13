import { rm } from "node:fs/promises";
const root = new URL("../", import.meta.url).pathname;
const outdir = `${root}packages/pulse/dist`;
await rm(outdir, { recursive: true, force: true });
const result = await Bun.build({
	entrypoints: [
		`${root}packages/pulse/source/index.ts`,
		`${root}packages/pulse/source/protocol.ts`,
		`${root}packages/pulse/source/storage.ts`,
		`${root}packages/pulse/source/bindings.ts`,
	],
	outdir,
	target: "browser",
	format: "esm",
	splitting: true,
	sourcemap: "external",
	minify: true,
	external: ["@gin-quin/codec"],
});
if (!result.success) throw new AggregateError(result.logs, "Build failed");
const declarations = Bun.spawn(
	[
		"bun",
		"x",
		"--no-install",
		"tsc",
		"-p",
		"packages/pulse/tsconfig.build.json",
	],
	{ cwd: root, stdout: "inherit", stderr: "inherit" },
);
if ((await declarations.exited) !== 0)
	throw new Error("Declaration build failed");
console.log(
	JSON.stringify({
		outputs: result.outputs.map((file) => ({
			path: file.path.replace(root, ""),
			bytes: file.size,
		})),
	}),
);

for (const name of [
	"pulsify-prosemirror",
	"pulsify-lexical",
	"pulsify-codemirror",
	"cloud",
	"cloud-server/core",
	"cloud-server/cloudflare",
	"cloud-server/unikraft-cloud",
	"connectors/IndexedDB",
	"connectors/Electron",
	"connectors/Tauri",
	"pulsify-react",
	"pulsify-svelte",
	"pulsify-vue",
	"pulsify-solid",
]) {
	const directory = `${root}packages/${name}`;
	// Cloud server parts share one manifest: core is ".", the others "./<name>".
	const [packageDirectory, subpath] = name.startsWith("cloud-server/")
		? [`${root}packages/cloud-server`, name.slice("cloud-server/".length)]
		: [directory, undefined];
	const manifest = await Bun.file(`${packageDirectory}/package.json`).json();
	const outdir = subpath
		? `${packageDirectory}/dist/${subpath}`
		: `${directory}/dist`;
	await rm(outdir, { recursive: true, force: true });
	// One entry per export: "." is source/index.ts, "./main" is source/main.ts.
	const entries = subpath
		? ["index"]
		: Object.keys(manifest.exports ?? { ".": null }).map((key) =>
				key === "." ? "index" : key.slice(2),
			);
	const adapter = await Bun.build({
		entrypoints: entries.map((entry) => `${directory}/source/${entry}.ts`),
		outdir,
		splitting: entries.length > 1,
		target: "browser",
		format: "esm",
		sourcemap: "external",
		minify: true,
		external: [
			...Object.keys(manifest.peerDependencies),
			...Object.keys(manifest.dependencies ?? {}),
			"pulsify-core/*",
			"pulsify-cloud",
			"pulsify-cloud-server",
			"pulsify-cloud-server/*",
		],
	});
	if (!adapter.success)
		throw new AggregateError(adapter.logs, `Cannot build ${name}`);
	const types = Bun.spawn(
		[
			"bun",
			"x",
			"--no-install",
			"tsc",
			"-p",
			`${directory}/tsconfig.build.json`,
		],
		{ cwd: root, stdout: "inherit", stderr: "inherit" },
	);
	if ((await types.exited) !== 0)
		throw new Error(`Declaration build failed for ${name}`);
	console.log(
		JSON.stringify({ package: name, bytes: adapter.outputs[0]!.size }),
	);
}
