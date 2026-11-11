// Start a Pulsify Cloud backend locally and run the conformance suite against it.
//   bun run test:cloud --backend cloudflare        workerd, real Durable Objects
//   bun run test:cloud --backend unikraft          Rust server + local PostgreSQL
//   bun run test:cloud --backend unikraft --image pulsify-cloud
//                                                  the Unikraft Cloud image, with Docker
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const root = new URL("../", import.meta.url).pathname;
const { values } = parseArgs({
	options: {
		backend: { type: "string", default: "cloudflare" },
		image: { type: "string" },
	},
});
const secrets = {
	PULSIFY_TOKEN_SECRET: "a local token secret of at least 32 characters",
	PULSIFY_API_KEY: "a local api key of at least thirty-two characters",
};
const directory = await mkdtemp(join(tmpdir(), "pulsify-cloud-"));
const cleanups: (() => Promise<unknown> | unknown)[] = [];

function freePort(): number {
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const { port } = listener;
	listener.stop(true);
	return port;
}

function start(
	command: string[],
	options: Parameters<typeof Bun.spawn>[1] = {},
) {
	const child = Bun.spawn(command, {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
		...options,
	});
	cleanups.push(async () => {
		child.kill();
		await child.exited;
	});
	return child;
}

async function run(
	command: string[],
	options: Parameters<typeof Bun.spawn>[1] = {},
) {
	const child = Bun.spawn(command, {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
		...options,
	});
	if ((await child.exited) !== 0)
		throw new Error(`Command failed: ${command.join(" ")}`);
}

async function waitForHealth(url: string, timeoutMs = 60_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			if ((await fetch(`${url}/v1/health`)).ok) return;
		} catch {
			// Not listening yet.
		}
		await Bun.sleep(200);
	}
	throw new Error(`${url} did not become healthy`);
}

async function startCloudflare(): Promise<string> {
	const result = await Bun.build({
		entrypoints: [`${root}packages/cloud-server/cloudflare/worker.ts`],
		outdir: directory,
		naming: "worker.js",
		target: "browser",
		format: "esm",
	});
	if (!result.success)
		throw new AggregateError(result.logs, "Cloudflare bundle failed");
	const storage = join(directory, "storage");
	await mkdir(storage);
	const port = freePort();
	const config = join(directory, "worker.capnp");
	await Bun.write(
		config,
		`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "pulsify", worker = (
    modules = [(name = "worker.js", esModule = embed "worker.js")],
    compatibilityDate = "2026-11-05",
    compatibilityFlags = ["no_nodejs_compat", "no_nodejs_compat_v2"],
    durableObjectNamespaces = [(className = "PulsifyCloudRoot", uniqueKey = "pulsify-cloud-root", enableSql = true)],
    durableObjectStorage = (localDisk = "storage"),
    bindings = [
      (name = "PULSIFY_ROOTS", durableObjectNamespace = "PulsifyCloudRoot"),
      (name = "PULSIFY_TOKEN_SECRET", text = "${secrets.PULSIFY_TOKEN_SECRET}"),
      (name = "PULSIFY_API_KEY", text = "${secrets.PULSIFY_API_KEY}"),
    ],
  )), (name = "storage", disk = (path = "${storage}", writable = true))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "pulsify")],
);
`,
	);
	start(["bun", "x", "workerd@1.20261104.1", "serve", config]);
	return `http://127.0.0.1:${port}`;
}

async function startUnikraft(): Promise<string> {
	const port = freePort();
	if (values.image) {
		const name = `pulsify-cloud-test-${port}`;
		await run([
			"docker",
			"run",
			"-d",
			"--rm",
			"--name",
			name,
			"-p",
			`127.0.0.1:${port}:8080`,
			"-e",
			`PULSIFY_TOKEN_SECRET=${secrets.PULSIFY_TOKEN_SECRET}`,
			"-e",
			`PULSIFY_API_KEY=${secrets.PULSIFY_API_KEY}`,
			values.image,
		]);
		cleanups.push(() => run(["docker", "stop", name]).catch(() => {}));
		return `http://127.0.0.1:${port}`;
	}
	const manifest = "packages/cloud-server/unikraft-cloud/server/Cargo.toml";
	await run(["cargo", "build", "--release", "--manifest-path", manifest]);
	const data = join(directory, "postgres");
	await run(
		["initdb", "-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"],
		{
			stdout: "ignore",
		},
	);
	start(
		[
			"postgres",
			"-D",
			data,
			"-c",
			"listen_addresses=",
			"-c",
			`unix_socket_directories=${directory}`,
		],
		{ stdout: "ignore" },
	);
	for (let i = 0; ; i++) {
		const ready = Bun.spawn([
			"pg_isready",
			"-q",
			"-U",
			"postgres",
			"-h",
			directory,
		]);
		if ((await ready.exited) === 0) break;
		if (i > 100) throw new Error("PostgreSQL did not start");
		await Bun.sleep(100);
	}
	start(
		[
			`${root}packages/cloud-server/unikraft-cloud/server/target/release/pulsify-cloud-server`,
		],
		{
			env: {
				...process.env,
				...secrets,
				PORT: String(port),
				DATABASE_URL: `host=${directory} user=postgres dbname=postgres`,
			},
		},
	);
	return `http://127.0.0.1:${port}`;
}

let status = 1;
try {
	const backend =
		values.backend === "unikraft" ? "Unikraft Cloud" : "Cloudflare";
	const url =
		values.backend === "unikraft"
			? await startUnikraft()
			: await startCloudflare();
	await waitForHealth(url);
	const tests = Bun.spawn(["bun", "test", "tests/cloud-backend.test.ts"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
		env: {
			...process.env,
			...secrets,
			PULSIFY_CLOUD_URL: url,
			PULSIFY_CLOUD_BACKEND: backend,
		},
	});
	status = await tests.exited;
} finally {
	for (const cleanup of cleanups.reverse()) await cleanup();
	await rm(directory, { recursive: true, force: true });
}
process.exit(status);
