import { rm } from "node:fs/promises";
const root = new URL("../", import.meta.url).pathname;
const outdir = `${root}packages/pulse/dist`;
await rm(outdir, { recursive: true, force: true });
const result = await Bun.build({
	entrypoints: [
		`${root}packages/pulse/source/index.ts`,
		`${root}packages/pulse/source/protocol.ts`,
		`${root}packages/pulse/source/storage.ts`,
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
