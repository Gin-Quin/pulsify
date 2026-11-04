import { PulseRelay } from "../packages/pulse/source/protocol/PulseRelay";
import type { RelayPeer } from "../packages/pulse/source/protocol/PulseRelay";
import { rowToPatch } from "../packages/pulse/source/connection/PulsePatch";
const relay = new PulseRelay(rowToPatch);
const client = await Bun.build({
	entrypoints: [new URL("./client.ts", import.meta.url).pathname],
	target: "browser",
	minify: true,
});
if (!client.success)
	throw new AggregateError(client.logs, "Cannot build example");
const server = Bun.serve<{ peer?: RelayPeer }>({
	hostname: "127.0.0.1",
	port: Number(process.env["PORT"] ?? 3000),
	fetch(request, server) {
		const path = new URL(request.url).pathname;
		if (path === "/sync" && server.upgrade(request, { data: {} })) return;
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
			socket.data.peer = relay.open((bytes) => {
				socket.sendBinary(bytes);
			});
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
