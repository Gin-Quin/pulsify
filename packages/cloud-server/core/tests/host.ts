import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_PING } from "pulsify-cloud";
import {
	createLocalCloud,
	type LocalCloudOptions,
	type LocalCloudSocket,
} from "../../local/source/index.js";
import type { CloudSecrets } from "../source/index.js";

/**
 * The local server (`pulsify-cloud-server/local`) in a temporary directory,
 * with what tests need on top: outages, a transport that died silently and a
 * count of the heartbeats. Used to run the backend conformance suite under Bun.
 */
export function startCloudHost(
	secrets: CloudSecrets,
	options: Partial<LocalCloudOptions> = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "pulsify-host-"));
	const cloud = createLocalCloud({ directory, secrets, ...options });
	let frozen = false;
	let pings = 0;
	const serve = (port: number) =>
		Bun.serve<LocalCloudSocket>({
			port,
			fetch: cloud.fetch,
			websocket: {
				...cloud.websocket,
				message(socket, message) {
					if (frozen) return;
					if (message === CLOUD_PING) pings++;
					return cloud.websocket.message(socket, message);
				},
			},
		});
	let server: ReturnType<typeof serve> | undefined = serve(0);
	const port = server.port!;
	return {
		/** The URL of one project. */
		url: `http://127.0.0.1:${port}/test`,
		directory,
		/** Close every socket and refuse connections, keeping all data: an outage. */
		suspend() {
			server?.stop(true);
			server = undefined;
		},
		resume() {
			server ??= serve(port);
		},
		/** Keep sockets open but answer nothing: a transport that died silently. */
		freeze() {
			frozen = true;
		},
		thaw() {
			frozen = false;
		},
		get pings() {
			return pings;
		},
		stop() {
			cloud.close();
			server?.stop(true);
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
