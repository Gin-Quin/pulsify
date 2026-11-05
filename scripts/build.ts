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

for (const name of ["pulsify-prosemirror", "pulsify-lexical"]) {
	const directory = `${root}packages/${name}`;
	const manifest = await Bun.file(`${directory}/package.json`).json();
	await rm(`${directory}/dist`, { recursive: true, force: true });
	const adapter = await Bun.build({
		entrypoints: [`${directory}/source/index.ts`],
		outdir: `${directory}/dist`,
		target: "browser",
		format: "esm",
		sourcemap: "external",
		minify: true,
		external: [
			...Object.keys(manifest.peerDependencies),
			...Object.keys(manifest.dependencies ?? {}),
			"@pulsify/core/*",
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
