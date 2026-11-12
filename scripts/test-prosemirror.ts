import { chromium, expect } from "@playwright/test";
const lexical = process.env["EDITOR_DEMO"] === "lexical";
const route = lexical ? "lexical" : "prosemirror";

const server = Bun.spawn(["bun", "examples/server.ts"], {
	env: { ...process.env, PORT: "0" },
	stdout: "pipe",
	stderr: "pipe",
});
const reader = server.stdout.getReader();
let browser;
try {
	let output = "";
	while (!output.includes("(open two tabs)")) {
		const { value, done } = await reader.read();
		if (done)
			throw new Error(
				`Example server exited: ${await new Response(server.stderr).text()}`,
			);
		output += new TextDecoder().decode(value);
	}
	const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
	if (!url) throw new Error("Example URL missing");
	browser = await chromium.launch({ headless: true });
	const first = await browser.newPage(),
		second = await browser.newPage();
	const errors: string[] = [];
	for (const page of [first, second]) {
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(`${url}/${route}`);
		await expect(page.locator("#status")).toHaveText("Connected");
	}
	const left = first.locator(lexical ? "#editor" : ".ProseMirror"),
		right = second.locator(lexical ? "#editor" : ".ProseMirror");
	await expect(right).toHaveText("Edit this text in two tabs.");
	await left.click();
	await first.keyboard.press("ControlOrMeta+End");
	await first.keyboard.press("Enter");
	await first.locator("#bold").click();
	await first.keyboard.type("Formatted paragraph");
	await expect(right.locator("p")).toHaveCount(2);
	await expect(right.locator("strong")).toHaveText("Formatted paragraph");
	// The first tab's caret is drawn in the second one, at the end of its text.
	const caret = second.locator("[data-peer]");
	await expect(caret).toHaveCount(1);
	const strong = (await right.locator("strong").boundingBox())!;
	await expect
		.poll(async () => {
			const box = await caret.boundingBox();
			return (
				!!box &&
				box.height > 0 &&
				Math.abs(box.x - (strong.x + strong.width)) < 4 &&
				box.y + box.height > strong.y &&
				box.y < strong.y + strong.height
			);
		})
		.toBe(true);
	// Remote cursors are not part of the document, nor of its history.
	await expect(first.locator("[data-peer]")).toHaveCount(0);
	await second.locator("#disconnect").click();
	await right.click();
	await second.keyboard.press("ControlOrMeta+End");
	await second.keyboard.type(" offline");
	await left
		.locator("p")
		.first()
		.click({ position: { x: 1, y: 5 } });
	await first.keyboard.type("Online ");
	await expect(left.locator("p").first()).toHaveText(
		"Online Edit this text in two tabs.",
	);
	await second.locator("#connect").click();
	await expect(second.locator("#status")).toHaveText("Connected");
	await expect(left).toContainText("offline");
	await expect(right).toContainText("Online");
	// The same document in both tabs, once the cursors drawn in it are set aside.
	const content = (editor: typeof left) =>
		editor.evaluate((element) => {
			const copy = element.cloneNode(true) as HTMLElement;
			for (const drawn of copy.querySelectorAll("[data-peer]")) drawn.remove();
			for (const range of copy.querySelectorAll("[data-peer-selection]"))
				range.replaceWith(...range.childNodes);
			copy.normalize();
			return copy.innerHTML;
		});
	await expect.poll(() => content(left)).toBe(await content(right));
	// A tab that loses focus takes its cursor away from the others.
	await right.click();
	await expect(first.locator("[data-peer]")).toHaveCount(1);
	await second.evaluate(() => (document.activeElement as HTMLElement)?.blur());
	await expect(first.locator("[data-peer]")).toHaveCount(0);
	// Undo only this client's typing, keeping the remote addition.
	await first.locator("#undo").click();
	await expect(left).not.toContainText("Online");
	await expect(right).not.toContainText("Online");
	await expect(left).toContainText("offline");
	if (errors.length) throw new Error(errors.join("\n"));
	console.log(
		JSON.stringify({
			example: lexical ? "Lexical editor" : "ProseMirror editor",
			twoTabs: "passed",
			nodesAndMarks: "passed",
			offlineMerge: "passed",
			localUndo: "passed",
			remoteCursors: "passed",
			pageErrors: errors.length,
		}),
	);
} finally {
	await browser?.close();
	server.kill();
	reader.releaseLock();
	await server.exited;
}
