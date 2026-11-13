/**
 * Publish every public package to JSR under the @pulsify scope.
 *
 *   bun scripts/publish-jsr.ts --dry-run
 *   bun scripts/publish-jsr.ts
 *
 * The JSR configuration is derived from each package.json (name, version,
 * exports, license, dependencies), written as a temporary Deno workspace and
 * removed afterwards: package.json stays the single source of truth.
 */
import { rm } from "node:fs/promises";

const root = new URL("../", import.meta.url).pathname;
const directories = [
	"packages/pulse",
	"packages/cloud",
	"packages/cloud-server",
	"packages/pulsify-react",
	"packages/pulsify-svelte",
	"packages/pulsify-vue",
	"packages/pulsify-solid",
	"packages/pulsify-prosemirror",
	"packages/pulsify-lexical",
	"packages/pulsify-codemirror",
	"packages/connectors/IndexedDB",
	"packages/connectors/Electron",
	"packages/connectors/Tauri",
];

type Manifest = {
	name: string;
	version: string;
	license: string;
	exports?: Record<string, unknown>;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};
/** Every JSR package needs a scope: `pulsify-lexical` becomes `@pulsify/lexical`. */
const jsrName = (name: string) => `@pulsify/${name.replace(/^pulsify-/, "")}`;

/** The TypeScript source of an export: the cloud server keeps one folder per entry. */
function sourceOf(directory: string, key: string): string {
	const entry = key === "." ? "index" : key.slice(2);
	if (directory === "packages/cloud-server")
		return `./${key === "." ? "core" : entry}/source/index.ts`;
	return `./source/${entry}.ts`;
}

/** Sibling packages map to their JSR names; everything else comes from npm. */
function specifier(name: string, range: string): string | undefined {
	if (name.startsWith("pulsify-")) return `jsr:${jsrName(name)}@${range}`;
	if (name === "@gin-quin/codec") return `jsr:${name}@${range}`;
	// Specifiers take one simple range: `^18.0.0 || ^19.0.0` keeps the newest.
	return `npm:${name}@${range.split("||").at(-1)!.trim()}`;
}

// Deno rewrites `import type … from "pulsify-…"` to a path outside the
// package instead of a jsr: specifier; `import { type … }` is rewritten right.
for (const directory of directories)
	for await (const file of new Bun.Glob("**/source/**/*.ts").scan(
		`${root}${directory}`,
	)) {
		const text = await Bun.file(`${root}${directory}/${file}`).text();
		if (/^import type [^;]* from "pulsify-/m.test(text))
			throw new Error(
				`${directory}/${file}: use \`import { type … }\` for pulsify packages`,
			);
	}

const generated: string[] = [];
try {
	for (const directory of directories) {
		const manifest: Manifest = await Bun.file(
			`${root}${directory}/package.json`,
		).json();
		const exports = Object.fromEntries(
			Object.keys(manifest.exports ?? { ".": null }).map((key) => [
				key,
				sourceOf(directory, key),
			]),
		);
		const imports = Object.fromEntries([
			...Object.entries({
				...manifest.peerDependencies,
				...manifest.dependencies,
			}).flatMap(([name, range]) => {
				const target = specifier(name, range);
				return target ? [[name, target]] : [];
			}),
			// The cloud server's parts import its core by package name.
			[manifest.name, exports["."]],
		]);
		const sources = [...new Set(Object.values(exports))].map((path) =>
			path.replace(/[^/]+$/, "**/*.ts"),
		);
		const config = {
			name: jsrName(manifest.name),
			version: manifest.version,
			license: manifest.license,
			exports,
			imports,
			publish: {
				include: [
					...sources,
					"README.md",
					"*/README.md",
					"LICENSE",
					"LICENSE.md",
					"package.json",
				],
				exclude: ["**/tests/**", "**/*.test.ts"],
			},
		};
		const path = `${root}${directory}/deno.json`;
		await Bun.write(path, `${JSON.stringify(config, null, "\t")}\n`);
		generated.push(path);
	}
	const workspace = `${root}deno.json`;
	await Bun.write(
		workspace,
		`${JSON.stringify({ workspace: directories.map((d) => `./${d}`) }, null, "\t")}\n`,
	);
	generated.push(workspace);

	const publish = Bun.spawn(
		["bun", "x", "jsr", "publish", ...process.argv.slice(2)],
		{ cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
	);
	process.exitCode = await publish.exited;
} finally {
	for (const path of generated) await rm(path, { force: true });
}
