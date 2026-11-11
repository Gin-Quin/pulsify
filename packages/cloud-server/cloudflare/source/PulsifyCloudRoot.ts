import {
	CLOUD_PING,
	CLOUD_PONG,
	CLOUD_SUBPROTOCOLS,
	CloudError,
	welcomeMessage,
	type CloudEnvelope,
} from "@pulsify/cloud";
import {
	callerFromHeaders,
	CloudRoot,
	errorResponse,
	SqliteCloudStorage,
	type CloudPeer,
} from "@pulsify/cloud-server";
import { durableSqlite, type DurableObjectStorageLike } from "./sqlite.js";

export type DurableObjectStateLike = {
	id?: { toString(): string };
	storage: DurableObjectStorageLike;
	acceptWebSocket(socket: WebSocket, tags?: string[]): void;
	getWebSockets(tag?: string): WebSocket[];
	setWebSocketAutoResponse?(pair: unknown): void;
};
type HibernatableSocket = WebSocket & {
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
};
type Attachment = {
	id: string;
	root: string;
	subject: string;
	envelope: CloudEnvelope;
};
declare const WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };
declare const WebSocketRequestResponsePair:
	(new (request: string, response: string) => unknown) | undefined;

/** Headers set by the Worker after authentication; clients never reach the object directly. */
export const ROOT_HEADERS = {
	root: "x-pulsify-root",
	action: "x-pulsify-action",
	envelope: "x-pulsify-envelope",
	location: "x-pulsify-location",
} as const;

/**
 * One Durable Object per root. Its SQLite database holds the root's documents,
 * its grant table and the subscriptions of its hibernating WebSockets.
 */
export class PulsifyCloudRoot {
	private engine: CloudRoot | undefined;
	constructor(
		private readonly state: DurableObjectStateLike,
		_env?: unknown,
	) {
		// Heartbeats are answered by the runtime: a hibernated root stays asleep.
		if (typeof WebSocketRequestResponsePair === "function")
			state.setWebSocketAutoResponse?.(
				new WebSocketRequestResponsePair(CLOUD_PING, CLOUD_PONG),
			);
	}

	async fetch(request: Request): Promise<Response> {
		try {
			const root = decodeURIComponent(
				request.headers.get(ROOT_HEADERS.root) ?? "",
			);
			const caller = callerFromHeaders(request.headers);
			if (!root || !caller)
				throw new CloudError("BAD_REQUEST", "Missing gateway headers");
			const engine = this.root(root);
			const action = request.headers.get(ROOT_HEADERS.action);
			if (action === "grants" || action === "usage")
				return await engine.handleRequest(action, request, caller);
			if (action !== "connect" || caller.kind !== "user")
				throw new CloudError("BAD_REQUEST", "Unknown action");
			// Rights are checked per document, so the client gets FORBIDDEN
			// rather than a failed upgrade whose status browsers hide.
			const envelope: CloudEnvelope =
				request.headers.get(ROOT_HEADERS.envelope) === "2" ? 2 : 1;
			const pair = new WebSocketPair();
			const server = pair[1] as HibernatableSocket;
			const attachment: Attachment = {
				id: crypto.randomUUID(),
				root,
				subject: caller.subject,
				envelope,
			};
			server.serializeAttachment(attachment);
			this.state.acceptWebSocket(server, [attachment.id]);
			const location = request.headers.get(ROOT_HEADERS.location);
			server.send(
				welcomeMessage({
					backend: "cloudflare",
					id: this.state.id?.toString() ?? root,
					...(location ? { location } : {}),
				}),
			);
			return new Response(null, {
				status: 101,
				headers: { "Sec-WebSocket-Protocol": CLOUD_SUBPROTOCOLS[envelope] },
				webSocket: pair[0],
			} as ResponseInit);
		} catch (error) {
			return errorResponse(error);
		}
	}

	async webSocketMessage(
		socket: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		const peer = this.peer(socket);
		await this.root(peer.root).receive(peer, message);
	}

	async webSocketClose(
		socket: WebSocket,
		code: number,
		reason: string,
	): Promise<void> {
		const peer = this.peer(socket);
		await this.root(peer.root).disconnect(peer.id);
		try {
			socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {
			// Already closed by the runtime.
		}
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		const peer = this.peer(socket);
		await this.root(peer.root).disconnect(peer.id);
	}

	/** The engine survives hibernation only in storage; rebuild it on wake. */
	private root(name: string): CloudRoot {
		this.engine ??= new CloudRoot(
			name,
			new SqliteCloudStorage(durableSqlite(this.state.storage)),
			{
				get: (id) => {
					const socket = this.state.getWebSockets(id)[0];
					return socket && this.peer(socket);
				},
				all: () =>
					this.state.getWebSockets().map((socket) => this.peer(socket)),
			},
		);
		if (this.engine.root !== name)
			throw new CloudError("BAD_REQUEST", "One Durable Object per root");
		return this.engine;
	}

	private peer(socket: WebSocket): CloudPeer & { root: string } {
		const attachment = (
			socket as HibernatableSocket
		).deserializeAttachment() as Attachment;
		return {
			...attachment,
			send: (data) => socket.send(data as string | Uint8Array<ArrayBuffer>),
			close: (code, reason) => socket.close(code, reason),
		};
	}
}
