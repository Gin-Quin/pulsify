// Gives the example a Pulsify Cloud project: lets the public user edit the
// `example` root and writes the project URL and a token of that user for Vite.
//
//   bun run setup                 the local service (bun run dev:service), .env.development.local
//   PULSIFY_URL=… PULSIFY_API_KEY=… PULSIFY_TOKEN_SECRET=… bun run setup --production
//                                 a real project, .env.production.local
import { createCloudClient, signCloudToken } from "pulsify-cloud";
import { localCloudProject } from "../../scripts/local-cloud";

const production = process.argv.includes("--production");
let {
	PULSIFY_URL: url,
	PULSIFY_API_KEY: apiKey,
	PULSIFY_TOKEN_SECRET: tokenSecret,
} = process.env;

if (!production)
	({ url, apiKey, tokenSecret } = await localCloudProject(
		"example@pulsify.cloud",
	));
if (!url || !apiKey || !tokenSecret)
	throw new Error("Set PULSIFY_URL, PULSIFY_API_KEY and PULSIFY_TOKEN_SECRET");

await createCloudClient({ url, credential: apiKey }).grant({
	subject: "public",
	prefix: "example",
	role: "editor",
});
// ponytail: one long-lived token baked into a public app, as public as the app itself; serve short ones from a backend once users sign in.
const token = await signCloudToken({ subject: "public" }, tokenSecret, {
	expiresIn: "10y",
});
const file = production ? ".env.production.local" : ".env.development.local";
await Bun.write(
	new URL(file, import.meta.url),
	`VITE_PULSIFY_URL=${url}\nVITE_PULSIFY_TOKEN=${token}\n`,
);
console.log(`${url}: "public" edits the root "example". Wrote ${file}.`);
