// Start a Pulsify Cloud backend locally and run the conformance suite against it.
//   bun run test:cloud --backend cloudflare        workerd, real Durable Objects
//   bun run test:cloud --backend service           the hosted service, through a project
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const root = new URL("../", import.meta.url).pathname;
const { values } = parseArgs({
	options: {
		backend: { type: "string", default: "cloudflare" },
	},
});
if (values.backend !== "cloudflare" && values.backend !== "service")
	throw new Error("Use --backend cloudflare or --backend service");

const secrets = {
	PULSIFY_TOKEN_SECRET: "a local token secret of at least 32 characters",
	PULSIFY_API_KEY: "a local api key of at least thirty-two characters",
};
// A root compacts 60 s after its last socket closed: too long for a test.
const compactAfterMs = 1000;
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

async function waitForHealth(url: string, timeoutMs = 60_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			if ((await fetch(url)).ok) return;
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
      (name = "PULSIFY_COMPACT_AFTER_MS", text = "${compactAfterMs}"),
    ],
  )), (name = "storage", disk = (path = "${storage}", writable = true))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "pulsify")],
);
`,
	);
	start(["bun", "x", "workerd@1.20261104.1", "serve", config]);
	return `http://127.0.0.1:${port}`;
}

type Backend = {
	url: string;
	tokenSecret: string;
	apiKey: string;
	/** The service only: the project's usage, as its dashboard shows it. */
	usage?: () => Promise<{ messages: number; bytes: number }>;
};

async function bundle(entry: string, naming: string) {
	const result = await Bun.build({
		entrypoints: [`${root}${entry}`],
		outdir: directory,
		naming,
		target: "browser",
		format: "esm",
		external: ["cloudflare:workers"],
	});
	if (!result.success)
		throw new AggregateError(result.logs, `${entry} bundle failed`);
}

/**
 * The hosted service in workerd, its emails kept by a mailbox worker. Signs
 * up through a login link and returns the project's URL and secrets.
 */
async function startService(): Promise<Backend> {
	await bundle("packages/cloud-service/worker.ts", "service.js");
	await Bun.write(
		join(directory, "mailbox.js"),
		`import { WorkerEntrypoint } from "cloudflare:workers";
const sent = [];
export class Mailbox extends WorkerEntrypoint {
  async send(message) { sent.push(message); return { messageId: String(sent.length) }; }
}
export default { fetch: () => Response.json(sent) };
`,
	);
	const storage = join(directory, "storage");
	await mkdir(storage);
	const port = freePort();
	const mailPort = freePort();
	const url = `http://127.0.0.1:${port}`;
	const text = (name: string, value: string) =>
		`(name = "${name}", text = "${value}")`;
	const objects = ["PulsifyRoot", "PulsifyProject", "PulsifyAccount"];
	const config = join(directory, "service.capnp");
	await Bun.write(
		config,
		`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "pulsify", worker = (
    modules = [(name = "worker.js", esModule = embed "service.js")],
    compatibilityDate = "2026-11-05",
    compatibilityFlags = ["no_nodejs_compat", "no_nodejs_compat_v2"],
    durableObjectNamespaces = [${objects.map((name) => `(className = "${name}", uniqueKey = "${name}", enableSql = true)`).join(", ")}],
    durableObjectStorage = (localDisk = "storage"),
    bindings = [
      (name = "ROOTS", durableObjectNamespace = "PulsifyRoot"),
      (name = "PROJECTS", durableObjectNamespace = "PulsifyProject"),
      (name = "ACCOUNTS", durableObjectNamespace = "PulsifyAccount"),
      (name = "EMAIL", service = (name = "mailbox", entrypoint = "Mailbox")),
      ${[
				text("API_URL", url),
				text("DASHBOARD_URL", "https://site.test/dashboard"),
				text("EMAIL_FROM", "login@site.test"),
				text("POLAR_API_URL", "http://127.0.0.1:9"),
				text("POLAR_ACCESS_TOKEN", "unused"),
				text("POLAR_WEBHOOK_SECRET", "unused"),
				text("POLAR_PRO_MONTHLY", "pro-monthly"),
				text("POLAR_PRO_YEARLY", "pro-yearly"),
				text("PULSIFY_COMPACT_AFTER_MS", String(compactAfterMs)),
			].join(",\n      ")},
    ],
  )), (name = "mailbox", worker = (
    modules = [(name = "mailbox.js", esModule = embed "mailbox.js")],
    compatibilityDate = "2026-11-05",
  )), (name = "storage", disk = (path = "${storage}", writable = true))],
  sockets = [
    (name = "http", address = "127.0.0.1:${port}", http = (), service = "pulsify"),
    (name = "mail", address = "127.0.0.1:${mailPort}", http = (), service = "mailbox"),
  ],
);
`,
	);
	start(["bun", "x", "workerd@1.20261104.1", "serve", config]);
	await waitForHealth(`${url}/health`);
	await fetch(`${url}/account/login`, {
		method: "POST",
		headers: {
			Origin: "https://site.test",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ email: "conformance@example.com" }),
	});
	const [mail] = (await (
		await fetch(`http://127.0.0.1:${mailPort}`)
	).json()) as {
		text: string;
	}[];
	const link = mail!.text.match(/http:\/\/\S+/)![0];
	const verified = await fetch(link, { redirect: "manual" });
	const cookie = verified.headers.get("Set-Cookie")!.split(";")[0]!;
	const dashboard = (await (
		await fetch(`${url}/account`, { headers: { Cookie: cookie } })
	).json()) as Backend & { tokenSecret: string; apiKey: string };
	return {
		url: dashboard.url,
		tokenSecret: dashboard.tokenSecret,
		apiKey: dashboard.apiKey,
		usage: async () =>
			(
				(await (
					await fetch(`${url}/account`, { headers: { Cookie: cookie } })
				).json()) as { usage: { messages: number; bytes: number } }
			).usage,
	};
}

let status = 1;
try {
	const backend: Backend =
		values.backend === "service"
			? await startService()
			: {
					url: await startCloudflare(),
					tokenSecret: secrets.PULSIFY_TOKEN_SECRET,
					apiKey: secrets.PULSIFY_API_KEY,
				};
	const { url } = backend;
	await waitForHealth(`${url}/v1/health`);
	const tests = Bun.spawn(["bun", "test", "tests/cloud-backend.test.ts"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
		env: {
			...process.env,
			PULSIFY_TOKEN_SECRET: backend.tokenSecret,
			PULSIFY_API_KEY: backend.apiKey,
			PULSIFY_CLOUD_URL: url,
			PULSIFY_CLOUD_BACKEND:
				values.backend === "service" ? "Pulsify Cloud service" : "Cloudflare",
			// workerd evicts a Durable Object whose sockets hibernate after 10 s.
			PULSIFY_CLOUD_HIBERNATES_MS: "12000",
			PULSIFY_CLOUD_COMPACTS_MS: String(compactAfterMs),
		},
	});
	status = await tests.exited;
	if (status === 0 && backend.usage) {
		// The roots reported what the suite sent to the project.
		const usage = await backend.usage();
		console.log("Project usage after the suite:", usage);
		if (!(usage.messages > 0 && usage.bytes > 0)) status = 1;
	}
} finally {
	for (const cleanup of cleanups.reverse()) await cleanup();
	await rm(directory, { recursive: true, force: true });
}
process.exit(status);
