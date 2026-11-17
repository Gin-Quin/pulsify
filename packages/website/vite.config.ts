import { solidStart } from "@solidjs/start/config";
import { nitro } from "nitro/vite";
import { defineConfig, runnerImport, type Plugin } from "vite";
import { localCloudProject } from "../../scripts/local-cloud";
import type { handleDemoRequest } from "./worker";

// The Pulsify packages of this repository, from their sources: the demos
// always run the code next to them, without a build.
const source = (path: string) =>
	new URL(`../${path}`, import.meta.url).pathname;
const packages: Record<string, string> = {
	"pulsify-core": "pulse/source/index.ts",
	"pulsify-core/bindings": "pulse/source/bindings.ts",
	"pulsify-core/protocol": "pulse/source/protocol.ts",
	"pulsify-cloud": "cloud/source/index.ts",
	"pulsify-solid": "pulsify-solid/source/index.ts",
	"pulsify-prosemirror": "pulsify-prosemirror/source/index.ts",
};

const alias = Object.entries(packages).map(([name, path]) => ({
	find: new RegExp(`^${name}$`),
	replacement: source(path),
}));

/**
 * `vite dev` serves /api/demo as worker.ts does in production, with a
 * project of the local Pulsify Cloud (`bun run dev:service`).
 */
function demoApi(): Plugin {
	let project: ReturnType<typeof localCloudProject> | undefined;
	// Through Vite with the aliases below, so that it runs the Pulsify sources.
	let worker:
		| Promise<{ module: { handleDemoRequest: typeof handleDemoRequest } }>
		| undefined;
	return {
		name: "pulsify-demo-api",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use("/api/demo", async (request, response) => {
				const send = (status: number, body: string) => {
					response.statusCode = status;
					response.setHeader("Content-Type", "application/json");
					response.end(body);
				};
				try {
					project ??= localCloudProject("demo@pulsify.cloud");
					const { url, apiKey, tokenSecret } = await project;
					worker ??= runnerImport(source("website/worker.ts"), {
						configFile: false,
						resolve: { alias },
					});
					const { handleDemoRequest } = (await worker).module;
					let body = "";
					for await (const chunk of request) body += chunk;
					const origin = `http://${request.headers.host}`;
					const answer = await handleDemoRequest(
						new Request(`${origin}/api/demo`, {
							method: request.method,
							headers: { Origin: request.headers.origin ?? "" },
							...(request.method === "POST" && { body }),
						}),
						{
							DEMO_PULSIFY_URL: url,
							DEMO_PULSIFY_API_KEY: apiKey,
							DEMO_PULSIFY_TOKEN_SECRET: tokenSecret,
							DEMO_ORIGIN: origin,
						},
					);
					send(answer.status, await answer.text());
				} catch (error) {
					project = worker = undefined;
					send(502, JSON.stringify({ error: (error as Error).message }));
				}
			});
		},
	};
}

// Fully static: every route is prerendered to .output/public. worker.ts
// serves them, and /api/demo.
export default defineConfig({
	plugins: [
		demoApi(),
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
					"/demos",
					"/dashboard",
					"/404.html",
				],
				crawlLinks: true,
			},
		}),
	],
	resolve: {
		alias,
		dedupe: [
			"solid-js",
			"prosemirror-model",
			"prosemirror-state",
			"prosemirror-view",
			"prosemirror-transform",
		],
	},
});
