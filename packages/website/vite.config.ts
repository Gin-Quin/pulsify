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
				routes: ["/", "/docs", "/cloud", "/benchmarks"],
				crawlLinks: true,
			},
		}),
	],
});
