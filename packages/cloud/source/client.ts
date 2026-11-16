import type { PulsePatchRow } from "pulsify-core/protocol";
import { onOnline, type Connector, type ConnectorSession } from "pulsify-core";
import {
	decodeMessage,
	MAX_FRAME_BYTES,
	PulseError,
	remoteError,
} from "pulsify-core/protocol";
import {
	createEmitter,
	type CloudConnection,
	type CloudConnectionEvents,
	type CloudConnectionState,
	type CloudPingReason,
} from "./events.js";
import { rootOf } from "./ids.js";
import {
	userActivity as pageActivity,
	type UserActivity,
} from "./userActivity.js";
import type { CloudRole } from "./roles.js";
import {
	CLOUD_PING,
	CLOUD_PONG,
	CLOUD_SUBPROTOCOLS,
	CLOUD_TOKEN_SUBPROTOCOL,
	cloudPath,
	parseServerMessage,
	peekFrameHeader,
	type CloudEnvelope,
	type CloudServerInfo,
	type CloudUnsubscribeMessage,
} from "./wire.js";

export type CloudCredential = string | (() => string | Promise<string>);
export type CloudConnectorOptions = {
	/** Base URL of the deployment, `https://…` or `wss://…`. */
	url: string;
	/** The user's identity token, or a function called for every new socket. */
	token: CloudCredential;
	/** Highest Pulsify envelope to offer. Defaults to the grouped envelope 2. */
	envelope?: CloudEnvelope;
	/** Keep a socket open this long after its last document closes. Default 5 s. */
	lingerMs?: number;
	/**
	 * Detect sockets that died without closing (sleep, network switch, proxy),
	 * one ping per socket whatever its number of documents. Any frame received
	 * answers a ping. `false` relies on transport errors only.
	 */
	heartbeat?:
		| {
				/**
				 * Lazy waking: before sending on a socket that received nothing for
				 * this long, ping it. Also when the user comes back. Default 5 s.
				 */
				staleMs?: number;
				/** Without any frame this long after a ping, close the socket. Default 5 s. */
				timeoutMs?: number;
				/**
				 * Also ping silent sockets this often while someone is present, so
				 * passive readers notice a dead socket; `false` pings only on
				 * demand. Default 2 s.
				 */
				intervalMs?: number | false;
		  }
		| false;
	/** Whether someone is looking at this app. Defaults to the shared page `userActivity`. */
	activity?: UserActivity;
	/** For runtimes without a global WebSocket. */
	createSocket?: (url: string, protocols: string[]) => WebSocket;
};
/**
 * A Pulsify connector that opens one WebSocket per root and multiplexes every
 * loaded document of that root over it. Load a document to subscribe to it;
 * destroy or disconnect the pulse to unsubscribe.
 */
export type CloudConnector = Connector & {
	/** The role the server reported for a subscribed document; `null` when denied or revoked. */
	roleOf(docId: string): CloudRole | null | undefined;
	onRole(listener: (docId: string, role: CloudRole | null) => void): () => void;
	/**
	 * The sockets currently open or opening, one per root: each talks to that
	 * root's server. A reconnection is a new connection.
	 */
	readonly connections: readonly CloudConnection[];
	/** Called with every current connection, then with each new one. */
	onConnection(listener: (connection: CloudConnection) => void): () => void;
	/**
	 * Close every socket for good (for example on logout): open pulses stop
	 * synchronizing with this connector instead of reconnecting.
	 */
	close(): void;
};

type Session = {
	onMessage(bytes: Uint8Array): void;
	onClose(error?: Error): void;
};
type Channel = {
	root: string;
	socket: WebSocket | undefined;
	envelope: CloudEnvelope | undefined;
	ready: Promise<void>;
	sessions: Map<string, Session>;
	closed: boolean;
	linger: ReturnType<typeof setTimeout> | undefined;
	heartbeat: ReturnType<typeof setInterval> | undefined;
	lastReceived: number;
	pingSentAt: number | undefined;
	pingTimer: ReturnType<typeof setTimeout> | undefined;
	state: CloudConnectionState;
	server: CloudServerInfo | undefined;
	/** The server said in its welcome that it relays presence frames. */
	presence: boolean;
	subtrees?: boolean;
	pendingFetches: number;
	latencyMs: number | undefined;
	error: Error | undefined;
	events: ReturnType<typeof createEmitter<CloudConnectionEvents>>;
	view: CloudConnection;
};

export function createCloudConnector(
	options: CloudConnectorOptions,
): CloudConnector {
	const channels = new Set<Channel>();
	let connectorClosed = false;
	const closedError = () =>
		new PulseError("CLOSED", "Connector closed", { retryable: false });
	const roles = new Map<string, CloudRole | null>();
	const roleListeners = new Set<
		(docId: string, role: CloudRole | null) => void
	>();
	const connectionListeners = new Set<(connection: CloudConnection) => void>();
	const createSocket =
		options.createSocket ??
		((url: string, protocols: string[]) => new WebSocket(url, protocols));
	const base = options.url.replace(/^http(s?):/, "ws$1:").replace(/\/+$/, "");
	const heartbeat =
		options.heartbeat === false
			? undefined
			: {
					staleMs: options.heartbeat?.staleMs ?? 5_000,
					timeoutMs: options.heartbeat?.timeoutMs ?? 5_000,
					intervalMs: options.heartbeat?.intervalMs ?? 2_000,
				};
	const activity = options.activity ?? pageActivity;
	let unwatch: (() => void) | undefined;

	const setState = (
		channel: Channel,
		state: CloudConnectionState,
		error?: Error,
	) => {
		channel.state = state;
		if (error) channel.error = error;
		if (error) channel.events.emit("state", state, error);
		else channel.events.emit("state", state);
	};

	let nextFetchId = Number.MAX_SAFE_INTEGER;
	const fetches = new Map<
		number,
		{
			channel: Channel;
			receive(bytes: Uint8Array): void;
			progress(batch: number): void;
			finish(complete: boolean): void;
			fail(error: Error): void;
		}
	>();
	const shutdown = (channel: Channel, error: Error) => {
		if (channel.closed) return;
		channel.closed = true;
		for (const fetch of fetches.values())
			if (fetch.channel === channel) fetch.fail(error);
		channels.delete(channel);
		clearTimeout(channel.linger);
		clearInterval(channel.heartbeat);
		clearTimeout(channel.pingTimer);
		const sessions = [...channel.sessions.values()];
		channel.sessions.clear();
		try {
			channel.socket?.close(1000);
		} catch {
			// Already closed.
		}
		setState(channel, "closed", error);
		for (const session of sessions) session.onClose(error);
	};

	const openChannel = (root: string): Channel => {
		const channel = {
			root,
			socket: undefined,
			envelope: undefined,
			ready: Promise.resolve(),
			sessions: new Map(),
			closed: false,
			linger: undefined,
			heartbeat: undefined,
			lastReceived: 0,
			pingSentAt: undefined,
			pingTimer: undefined,
			state: "connecting",
			server: undefined,
			presence: false,
			pendingFetches: 0,
			latencyMs: undefined,
			error: undefined,
			events: createEmitter<CloudConnectionEvents>(),
		} as Omit<Channel, "view"> as Channel;
		channel.view = {
			root,
			get state() {
				return channel.state;
			},
			get server() {
				return channel.server;
			},
			get envelope() {
				return channel.envelope;
			},
			get documents() {
				return [...channel.sessions.keys()];
			},
			get latencyMs() {
				return channel.latencyMs;
			},
			get error() {
				return channel.error;
			},
			on: (event, listener) => channel.events.on(event, listener),
		};
		channel.ready = (async () => {
			const token =
				typeof options.token === "function"
					? await options.token()
					: options.token;
			if (channel.closed) throw new PulseError("CLOSED", "Socket closed");
			const offered =
				(options.envelope ?? 2) === 2
					? [CLOUD_SUBPROTOCOLS[2], CLOUD_SUBPROTOCOLS[1]]
					: [CLOUD_SUBPROTOCOLS[1]];
			const socket = createSocket(`${base}${cloudPath(root, "connect")}`, [
				...offered,
				`${CLOUD_TOKEN_SUBPROTOCOL}${token}`,
			]);
			socket.binaryType = "arraybuffer";
			channel.socket = socket;
			await new Promise<void>((resolve, reject) => {
				let opened = false;
				socket.addEventListener("open", () => {
					const envelope = socket.protocol === CLOUD_SUBPROTOCOLS[2] ? 2 : 1;
					if (!offered.includes(CLOUD_SUBPROTOCOLS[envelope])) {
						const error = new PulseError(
							"UNSUPPORTED_VERSION",
							"The server selected no cloud protocol",
						);
						reject(error);
						shutdown(channel, error);
						return;
					}
					opened = true;
					channel.envelope = envelope;
					startHeartbeat(channel);
					setState(channel, "open");
					resolve();
				});
				socket.addEventListener("message", (event: MessageEvent) =>
					receive(channel, event.data),
				);
				socket.addEventListener("error", () => {
					const error = new PulseError("CONNECTION_FAILED", "WebSocket error");
					if (!opened) reject(error);
					shutdown(channel, error);
				});
				socket.addEventListener("close", (event: CloseEvent) => {
					const error = new PulseError(
						opened ? "CLOSED" : "CONNECTION_FAILED",
						event.reason || "WebSocket closed",
					);
					if (!opened) reject(error);
					shutdown(channel, error);
				});
			});
		})();
		channel.ready.catch((error: unknown) =>
			shutdown(
				channel,
				error instanceof Error
					? error
					: new PulseError("CONNECTION_FAILED", String(error)),
			),
		);
		channels.add(channel);
		for (const listener of [...connectionListeners]) listener(channel.view);
		return channel;
	};

	const ping = (channel: Channel, reason: CloudPingReason) => {
		if (
			!heartbeat ||
			channel.pingSentAt !== undefined ||
			channel.socket?.readyState !== 1
		)
			return;
		const sentAt = Date.now();
		channel.pingSentAt = sentAt;
		channel.socket.send(CLOUD_PING);
		channel.events.emit("ping", reason);
		channel.pingTimer = setTimeout(() => {
			// Any frame received since the ping proves the socket alive.
			if (channel.lastReceived >= sentAt) channel.pingSentAt = undefined;
			else {
				channel.events.emit("timeout", Date.now() - sentAt);
				shutdown(
					channel,
					new PulseError("CONNECTION_FAILED", "Heartbeat timed out"),
				);
			}
		}, heartbeat.timeoutMs);
	};
	/** Lazy waking: check a socket that was silent before relying on it. */
	const pingIfStale = (channel: Channel, reason: CloudPingReason) => {
		if (heartbeat && Date.now() - channel.lastReceived >= heartbeat.staleMs)
			ping(channel, reason);
	};
	/** The network changed: every socket is suspect. The user returned: silent ones. */
	const checkAll = (reason: "network" | "return") => {
		for (const channel of channels)
			if (channel.envelope)
				if (reason === "network") ping(channel, reason);
				else pingIfStale(channel, reason);
	};
	const watch = () => {
		if (unwatch) return;
		const stopOnline = onOnline(() => checkAll("network"));
		const stopReturn = activity.on("return", () => checkAll("return"));
		unwatch = () => {
			stopOnline();
			stopReturn();
		};
	};
	const startHeartbeat = (channel: Channel) => {
		channel.lastReceived = Date.now();
		watch();
		if (!heartbeat) return;
		const interval = heartbeat.intervalMs;
		if (interval === false) return;
		let lastTick = Date.now();
		channel.heartbeat = setInterval(() => {
			const now = Date.now();
			// A late tick means the process was suspended (sleep, mobile
			// background): whatever the platform reports, check the socket.
			const gapMs = now - lastTick;
			lastTick = now;
			if (gapMs > Math.max(3 * interval, 10_000)) {
				channel.events.emit("suspended", gapMs);
				ping(channel, "resume");
			} else if (
				activity.state.present &&
				now - channel.lastReceived >= interval
			)
				ping(channel, "interval");
		}, interval);
	};

	const receive = (channel: Channel, data: unknown) => {
		channel.lastReceived = Date.now();
		if (channel.pingSentAt !== undefined) {
			clearTimeout(channel.pingTimer);
			channel.latencyMs = channel.lastReceived - channel.pingSentAt;
			channel.pingSentAt = undefined;
			channel.events.emit("pong", channel.latencyMs);
		}
		try {
			if (data === CLOUD_PONG) return;
			if (typeof data === "string") {
				const message = parseServerMessage(data);
				if (message.type === "welcome") {
					channel.server = message.server;
					channel.presence = message.presence === true;
					channel.subtrees = message.subtrees === true;
					channel.events.emit("server", message.server);
					return;
				}
				if (message.type === "fetched" || message.type === "fetch-batch") {
					const fetch = fetches.get(message.requestId);
					if (fetch?.channel === channel) {
						if (message.type === "fetched") fetch.finish(message.complete);
						else fetch.progress(message.batch);
					}
					return;
				}
				if (
					!channel.sessions.has(message.docId) &&
					![...fetches.values()].some((fetch) => fetch.channel === channel)
				)
					return;
				if (
					roles.has(message.docId) &&
					roles.get(message.docId) === message.role
				)
					return;
				roles.set(message.docId, message.role);
				channel.events.emit("role", message.docId, message.role);
				for (const listener of [...roleListeners])
					listener(message.docId, message.role);
				return;
			}
			if (!(data instanceof ArrayBuffer))
				throw new PulseError("INVALID_MESSAGE", "Expected a binary frame");
			const bytes = new Uint8Array(data);
			const header = peekFrameHeader(bytes);
			const fetch = fetches.get(header.requestId);
			if (fetch && fetch.channel === channel) fetch.receive(bytes);
			else if (header.requestId < 2 ** 52)
				channel.sessions.get(header.docId)?.onMessage(bytes);
		} catch (error) {
			shutdown(
				channel,
				error instanceof PulseError
					? error
					: new PulseError("INVALID_MESSAGE", String(error)),
			);
		}
	};

	const scheduleIdle = (channel: Channel) => {
		if (channel.closed || channel.sessions.size || channel.pendingFetches)
			return;
		clearTimeout(channel.linger);
		channel.linger = setTimeout(
			() => shutdown(channel, new PulseError("CLOSED", "Idle socket closed")),
			options.lingerMs ?? 5_000,
		);
	};
	const release = (channel: Channel, docId: string, session: Session) => {
		if (channel.sessions.get(docId) !== session) return;
		channel.sessions.delete(docId);
		if (channel.closed) return;
		if (channel.socket?.readyState === 1) {
			const message: CloudUnsubscribeMessage = { type: "unsubscribe", docId };
			channel.socket.send(JSON.stringify(message));
		}
		scheduleIdle(channel);
	};

	return {
		kind: "remote",
		authoritativeDeletions: true,
		async prefetch(docId, input) {
			if (connectorClosed) throw closedError();
			const root = rootOf(docId);
			if (input.signal?.aborted)
				throw new PulseError("CLOSED", "Fetch aborted");
			const deadline = Date.now() + (input.timeoutMs ?? 10000);
			const wait = async <T>(promise: Promise<T>): Promise<T> =>
				new Promise<T>((resolve, reject) => {
					const abort = () => {
						cleanup();
						reject(new PulseError("CLOSED", "Fetch aborted"));
					};
					const timer = setTimeout(
						() => {
							cleanup();
							reject(new PulseError("TIMEOUT", "Subtree fetch timed out"));
						},
						Math.max(1, deadline - Date.now()),
					);
					const cleanup = () => {
						clearTimeout(timer);
						input.signal?.removeEventListener("abort", abort);
					};
					input.signal?.addEventListener("abort", abort, { once: true });
					if (input.signal?.aborted) {
						abort();
						return;
					}
					promise.then(
						(value) => {
							cleanup();
							resolve(value);
						},
						(error) => {
							cleanup();
							reject(error);
						},
					);
				});
			const channel =
				[...channels].find(
					(channel) => channel.root === root && !channel.closed,
				) ?? openChannel(root);
			channel.pendingFetches++;
			clearTimeout(channel.linger);
			try {
				await wait(channel.ready);
				if (!channel.server) {
					let stop: (() => void) | undefined;
					try {
						await wait(
							new Promise<void>((resolve) => {
								stop = channel.events.on("server", () => resolve());
							}),
						);
					} finally {
						stop?.();
					}
				}
				if (!channel.subtrees) return undefined;
				const requestId = nextFetchId--;
				const documents = new Map<string, PulsePatchRow[]>();
				return await new Promise<{
					documents: Map<string, PulsePatchRow[]>;
					complete: boolean;
				}>((resolve, reject) => {
					let settled = false,
						sent = false,
						batch = 0;
					let timer: ReturnType<typeof setTimeout>;
					const incomplete = new Set<string>();
					const done = (error?: Error) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						input.signal?.removeEventListener("abort", abort);
						fetches.delete(requestId);
						if (error) {
							if (sent && channel.socket?.readyState === 1) {
								try {
									channel.socket.send(
										JSON.stringify({ type: "cancel-fetch", requestId }),
									);
								} catch {
									/* The socket is already closing. */
								}
							}
							reject(error);
						} else resolve({ documents, complete: true });
					};
					const abort = () => done(new PulseError("CLOSED", "Fetch aborted"));
					// An active transfer may last as long as needed; only silence times out.
					const touch = () => {
						clearTimeout(timer);
						timer = setTimeout(
							() => done(new PulseError("TIMEOUT", "Subtree fetch timed out")),
							input.timeoutMs ?? 10000,
						);
					};
					fetches.set(requestId, {
						channel,
						finish(all) {
							if (!all || incomplete.size) {
								done(
									new PulseError(
										"INVALID_MESSAGE",
										"Incomplete subtree response",
									),
								);
								return;
							}
							done();
						},
						fail: (error) => done(error),
						progress(next) {
							if (next !== batch + 1) {
								done(
									new PulseError("INVALID_MESSAGE", "Unexpected subtree batch"),
								);
								return;
							}
							batch = next;
							touch();
							channel.socket!.send(
								JSON.stringify({ type: "fetch-ack", requestId, batch }),
							);
						},
						receive(frame) {
							touch();
							const message = decodeMessage(frame);
							const covered =
								message.docId === docId ||
								(input.descendants && message.docId.startsWith(`${docId}/`));
							if (!covered || (message.kind !== 2 && message.kind !== 6)) {
								done(
									new PulseError("INVALID_MESSAGE", "Invalid subtree response"),
								);
								return;
							}
							if (message.kind === 6) {
								if (message.docId !== docId && message.code === "NOT_FOUND") {
									for (const id of documents.keys()) {
										if (
											id === message.docId ||
											id.startsWith(`${message.docId}/`)
										) {
											documents.delete(id);
											incomplete.delete(id);
										}
									}
									return;
								}
								done(remoteError(message.code, message.message));
								return;
							}
							const rows = documents.get(message.docId) ?? [];
							for (const row of message.rows) rows.push(row);
							documents.set(message.docId, rows);
							if (message.complete) incomplete.delete(message.docId);
							else incomplete.add(message.docId);
						},
					});
					input.signal?.addEventListener("abort", abort, { once: true });
					if (input.signal?.aborted) {
						abort();
						return;
					}
					const request = {
						type: "fetch",
						docId,
						requestId,
						descendants: input.descendants,
						vectors: [] as typeof input.vectors,
					};
					// Vectors are optional bandwidth hints. Omit excess hints instead of
					// refusing an otherwise valid request for a large subtree.
					let length = JSON.stringify(request).length;
					for (const entry of input.vectors) {
						if (request.vectors.length === 4096) break;
						const size =
							JSON.stringify(entry).length + (request.vectors.length ? 1 : 0);
						if (length + size > 64 * 1024) continue;
						request.vectors.push(entry);
						length += size;
					}
					touch();
					try {
						sent = true;
						channel.socket!.send(JSON.stringify(request));
					} catch (error) {
						done(error instanceof Error ? error : new Error(String(error)));
					}
				});
			} finally {
				channel.pendingFetches--;
				scheduleIdle(channel);
			}
		},
		async open({ docId, signal, onMessage, onClose }) {
			if (connectorClosed) throw closedError();
			if (signal.aborted) throw new PulseError("CLOSED", "Connection aborted");
			const root = rootOf(docId);
			const channel =
				[...channels].find(
					(candidate) =>
						candidate.root === root && !candidate.sessions.has(docId),
				) ?? openChannel(root);
			clearTimeout(channel.linger);
			let closed = false;
			let established = false;
			const session: Session = {
				onMessage: (bytes) => {
					if (!closed) onMessage(bytes);
				},
				onClose: (error) => {
					if (closed) return;
					closed = true;
					signal.removeEventListener("abort", abort);
					// Before `open` resolves, its rejection carries the error.
					if (established) onClose(error);
				},
			};
			const abort = () => {
				release(channel, docId, session);
				session.onClose(new PulseError("CLOSED", "Connection aborted"));
			};
			channel.sessions.set(docId, session);
			signal.addEventListener("abort", abort, { once: true });
			await channel.ready;
			if (closed) throw new PulseError("CLOSED", "Connection closed");
			established = true;
			const socket = channel.socket!;
			const handle: ConnectorSession = {
				protocolVersion: channel.envelope!,
				// The welcome precedes every answer, so this is settled once connected.
				get presence() {
					return channel.presence;
				},
				close() {
					if (closed) return;
					closed = true;
					signal.removeEventListener("abort", abort);
					release(channel, docId, session);
				},
				async send(bytes) {
					if (closed || socket.readyState !== 1)
						throw new PulseError("CLOSED", "WebSocket is not open");
					if (socket.bufferedAmount + bytes.length > 2 * MAX_FRAME_BYTES)
						throw new PulseError(
							"LIMIT_EXCEEDED",
							"WebSocket output buffer exceeded",
						);
					// Sent before the frame, so its answer does not wait behind a large upload.
					pingIfStale(channel, "send");
					socket.send(bytes as Uint8Array<ArrayBuffer>);
				},
			};
			return handle;
		},
		roleOf: (docId) => roles.get(docId),
		onRole(listener) {
			roleListeners.add(listener);
			return () => roleListeners.delete(listener);
		},
		get connections() {
			return [...channels].map((channel) => channel.view);
		},
		onConnection(listener) {
			connectionListeners.add(listener);
			for (const channel of [...channels]) listener(channel.view);
			return () => connectionListeners.delete(listener);
		},
		close() {
			connectorClosed = true;
			unwatch?.();
			unwatch = undefined;
			for (const channel of [...channels]) shutdown(channel, closedError());
		},
	};
}
