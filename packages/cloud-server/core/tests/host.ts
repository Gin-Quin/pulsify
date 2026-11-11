import { Database } from "bun:sqlite";
import {
	CLOUD_PING,
	CLOUD_SUBPROTOCOLS,
	type CloudEnvelope,
	welcomeMessage,
} from "pulsify-cloud";
import {
	CloudRoot,
	routeCloudRequest,
	SqliteCloudStorage,
	type CloudPeer,
	type CloudSecrets,
} from "../source/index.js";

type SocketData = {
	id: string;
	root: string;
	subject: string;
	envelope: CloudEnvelope;
};

/**
 * An in-process backend built from the same primitives as the Durable Object:
 * the gateway routes and authenticates, one CloudRoot per root owns its
 * SQLite database. Used to run the backend conformance suite under Bun.
 */
export function startCloudHost(secrets: CloudSecrets) {
	const roots = new Map<
		string,
		{ engine: CloudRoot; peers: Map<string, CloudPeer> }
	>();
	const instance = `test-${crypto.randomUUID().slice(0, 8)}`;
	let frozen = false;
	let pings = 0;
	const rootFor = (name: string) => {
		let entry = roots.get(name);
		if (!entry) {
			const peers = new Map<string, CloudPeer>();
			entry = {
				peers,
				engine: new CloudRoot(
					name,
					new SqliteCloudStorage(new Database(":memory:")),
					{ get: (id) => peers.get(id), all: () => peers.values() },
				),
			};
			roots.set(name, entry);
		}
		return entry;
	};
	const serve = (port: number) =>
		Bun.serve<SocketData>({
			port,
			async fetch(request, server) {
				const route = await routeCloudRequest(request, secrets);
				if (route.type === "response") return route.response;
				const { engine } = rootFor(route.root);
				if (route.type === "request")
					return engine.handleRequest(route.action, request, route.caller);
				const data: SocketData = {
					id: crypto.randomUUID(),
					root: route.root,
					subject: route.subject,
					envelope: route.envelope,
				};
				return server.upgrade(request, {
					data,
					headers: {
						"Sec-WebSocket-Protocol": CLOUD_SUBPROTOCOLS[route.envelope],
					},
				})
					? undefined
					: new Response(null, { status: 400 });
			},
			websocket: {
				open(socket) {
					const { id, root, subject, envelope } = socket.data;
					socket.send(
						welcomeMessage({
							backend: "test",
							id: instance,
							location: "local",
						}),
					);
					rootFor(root).peers.set(id, {
						id,
						subject,
						envelope,
						send: (data) => socket.send(data),
						close: (code, reason) => socket.close(code, reason),
					});
				},
				message(socket, message) {
					if (frozen) return;
					if (message === CLOUD_PING) pings++;
					const { id, root } = socket.data;
					const entry = rootFor(root);
					const peer = entry.peers.get(id);
					if (peer)
						void entry.engine.receive(
							peer,
							typeof message === "string" ? message : new Uint8Array(message),
						);
				},
				close(socket) {
					const { id, root } = socket.data;
					const entry = rootFor(root);
					entry.peers.delete(id);
					void entry.engine.disconnect(id);
				},
			},
		});
	let server: ReturnType<typeof serve> | undefined = serve(0);
	const port = server.port!;
	return {
		url: `http://127.0.0.1:${port}`,
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
		instance,
		stop: () => server?.stop(true),
	};
}
