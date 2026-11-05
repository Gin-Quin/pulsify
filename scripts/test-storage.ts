// These containers and temporary files belong exclusively to this invocation.
const suffix = `${process.pid}-${Date.now()}`;
const postgres = `pulsify-postgres-${suffix}`;
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
	await ready(() =>
		docker(["exec", postgres, "pg_isready"], false).includes(
			"accepting connections",
		),
	);
	const port = docker(["port", postgres, "5432/tcp"]).split(":").at(-1)!;
	const child = Bun.spawn(
		["bun", "test", "packages/pulse/tests/storage.test.ts"],
		{
			cwd: new URL("../", import.meta.url).pathname,
			env: {
				...process.env,
				PULSIFY_POSTGRES_URL: `postgres://postgres:pulsify-test-only@127.0.0.1:${port}/pulsify`,
			},
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const code = await child.exited;
	if (code !== 0) process.exitCode = code;
} finally {
	docker(["stop", postgres], false);
}
