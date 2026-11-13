// Runs the cloud conformance suite against a deployed or locally started
// backend. Use `bun run test:cloud --backend cloudflare`.
import { describeCloudBackend } from "../packages/cloud-server/core/tests/conformance.js";

const url = process.env["PULSIFY_CLOUD_URL"];
const tokenSecret = process.env["PULSIFY_TOKEN_SECRET"];
const apiKey = process.env["PULSIFY_API_KEY"];
if (!url || !tokenSecret || !apiKey)
	throw new Error(
		"Set PULSIFY_CLOUD_URL, PULSIFY_TOKEN_SECRET and PULSIFY_API_KEY",
	);

describeCloudBackend(process.env["PULSIFY_CLOUD_BACKEND"] ?? "Remote", () => ({
	url,
	tokenSecret,
	apiKey,
	hibernatesAfterMs: Number(process.env["PULSIFY_CLOUD_HIBERNATES_MS"] ?? 0),
}));
