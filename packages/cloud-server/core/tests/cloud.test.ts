import { afterAll, beforeAll } from "bun:test";
import { describeCloudBackend, type CloudBackend } from "./conformance.js";
import { startCloudHost } from "./host.js";

const secrets = {
	tokenSecret: "a test token secret of at least 32 characters",
	apiKey: "a test api key of at least thirty-two characters",
};
let host: ReturnType<typeof startCloudHost>;
beforeAll(() => {
	host = startCloudHost(secrets);
});
afterAll(() => host.stop());

describeCloudBackend("In-process", (): CloudBackend => ({
	url: host.url,
	...secrets,
}));
