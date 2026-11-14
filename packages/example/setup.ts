// Gives the example a Pulsify Cloud project: lets the public user edit the
// `example` root and writes the project URL and a token of that user for Vite.
//
//   bun run setup                 the local service (bun run dev:service), .env.development.local
//   PULSIFY_URL=… PULSIFY_API_KEY=… PULSIFY_TOKEN_SECRET=… bun run setup --production
//                                 a real project, .env.production.local
import { createCloudClient, signCloudToken } from "pulsify-cloud";

const production = process.argv.includes("--production");
let {
	PULSIFY_URL: url,
	PULSIFY_API_KEY: apiKey,
	PULSIFY_TOKEN_SECRET: tokenSecret,
} = process.env;

if (!production) {
	// The local service signs in any address that asked for a code with 444444.
	const service = "http://localhost:8787";
	const headers = {
		"Content-Type": "application/json",
		Origin: "http://localhost:3000",
	};
	const email = "example@pulsify.cloud";
	await fetch(`${service}/account/login`, {
		method: "POST",
		headers,
		body: JSON.stringify({ email }),
	}).catch(() => {
		throw new Error(
			`No local Pulsify Cloud at ${service}: bun run dev:service`,
		);
	});
	const signIn = await fetch(`${service}/account/code`, {
		method: "POST",
		headers,
		body: JSON.stringify({ email, code: "444444" }),
	});
	const cookie = signIn.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error(`Sign-in failed: ${await signIn.text()}`);
	({ url, apiKey, tokenSecret } = (await (
		await fetch(`${service}/account/`, { headers: { Cookie: cookie } })
	).json()) as Record<string, string>);
}
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
