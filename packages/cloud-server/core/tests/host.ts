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
 * What Bun's `ServerWebSocket.send` answers for a frame the server sends: 0
 * drops it, -1 sends it but reports backpressure (queued), `undefined` sends
 * it as usual.
 */
export type Pressure = (
	socket: LocalCloudSocket,
	data: string | Uint8Array,
) => 0 | -1 | undefined;

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
	let pressure: Pressure | undefined;
	const serve = (port: number) =>
		Bun.serve<LocalCloudSocket>({
			port,
			fetch: cloud.fetch,
			websocket: {
				...cloud.websocket,
				open(socket) {
					const send = (data: string | Uint8Array<ArrayBuffer>) => {
						const answer = pressure?.(socket.data, data);
						if (answer === 0) return 0;
						const sent = socket.send(data);
						return answer ?? sent;
					};
					return cloud.websocket.open!(
						new Proxy(socket, {
							get(target, key) {
								if (key === "send") return send;
								const value = Reflect.get(target, key, target);
								return typeof value === "function" ? value.bind(target) : value;
							},
						}),
					);
				},
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
		/** Answer for Bun's `send` from now on: see `Pressure`. */
		pressure(next: Pressure | undefined) {
			pressure = next;
		},
		stop() {
			cloud.close();
			server?.stop(true);
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
