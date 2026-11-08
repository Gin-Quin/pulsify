import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), "pulsify-workers-"));
try {
	const result = await Bun.build({
		entrypoints: [`${root}tests/worker-runtime-smoke.mjs`],
		outdir: directory,
		target: "browser",
		format: "esm",
	});
	if (!result.success)
		throw new AggregateError(result.logs, "Worker bundle failed");
	const config = join(directory, "worker.capnp");
	await Bun.write(
		config,
		`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "pulsify", worker = (
    modules = [(name = "worker.mjs", esModule = embed "worker-runtime-smoke.js")],
    compatibilityDate = "2026-11-05",
    compatibilityFlags = ["no_nodejs_compat", "no_nodejs_compat_v2"]
  ))]
);
`,
	);
	const command = Bun.spawn(
		["bun", "x", "workerd@1.20261104.1", "test", config],
		{
			cwd: root,
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const timer = setTimeout(() => command.kill(), 30_000);
	try {
		if ((await command.exited) !== 0)
			throw new Error("Workers runtime smoke test failed");
	} finally {
		clearTimeout(timer);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
