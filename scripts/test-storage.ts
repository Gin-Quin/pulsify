import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These containers and temporary files belong exclusively to this invocation.
const suffix = `${process.pid}-${Date.now()}`;
const postgres = `pulsify-postgres-${suffix}`,
	fdb = `pulsify-fdb-${suffix}`;
const directory = await mkdtemp(join(tmpdir(), "pulsify-storage-"));
function docker(args: string[], required = true): string {
	const result = Bun.spawnSync(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (required && result.exitCode !== 0)
		throw new Error(new TextDecoder().decode(result.stderr));
	return new TextDecoder().decode(result.stdout).trim();
}
async function ready(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (check()) return;
		await Bun.sleep(500);
	}
	throw new Error("Database startup timed out");
}
try {
	docker([
		"run",
		"--rm",
		"-d",
		"--name",
		postgres,
		"-e",
		"POSTGRES_PASSWORD=pulsify-test-only",
		"-e",
		"POSTGRES_DB=pulsify",
		"-p",
		"127.0.0.1::5432",
		"postgres:16-alpine",
	]);
	docker([
		"run",
		"--rm",
		"-d",
		"--name",
		fdb,
		"-e",
		"FDB_NETWORKING_MODE=container",
		"foundationdb/foundationdb:7.3.77",
	]);
	await ready(() =>
		docker(["exec", postgres, "pg_isready"], false).includes(
			"accepting connections",
		),
	);
	const configured = docker([
		"exec",
		fdb,
		"fdbcli",
		"--timeout",
		"20",
		"--exec",
		"configure new single memory",
	]);
	if (
		!configured.includes("Database created") &&
		!configured.includes("already exists")
	)
		throw new Error("Cannot configure FoundationDB");
	await ready(() =>
		docker(
			["exec", fdb, "fdbcli", "--timeout", "3", "--exec", "status minimal"],
			false,
		).includes("The database is available"),
	);
	const metadataResponse = await fetch(
		"https://pypi.org/pypi/foundationdb/7.3.77/json",
	);
	if (!metadataResponse.ok)
		throw new Error(
			"Cannot download official FoundationDB Python test binding",
		);
	const metadata = (await metadataResponse.json()) as {
		urls: Array<{ packagetype: string; url: string }>;
	};
	const sourceUrl = metadata.urls.find(
		(item) => item.packagetype === "sdist",
	)?.url;
	if (!sourceUrl?.startsWith("https://files.pythonhosted.org/"))
		throw new Error("Unexpected FoundationDB binding source");
	const sourceResponse = await fetch(sourceUrl);
	if (!sourceResponse.ok)
		throw new Error("Cannot download FoundationDB source archive");
	const bytes = new Uint8Array(await sourceResponse.arrayBuffer());
	if (
		new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !==
		"60ffda04fd49968b5c992104160b2147d04e55bdddeaa5d5e78c7f0baf0d211d"
	)
		throw new Error("FoundationDB source checksum mismatch");
	const source = join(directory, "foundationdb.tar.gz");
	await writeFile(source, bytes);
	docker(["cp", source, `${fdb}:/tmp/fdb-python.tar.gz`]);
	docker([
		"cp",
		new URL("./fdb-test-bridge.py", import.meta.url).pathname,
		`${fdb}:/tmp/pulsify-fdb-test-bridge.py`,
	]);
	docker([
		"exec",
		fdb,
		"sh",
		"-lc",
		"mkdir -p /tmp/fdb-python && tar xzf /tmp/fdb-python.tar.gz -C /tmp/fdb-python --strip-components=1",
	]);
	const port = docker(["port", postgres, "5432/tcp"]).split(":").at(-1)!;
	const child = Bun.spawn(
		["bun", "test", "packages/pulse/tests/storage.test.ts"],
		{
			cwd: new URL("../", import.meta.url).pathname,
			env: {
				...process.env,
				PULSIFY_POSTGRES_URL: `postgres://postgres:pulsify-test-only@127.0.0.1:${port}/pulsify`,
				PULSIFY_FDB_DOCKER: fdb,
			},
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const code = await child.exited;
	if (code !== 0) process.exitCode = code;
} finally {
	docker(["stop", postgres, fdb], false);
	await rm(directory, { recursive: true, force: true });
}
