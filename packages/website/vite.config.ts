import { solidStart } from "@solidjs/start/config";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// Fully static: every route is prerendered to .output/public.
export default defineConfig({
	plugins: [
		solidStart(),
		nitro({
			preset: "static",
			prerender: {
				// 404.html is the page Workers assets serve for unknown URLs.
				routes: [
					"/",
					"/docs",
					"/cloud",
					"/benchmarks",
					"/dashboard",
					"/404.html",
				],
				crawlLinks: true,
			},
		}),
	],
});
