import {
	CLOUD_PING,
	CLOUD_PONG,
	CLOUD_SUBPROTOCOLS,
	CloudError,
	welcomeMessage,
	type CloudEnvelope,
	type CloudRole,
} from "pulsify-cloud";
import {
	callerFromHeaders,
	CloudRoot,
	errorResponse,
	SqliteCloudStorage,
	type CloudPeer,
} from "pulsify-cloud-server";
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
	/** The client has sent a presence frame; kept here so it survives hibernation. */
	presence?: boolean;
	/**
	 * Document → role, kept here for the same reason and at no storage cost. An
	 * attachment holds 16,384 serialized bytes: the root stores what is over.
	 */
	subscriptions?: ReadonlyMap<string, CloudRole>;
	/** Closed because its root was deleted: its close event has nothing left to do. */
	erased?: true;
};
declare const WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };
declare const WebSocketRequestResponsePair:
	(new (request: string, response: string) => unknown) | undefined;

/** How long a root waits after its last socket closed before it compacts its history. */
export const COMPACT_AFTER_MS = 60_000;
/** The pause between two bounded compaction steps, which lets other events in. */
const COMPACT_STEP_MS = 10;
export type PulsifyCloudRootEnv = {
	/** Overrides `COMPACT_AFTER_MS`, in milliseconds. */
	PULSIFY_COMPACT_AFTER_MS?: string;
};

/** Headers set by the Worker after authentication; clients never reach the object directly. */
export const ROOT_HEADERS = {
	root: "x-pulsify-root",
	action: "x-pulsify-action",
	envelope: "x-pulsify-envelope",
	location: "x-pulsify-location",
} as const;

/**
 * One Durable Object per root. Its SQLite database holds the root's documents
 * and its grant table. Its hibernating WebSockets carry their subscriptions in
 * their attachment; SQLite only takes those that do not fit there. Once its
 * last socket has been closed for a while, an alarm compacts its history.
 */
export class PulsifyCloudRoot {
	private engine: CloudRoot | undefined;
	private storage: SqliteCloudStorage | undefined;
	private readonly compactAfterMs: number;
	/** Where the compaction in progress continues; restarts if the object is evicted. */
	private compaction: unknown;
	constructor(
		private readonly state: DurableObjectStateLike,
		env?: PulsifyCloudRootEnv,
	) {
		const compactAfterMs = Number(env?.PULSIFY_COMPACT_AFTER_MS);
		this.compactAfterMs =
			env?.PULSIFY_COMPACT_AFTER_MS && compactAfterMs >= 0
				? compactAfterMs
				: COMPACT_AFTER_MS;
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
			if (action === "documents") {
				// Deleting the root document deletes the object.
				const response = await engine.handleRequest(action, request, caller);
				if (
					response.ok &&
					new URL(request.url).searchParams.get("docId") === root
				)
					await this.erase();
				return response;
			}
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
				welcomeMessage(
					{
						backend: "cloudflare",
						id: this.state.id?.toString() ?? root,
						...(location ? { location } : {}),
					},
					{ presence: true },
				),
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
		if (peer.erased) return;
		await this.root(peer.root).receive(peer, message);
	}

	async webSocketClose(
		socket: WebSocket,
		code: number,
		reason: string,
	): Promise<void> {
		const peer = this.peer(socket);
		if (peer.erased) return;
		await this.root(peer.root).disconnect(peer);
		try {
			socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {
			// Already closed by the runtime.
		}
		await this.rest(peer.id);
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		const peer = this.peer(socket);
		if (peer.erased) return;
		await this.root(peer.root).disconnect(peer);
		await this.rest(peer.id);
	}

	/**
	 * The root's only alarm: compact while nobody is connected, a bounded step
	 * at a time. A root that got a socket back does nothing; the next time its
	 * last socket closes sets the alarm again.
	 */
	async alarm(): Promise<void> {
		if (this.state.getWebSockets().length) {
			this.compaction = undefined;
			return;
		}
		this.compaction = await this.rootStorage().compact(this.compaction);
		if (this.compaction !== undefined)
			await this.state.storage.setAlarm(Date.now() + COMPACT_STEP_MS);
	}

	/**
	 * The root document was deleted, so the root holds nothing: close its
	 * sockets and delete its storage and alarm, which deletes the object. A
	 * later request starts an empty root.
	 */
	protected async erase(): Promise<void> {
		this.engine = this.storage = this.compaction = undefined;
		for (const socket of this.state.getWebSockets()) {
			const hibernatable = socket as HibernatableSocket;
			const attachment = hibernatable.deserializeAttachment() as Attachment;
			hibernatable.serializeAttachment({ ...attachment, erased: true });
			try {
				socket.close(1000, "Root deleted");
			} catch {
				// Already closing.
			}
		}
		await this.state.storage.deleteAlarm();
		await this.state.storage.deleteAll();
	}

	/** After a socket closed: if it was the last, compact once the root stayed idle. */
	private async rest(closed: string): Promise<void> {
		// The runtime still lists the socket that is closing.
		for (const socket of this.state.getWebSockets())
			if (this.peer(socket).id !== closed) return;
		this.compaction = undefined;
		await this.state.storage.setAlarm(Date.now() + this.compactAfterMs);
	}

	private rootStorage(): SqliteCloudStorage {
		return (this.storage ??= new SqliteCloudStorage(
			durableSqlite(this.state.storage),
		));
	}

	/** The engine survives hibernation only in storage; rebuild it on wake. */
	private root(name: string): CloudRoot {
		this.engine ??= new CloudRoot(name, this.rootStorage(), {
			get: (id) => {
				const socket = this.state.getWebSockets(id)[0];
				return socket && this.peer(socket);
			},
			all: () => this.state.getWebSockets().map((socket) => this.peer(socket)),
		});
		if (this.engine.root !== name)
			throw new CloudError("BAD_REQUEST", "One Durable Object per root");
		return this.engine;
	}

	private peer(socket: WebSocket): CloudPeer & { root: string; erased?: true } {
		const hibernatable = socket as HibernatableSocket;
		const attachment = hibernatable.deserializeAttachment() as Attachment;
		const keep = (change: Partial<Attachment>) => {
			// Read again: the attachment may be newer than this peer.
			const current = hibernatable.deserializeAttachment() as Attachment;
			hibernatable.serializeAttachment({
				...current,
				// Always there, so that using presence never grows a full attachment.
				presence: current.presence === true,
				...change,
			});
		};
		return {
			...attachment,
			presence: attachment.presence === true,
			subscriptions: attachment.subscriptions ?? new Map(),
			usePresence: () => keep({ presence: true }),
			keepSubscriptions: (subscriptions) => {
				try {
					keep({ subscriptions });
					return true;
				} catch {
					// Over the size limit: the runtime keeps the previous attachment.
					return false;
				}
			},
			send: (data) => socket.send(data as string | Uint8Array<ArrayBuffer>),
			close: (code, reason) => socket.close(code, reason),
		};
	}
}
