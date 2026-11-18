#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { startLocalCloud } from "./index.js";

const USAGE = `Usage: pulsify dev [--port 3345] [--host 127.0.0.1] [--dir .pulsify]

Serves Pulsify Cloud on this machine, with one SQLite file per root.
PULSIFY_TOKEN_SECRET and PULSIFY_API_KEY replace the development secrets.`;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		port: { type: "string", default: "3345" },
		host: { type: "string", default: "127.0.0.1" },
		dir: { type: "string", default: ".pulsify" },
		help: { type: "boolean", short: "h", default: false },
	},
});
const port = Number(values.port);
if (
	values.help ||
	positionals.join(" ") !== "dev" ||
	!Number.isInteger(port) ||
	port < 0 ||
	port > 65535
) {
	console.log(USAGE);
	process.exit(values.help ? 0 : 1);
}

// Known to everyone: good for a server that only this machine reaches.
const secrets = {
	tokenSecret:
		process.env["PULSIFY_TOKEN_SECRET"] ||
		"pulsify-dev-token-secret-not-for-production",
	apiKey:
		process.env["PULSIFY_API_KEY"] ||
		"pk_pulsify-dev-api-key-not-for-production",
};
const server = startLocalCloud({
	directory: values.dir,
	port,
	hostname: values.host,
	secrets,
});
console.log(`Pulsify Cloud runs on this machine. Each root is one SQLite file in ${values.dir}/dev.

PULSIFY_URL=${server.url}/dev
PULSIFY_TOKEN_SECRET=${secrets.tokenSecret}
PULSIFY_API_KEY=${secrets.apiKey}
`);
// Closing the databases leaves one file per root.
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		server.stop();
		process.exit(0);
	});
