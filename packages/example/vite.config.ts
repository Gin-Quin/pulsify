import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The Pulsify packages of this repository, from their sources: the example
// always runs the code next to it, without a build.
const source = (path: string) =>
	new URL(`../${path}`, import.meta.url).pathname;
const packages: Record<string, string> = {
	"pulsify-core": "pulse/source/index.ts",
	"pulsify-core/bindings": "pulse/source/bindings.ts",
	"pulsify-cloud": "cloud/source/index.ts",
	"pulsify-svelte": "pulsify-svelte/source/index.ts",
	"pulsify-prosemirror": "pulsify-prosemirror/source/index.ts",
	"pulsify-codemirror": "pulsify-codemirror/source/index.ts",
};

export default defineConfig({
	plugins: [svelte()],
	resolve: {
		alias: Object.entries(packages).map(([name, path]) => ({
			find: new RegExp(`^${name}$`),
			replacement: source(path),
		})),
		dedupe: [
			"svelte",
			"prosemirror-model",
			"prosemirror-state",
			"prosemirror-view",
			"prosemirror-transform",
			"@codemirror/state",
			"@codemirror/view",
		],
	},
	build: { target: "es2022" },
});
