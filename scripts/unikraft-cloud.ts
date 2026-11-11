// Stage a self-contained build context for the Unikraft Cloud image, then
// build it with the unikraft CLI (or Docker, to run it locally).
//   bun run cloud:unikraft -- --output my-org/pulsify-cloud:latest
//   bun run cloud:unikraft --docker pulsify-cloud
import { cp, mkdir, rm } from "node:fs/promises";
import { parseArgs } from "node:util";

const root = new URL("../", import.meta.url).pathname;
const { values, positionals } = parseArgs({
	options: { docker: { type: "string" } },
	allowPositionals: true,
	strict: false,
});
const context = `${root}packages/cloud-server/unikraft-cloud/.build`;
await rm(context, { recursive: true, force: true });
await mkdir(context, { recursive: true });
// The context mirrors the repository layout the Dockerfile expects.
for (const path of [
	"crates/pulsify-protocol/Cargo.toml",
	"crates/pulsify-protocol/src",
	"packages/cloud-server/unikraft-cloud/server/Cargo.toml",
	"packages/cloud-server/unikraft-cloud/server/Cargo.lock",
	"packages/cloud-server/unikraft-cloud/server/src",
	"packages/cloud-server/unikraft-cloud/server/sql",
	"packages/cloud-server/unikraft-cloud/rootfs",
])
	await cp(`${root}${path}`, `${context}/${path}`, { recursive: true });
for (const file of ["Kraftfile", "Dockerfile"])
	await cp(
		`${root}packages/cloud-server/unikraft-cloud/${file}`,
		`${context}/${file}`,
	);

const command =
	typeof values.docker === "string"
		? ["docker", "build", "-t", values.docker, context]
		: Bun.which("unikraft")
			? ["unikraft", "build", context, ...positionals]
			: undefined;
if (!command) {
	console.log(
		`Build context staged in ${context}\nInstall the unikraft CLI, then run: unikraft build ${context} --output <org>/pulsify-cloud:latest`,
	);
	process.exit(0);
}
const build = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
process.exit(await build.exited);
