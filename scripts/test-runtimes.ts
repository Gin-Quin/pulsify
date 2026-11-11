import { chromium } from "@playwright/test";
const root = new URL("../", import.meta.url).pathname;
for (const [name, command] of [
	["bun", ["bun", "tests/runtime-smoke.mjs"]],
	["node", ["node", "tests/runtime-smoke.mjs"]],
	[
		"deno",
		Bun.which("deno")
			? ["deno", "run", "tests/runtime-smoke.mjs"]
			: ["bun", "x", "deno", "run", "tests/runtime-smoke.mjs"],
	],
] as const) {
	if (!Bun.which(command[0]))
		throw new Error(`${name} is required for the runtime matrix`);
	const result = Bun.spawnSync([...command], { cwd: root });
	if (result.exitCode !== 0)
		throw new Error(`${name}: ${result.stderr.toString()}`);
	console.log(`${name}: ${result.stdout.toString().trim()}`);
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/")
			return new Response(
				// The bundle keeps codec external; a browser needs it mapped.
				'<script type="importmap">{"imports":{"@gin-quin/codec":"/node_modules/@gin-quin/codec/dist/index.js"}}</script>' +
					'<script type="module">import {smoke} from "/tests/runtime-smoke.mjs"; globalThis.result=smoke();</script>',
				{ headers: { "content-type": "text/html" } },
			);
		if (
			path !== "/tests/runtime-smoke.mjs" &&
			path !== "/tests/move-runtime-smoke.mjs" &&
			path !== "/node_modules/@gin-quin/codec/dist/index.js" &&
			!/^\/packages\/pulse\/dist\/[\w-]+\.js$/.test(path)
		)
			return new Response("Not found", { status: 404 });
		return new Response(Bun.file(`${root}${path}`), {
			headers: { "content-type": "text/javascript" },
		});
	},
});
let browser;
try {
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.waitForFunction(() => "result" in globalThis);
	console.log(
		`browser: ${JSON.stringify(await page.evaluate(() => (globalThis as any).result))}`,
	);
} finally {
	await browser?.close();
	server.stop(true);
}
