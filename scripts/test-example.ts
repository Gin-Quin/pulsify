import { chromium, expect } from "@playwright/test";
const server = Bun.spawn(["bun", "examples/server.ts"], {
	env: { ...process.env, PORT: "0" },
	stdout: "pipe",
	stderr: "pipe",
});
const reader = server.stdout.getReader();
let browser;
try {
	let text = "";
	while (!text.includes("(open two tabs)")) {
		const { value, done } = await reader.read();
		if (done)
			throw new Error(
				`Example server exited: ${await new Response(server.stderr).text()}`,
			);
		text += new TextDecoder().decode(value);
	}
	const url = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
	if (!url) throw new Error("Example URL missing");
	browser = await chromium.launch({ headless: true });
	const errors: string[] = [];
	const first = await browser.newPage();
	first.on("pageerror", (error) => errors.push(error.message));
	await first.goto(url);
	await expect(first.locator("#status")).toHaveText("Connected");
	const second = await browser.newPage();
	second.on("pageerror", (error) => errors.push(error.message));
	await second.goto(url);
	await expect(second.locator("#status")).toHaveText("Connected");
	await first.locator("#title").fill("Two tabs synchronized");
	await expect(second.locator("#title")).toHaveValue("Two tabs synchronized");
	await second.locator("#disconnect").click();
	await second.locator("#body").fill("Edited offline");
	await first.locator("#title").fill("Edited online");
	await second.locator("#connect").click();
	await expect(second.locator("#status")).toHaveText("Connected");
	await expect(second.locator("#title")).toHaveValue("Edited online");
	await expect(first.locator("#body")).toHaveValue("Edited offline");
	if (errors.length) throw new Error(errors.join("\n"));
	console.log(
		JSON.stringify({
			example: "two-tab WebSocket demo",
			initialSync: "passed",
			offlineReconnect: "passed",
			pageErrors: errors.length,
		}),
	);
} finally {
	await browser?.close();
	server.kill();
	reader.releaseLock();
	await server.exited;
}
