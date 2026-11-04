import { PulseRelay } from "../packages/pulse/source/protocol/PulseRelay";
import type { RelayPeer } from "../packages/pulse/source/protocol/PulseRelay";
import { validateCoreRow } from "../packages/pulse/source/core/operations";
const relay = new PulseRelay(validateCoreRow);
const client = await Bun.build({
	entrypoints: [new URL("./client.ts", import.meta.url).pathname],
	target: "browser",
	minify: true,
});
if (!client.success)
	throw new AggregateError(client.logs, "Cannot build example");
const server = Bun.serve<{ peer?: RelayPeer; protocolVersion?: 1 | 2 }>({
	hostname: "127.0.0.1",
	port: Number(process.env["PORT"] ?? 3000),
	fetch(request, server) {
		const path = new URL(request.url).pathname;
		if (path === "/sync") {
			const grouped = request.headers
				.get("sec-websocket-protocol")
				?.split(",")
				.some((p) => p.trim() === "pulsify-v2");
			if (
				server.upgrade(request, {
					data: { protocolVersion: grouped ? 2 : 1 },
					...(grouped
						? { headers: { "Sec-WebSocket-Protocol": "pulsify-v2" } }
						: {}),
				})
			)
				return;
		}
		if (path === "/client.js")
			return new Response(client.outputs[0], {
				headers: { "content-type": "text/javascript" },
			});
		if (path === "/")
			return new Response(Bun.file(new URL("./index.html", import.meta.url)), {
				headers: { "content-type": "text/html" },
			});
		return new Response("Not found", { status: 404 });
	},
	websocket: {
		maxPayloadLength: 8 * 1024 * 1024,
		open(socket) {
			socket.data.peer = relay.open(
				(bytes) => {
					socket.sendBinary(bytes);
				},
				{ protocolVersion: socket.data.protocolVersion ?? 1 },
			);
		},
		message(socket, message) {
			try {
				if (typeof message === "string") {
					socket.close(1003);
					return;
				}
				socket.data.peer!.receive(new Uint8Array(message));
			} catch {
				socket.close(1002);
			}
		},
		close(socket) {
			socket.data.peer?.close();
		},
	},
});
console.log(`Pulsify demo: http://127.0.0.1:${server.port} (open two tabs)`);
