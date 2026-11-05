import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), "pulsify-consumer-"));
const archive = join(directory, "pulsify-core.tgz");
async function run(command: string[], cwd: string): Promise<string> {
	const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code !== 0) throw new Error(`${command.join(" ")}\n${stdout}\n${stderr}`);
	return stdout;
}
try {
	await run(
		["bun", "pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet"],
		`${root}packages/pulse`,
	);
	for (const name of ["pulsify-prosemirror", "pulsify-lexical"])
		await run(
			[
				"bun",
				"pm",
				"pack",
				"--filename",
				join(directory, `${name}.tgz`),
				"--ignore-scripts",
				"--quiet",
			],
			`${root}packages/${name}`,
		);
	const coreOnly = join(directory, "core-only");
	await Bun.write(
		join(coreOnly, "package.json"),
		JSON.stringify({
			private: true,
			type: "module",
			dependencies: { "@pulsify/core": `file:${archive}` },
		}),
	);
	await Bun.write(join(coreOnly, ".npmrc"), Bun.file(`${root}.npmrc`));
	await run(["bun", "install", "--ignore-scripts"], coreOnly);
	await run(
		[
			"node",
			"--input-type=module",
			"-e",
			'import {richText} from "@pulsify/core"; if (typeof richText !== "function") throw new Error("Core import failed"); for (const name of ["lexical", "prosemirror-model", "react"]) { let found = false; try { import.meta.resolve(name); found = true; } catch {} if (found) throw new Error(`Core installed editor dependency ${name}`); }',
		],
		coreOnly,
	);
	await Bun.write(
		join(directory, "package.json"),
		JSON.stringify({
			name: "pulsify-consumer",
			private: true,
			type: "module",
			dependencies: {
				"@pulsify/core": `file:${archive}`,
				"@gin-quin/codec": "npm:@jsr/gin-quin__codec@2.1.0",
				"pulsify-prosemirror": `file:${join(directory, "pulsify-prosemirror.tgz")}`,
				"pulsify-lexical": `file:${join(directory, "pulsify-lexical.tgz")}`,
				lexical: "^0.53.0",
				"prosemirror-model": "^1.25.12",
				"prosemirror-state": "^1.4.4",
				"prosemirror-transform": "^1.12.5",
				"prosemirror-view": "^1.42.9",
			},
		}),
	);
	await Bun.write(join(directory, ".npmrc"), Bun.file(`${root}.npmrc`));
	await run(["bun", "install", "--ignore-scripts"], directory);
	await Bun.write(
		join(directory, "consumer.mts"),
		Bun.file(`${root}fixtures/consumer.mts`),
	);
	await Bun.write(
		join(directory, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				skipLibCheck: false,
				module: "NodeNext",
				moduleResolution: "NodeNext",
				target: "ES2023",
				lib: ["ESNext", "DOM"],
				types: [],
			},
			files: ["consumer.mts"],
		}),
	);
	await run([`${root}node_modules/.bin/tsc`, "-p", "tsconfig.json"], directory);
	const smoke = (await Bun.file(`${root}tests/runtime-smoke.mjs`).text())
		.replaceAll("../packages/pulse/dist/index.js", "@pulsify/core")
		.replaceAll("../packages/pulse/dist/protocol.js", "@pulsify/core/protocol");
	await Bun.write(join(directory, "runtime.mjs"), smoke);
	await run(["node", "runtime.mjs"], directory);
	await Bun.write(
		join(directory, "editor.mjs"),
		`
import assert from "node:assert/strict";
import { object } from "@gin-quin/codec";
import { createPulse, definePulse, richText } from "@pulsify/core";
import { proseMirrorDocument } from "pulsify-prosemirror";
import { bindLexical, lexicalDocument } from "pulsify-lexical";
import { createEditor, $getRoot, $isTextNode } from "lexical";
import { Schema } from "prosemirror-model";
const schema = new Schema({nodes: {doc: {content: "paragraph+"}, paragraph: {content: "text*"}, text: {}}});
const Note = definePulse("PackedEditor", object({body: richText()})).materialize();
const note = createPulse(Note, {body: "Packed ProseMirror"});
assert.equal(proseMirrorDocument(note.body, schema).textContent, "Packed ProseMirror");
const other = createPulse(Note, {body: "Packed Lexical"});
const editor = createEditor({onError(error) {throw error;}});
const binding = bindLexical(editor, other.body);
editor.update(() => {const node = $getRoot().getFirstDescendant(); if ($isTextNode(node)) node.spliceText(14, 0, "!");}, {discrete: true});
assert.equal(other.body.text, "Packed Lexical!");
assert.deepEqual(lexicalDocument(other.body), editor.getEditorState().toJSON());
binding.undo(); assert.equal(other.body.text, "Packed Lexical"); binding.destroy();
`,
	);
	await run(["node", "editor.mjs"], directory);
	console.log(
		JSON.stringify({
			package: "three packed tarballs",
			coreIsolation: "no editor or React dependencies",
			declarations: "NodeNext strict passed",
			runtime: "Node passed",
			sharedClasses: "passed",
		}),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
