import { Worker } from "node:worker_threads";
import {
	decodeMessage,
	encodeBroadcast,
	MAX_FRAME_BYTES,
	PulseError,
	streamStoreMessage,
} from "pulsify-core/protocol";
import {
	SqlitePatchStore,
	coversDocument,
	type SqliteConnection,
} from "pulsify-core/storage";
import {
	channelsOf,
	DEFAULT_CHANNEL,
	type PulsifyIpcResult,
} from "./bridge.js";
import type { WorkerReply, WorkerRequest } from "./worker.js";

/** The subset of a better-sqlite3 `Database` used by Pulsify. */
export type BetterSqliteDatabase = {
	exec(sql: string): unknown;
	prepare(sql: string): {
		run(...bindings: unknown[]): unknown;
		get(...bindings: unknown[]): unknown;
		all(...bindings: unknown[]): unknown[];
	};
	transaction<T>(work: () => T): (() => T) & { immediate(): T };
	close(): unknown;
};
/** The subset of Electron's `WebContents` used by Pulsify. */
export type ElectronWebContents = {
	readonly id: number;
	isDestroyed(): boolean;
	sendToFrame(
		frame: number | [processId: number, frameId: number],
		channel: string,
		...args: any[]
	): void;
	on(event: string, listener: (...args: any[]) => void): unknown;
	removeListener(event: string, listener: (...args: any[]) => void): unknown;
};
export type ElectronIpcMainInvokeEvent = {
	sender: ElectronWebContents;
	processId: number;
	frameId: number;
};
/** The subset of Electron's `ipcMain` used by Pulsify. */
export type ElectronIpcMain = {
	handle(
		channel: string,
		listener: (event: ElectronIpcMainInvokeEvent, ...args: any[]) => unknown,
	): void;
	removeHandler(channel: string): void;
};
export type PulsifyStoreOptions = {
	ipcMain: ElectronIpcMain;
	/** A file path (opened with WAL, closed by `close()`) or an open better-sqlite3 database owned by the caller. */
	database: BetterSqliteDatabase | string;
	/** IPC channel prefix; must match the preload bridge. Defaults to `"pulsify"`. */
	channel?: string;
};
export type PulsifyStoreServer = {
	/** Resolves once the database is open; rejects if it cannot be opened. */
	readonly ready: Promise<void>;
	/** Unregisters the IPC handlers, closes every session and closes an owned database. */
	close(): Promise<void>;
};

/** Adapts better-sqlite3 to the `SqliteConnection` expected by `SqlitePatchStore`. */
export function betterSqliteConnection(
	database: BetterSqliteDatabase,
): SqliteConnection {
	const statements = new Map<string, ReturnType<typeof database.prepare>>();
	return {
		exec: (sql) => database.exec(sql),
		query(sql) {
			let statement = statements.get(sql);
			if (!statement) statements.set(sql, (statement = database.prepare(sql)));
			return statement;
		},
		transaction: (work) => database.transaction(work),
	};
}

const queues = new WeakMap<object, Promise<unknown>>();
function serialize<T>(database: object, task: () => Promise<T>): Promise<T> {
	const run = (queues.get(database) ?? Promise.resolve()).then(task, task);
	queues.set(
		database,
		run.catch(() => {}),
	);
	return run;
}

type StoreBackend = {
	cached(docId: string): Promise<PulsifyIpcResult>;
	markDeleted(
		docId: string,
		frames: Uint8Array[],
		onDeleted: () => void,
	): Promise<PulsifyIpcResult>;
	send(
		docId: string,
		frame: Uint8Array,
		onFrame: (bytes: Uint8Array) => void,
		onBroadcast: (bytes: Uint8Array) => void,
	): Promise<PulsifyIpcResult>;
	close(): Promise<void>;
};

function createInlineBackend(database: BetterSqliteDatabase): {
	ready: Promise<StoreBackend>;
	dispose(): Promise<void>;
} {
	const store = new SqlitePatchStore(betterSqliteConnection(database));
	const backend: StoreBackend = {
		async cached(docId) {
			try {
				return { ok: true, found: (await store.vector(docId)).length > 0 };
			} catch (error) {
				return error instanceof PulseError
					? failure(error.code, error.message)
					: failure("CONNECTION_FAILED", String(error));
			}
		},
		async markDeleted(docId, frames, onDeleted) {
			try {
				await serialize(database, async () => {
					try {
						const rows = frames.flatMap((frame) => {
							const message = decodeMessage(frame);
							if (message.kind !== 3)
								throw new PulseError(
									"INVALID_MESSAGE",
									"Invalid recovery frame",
								);
							return message.rows;
						});
						await store.markDeleted(docId, rows);
					} catch (error) {
						// Recovery is optional; a malformed frame cannot undo deletion.
						await store.deleteDocuments(docId, { preserveRows: true });
						throw error;
					} finally {
						if (await store.isDeleted(docId)) onDeleted();
					}
				});
				return { ok: true };
			} catch (error) {
				return error instanceof PulseError
					? failure(error.code, error.message)
					: failure("CONNECTION_FAILED", String(error));
			}
		},
		send(docId, frame, onFrame, onBroadcast) {
			return serialize(database, async () => {
				let streamed: Awaited<ReturnType<typeof streamStoreMessage>>;
				try {
					streamed = await streamStoreMessage(store, frame, {
						docId,
						protocolVersion: 2,
					});
				} catch (error) {
					return error instanceof PulseError
						? failure(error.code, error.message)
						: failure("INVALID_MESSAGE", String(error));
				}
				let pages = 0;
				for await (const response of streamed.responses) {
					// Yield between pages so multi-page downloads stay responsive.
					if (pages++ > 0)
						await new Promise<void>((resolve) => setImmediate(resolve));
					onFrame(compact(response));
				}
				if (streamed.broadcast)
					onBroadcast(compact(encodeBroadcast(docId, streamed.broadcast, 2)));
				return { ok: true };
			});
		},
		close() {
			return serialize(database, async () => {});
		},
	};
	return { ready: Promise.resolve(backend), dispose: () => backend.close() };
}

function openWorkerBackend(path: string): {
	ready: Promise<StoreBackend>;
	dispose(): Promise<void>;
} {
	const workerUrl = new URL(
		import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
		import.meta.url,
	);
	const worker = new Worker(workerUrl, { workerData: { path } });
	type Pending = {
		resolve(result: PulsifyIpcResult): void;
		onFrame?: (bytes: Uint8Array) => void;
		onBroadcast?: (bytes: Uint8Array) => void;
		onDeleted?: () => void;
	};
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let exited = false;
	let opened = false;
	let resolveReady!: (backend: StoreBackend) => void;
	let rejectReady!: (error: Error) => void;
	const ready = new Promise<StoreBackend>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	const failAll = (message: string) => {
		for (const entry of pending.values())
			entry.resolve(failure("CLOSED", message));
		pending.clear();
	};
	const post = (request: WorkerRequest) => worker.postMessage(request);
	let closing: Promise<void> | undefined;
	const closeWorker = (): Promise<void> => {
		if (closing) return closing;
		closing = (async () => {
			await ready.catch(() => {});
			if (!exited && opened) {
				await new Promise<void>((resolve) => {
					const id = nextId++;
					const done = () => {
						pending.delete(id);
						resolve();
					};
					pending.set(id, { resolve: done });
					worker.once("exit", done);
					try {
						post({ id, type: "close" });
					} catch {
						done();
					}
				});
			}
			if (!exited) await worker.terminate().catch(() => {});
		})();
		return closing;
	};

	const backend: StoreBackend = {
		cached(docId) {
			if (exited)
				return Promise.resolve(failure("CLOSED", "Pulsify store closed"));
			return new Promise((resolve) => {
				const id = nextId++;
				pending.set(id, { resolve });
				post({ id, type: "cached", docId });
			});
		},
		markDeleted(docId, frames, onDeleted) {
			if (exited)
				return Promise.resolve(failure("CLOSED", "Pulsify store closed"));
			return new Promise((resolve) => {
				const id = nextId++;
				pending.set(id, { resolve, onDeleted });
				post({ id, type: "markDeleted", docId, frames });
			});
		},
		send(docId, frame, onFrame, onBroadcast) {
			if (exited) return Promise.resolve(failure("CLOSED", "Session closed"));
			return new Promise((resolve) => {
				const id = nextId++;
				pending.set(id, { resolve, onFrame, onBroadcast });
				post({ id, type: "send", docId, frame });
			});
		},
		close: closeWorker,
	};

	worker.on("message", (reply: WorkerReply) => {
		if (reply.type === "ready") {
			if ("error" in reply) {
				rejectReady(new Error(reply.error));
			} else {
				opened = true;
				resolveReady(backend);
			}
			return;
		}
		const entry = pending.get(reply.id);
		if (!entry) return;
		switch (reply.type) {
			case "frame":
				entry.onFrame?.(reply.bytes);
				return;
			case "done":
				pending.delete(reply.id);
				if (reply.broadcast) entry.onBroadcast?.(reply.broadcast);
				entry.resolve({ ok: true });
				return;
			case "cached":
				pending.delete(reply.id);
				entry.resolve({ ok: true, found: reply.found });
				return;
			case "deleted":
				pending.delete(reply.id);
				if (reply.deleted) entry.onDeleted?.();
				entry.resolve({ ok: true });
				return;
			case "error":
				pending.delete(reply.id);
				if (reply.deleted) entry.onDeleted?.();
				entry.resolve(failure(reply.code, reply.message));
				return;
			case "closed":
				pending.delete(reply.id);
				entry.resolve({ ok: true });
				return;
		}
	});
	worker.on("error", (error: unknown) => {
		const err = error instanceof Error ? error : new Error(String(error));
		if (!opened) rejectReady(err);
		failAll(err.message);
	});
	worker.on("exit", () => {
		exited = true;
		if (!opened) rejectReady(new Error("Pulsify store worker exited"));
		failAll("Pulsify store closed");
	});

	return { ready, dispose: closeWorker };
}

async function openDatabase(path: string): Promise<BetterSqliteDatabase> {
	const { default: Database } = await import("better-sqlite3");
	const database = new Database(path, { timeout: 5000 });
	try {
		database.exec("PRAGMA journal_mode = WAL");
	} catch (error) {
		database.close();
		throw error;
	}
	return database;
}

/**
 * A file path: SQLite on a worker thread. A main process bundled without
 * `worker.js` beside it, or packaged where a worker cannot load, falls back
 * to SQLite on the main thread, as before the worker existed.
 */
function openFileBackend(path: string): {
	ready: Promise<StoreBackend>;
	dispose(): Promise<void>;
} {
	let dispose: () => Promise<void> = async () => {};
	const inline = async () => {
		const database = await openDatabase(path);
		const runtime = createInlineBackend(database);
		dispose = async () => {
			await runtime.dispose();
			database.close();
		};
		return runtime.ready;
	};
	let ready: Promise<StoreBackend>;
	try {
		const worker = openWorkerBackend(path);
		dispose = worker.dispose;
		ready = worker.ready.catch(async () => {
			await worker.dispose().catch(() => {});
			return inline();
		});
	} catch {
		ready = inline();
	}
	return { ready, dispose: () => dispose() };
}

function compact(bytes: Uint8Array): Uint8Array {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? bytes
		: bytes.slice();
}

function failure(code: string, message: string): PulsifyIpcResult {
	return { ok: false, code, message };
}

type Session = {
	id: string;
	docId: string;
	sender: ElectronWebContents;
	frame: [processId: number, frameId: number];
};
type Client = { sessions: Map<string, Session>; detach(): void };

/**
 * Serve Pulsify documents from SQLite in Electron's main process. When given a
 * file path, SQLite runs on a dedicated worker thread so writes, large reads,
 * and busy timeouts never block the main thread. Stored rows are pushed to
 * every other session of the document, across windows.
 */
export function servePulsifyStore(
	options: PulsifyStoreOptions,
): PulsifyStoreServer {
	const { ipcMain } = options;
	const channels = channelsOf(options.channel ?? DEFAULT_CHANNEL);
	const clients = new Map<ElectronWebContents, Client>();
	const documents = new Map<string, Set<Session>>();
	let closed = false;
	const runtime =
		typeof options.database === "string"
			? openFileBackend(options.database)
			: createInlineBackend(options.database);
	const opening = runtime.ready.then((backend) => {
		if (closed) throw new PulseError("CLOSED", "Pulsify store closed");
		return backend;
	});
	const ready = opening.then(() => {});
	ready.catch(() => {});

	const push = (session: Session, channel: string, ...args: unknown[]) => {
		if (session.sender.isDestroyed()) return;
		try {
			session.sender.sendToFrame(session.frame, channel, session.id, ...args);
		} catch {}
	};
	const drop = (session: Session, notify?: PulseError) => {
		const client = clients.get(session.sender);
		if (client?.sessions.get(session.id) !== session) return;
		client.sessions.delete(session.id);
		const peers = documents.get(session.docId);
		peers?.delete(session);
		if (peers?.size === 0) documents.delete(session.docId);
		if (notify) push(session, channels.closed, notify.code, notify.message);
		if (!client.sessions.size) {
			client.detach();
			clients.delete(session.sender);
		}
	};
	const clientOf = (sender: ElectronWebContents): Client => {
		const existing = clients.get(sender);
		if (existing) return existing;
		const sessions = new Map<string, Session>();
		const dropAll = () => {
			for (const session of [...sessions.values()]) drop(session);
		};
		const navigated = (
			_event: unknown,
			_url: unknown,
			_status: unknown,
			_statusText: unknown,
			isMainFrame: boolean,
			processId: number,
			routingId: number,
		) => {
			for (const session of [...sessions.values()])
				if (
					isMainFrame ||
					(session.frame[0] === processId && session.frame[1] === routingId)
				)
					drop(session);
		};
		sender.on("destroyed", dropAll);
		sender.on("render-process-gone", dropAll);
		sender.on("did-frame-navigate", navigated);
		const client: Client = {
			sessions,
			detach() {
				sender.removeListener("destroyed", dropAll);
				sender.removeListener("render-process-gone", dropAll);
				sender.removeListener("did-frame-navigate", navigated);
			},
		};
		clients.set(sender, client);
		return client;
	};

	ipcMain.handle(
		channels.cached,
		async (_event, docId: unknown): Promise<PulsifyIpcResult> => {
			if (closed) return failure("CLOSED", "Pulsify store closed");
			if (typeof docId !== "string")
				return failure("INVALID_MESSAGE", "Invalid document ID");
			try {
				const backend = await opening;
				return await backend.cached(docId);
			} catch (error) {
				return error instanceof PulseError
					? failure(error.code, error.message)
					: failure("CONNECTION_FAILED", String(error));
			}
		},
	);
	ipcMain.handle(
		channels.markDeleted,
		async (
			_event,
			docId: unknown,
			frames: unknown,
		): Promise<PulsifyIpcResult> => {
			if (closed) return failure("CLOSED", "Pulsify store closed");
			if (
				typeof docId !== "string" ||
				!Array.isArray(frames) ||
				frames.some((frame) => !(frame instanceof Uint8Array))
			)
				return failure("INVALID_MESSAGE", "Invalid deletion request");
			try {
				const backend = await opening;
				return await backend.markDeleted(docId, frames, () => {
					for (const [id, peers] of [...documents])
						if (coversDocument(docId, id))
							for (const peer of [...peers])
								drop(
									peer,
									new PulseError(
										"NOT_FOUND",
										"Document was permanently deleted",
									),
								);
				});
			} catch (error) {
				return error instanceof PulseError
					? failure(error.code, error.message)
					: failure("CONNECTION_FAILED", String(error));
			}
		},
	);
	ipcMain.handle(
		channels.open,
		async (event, id: unknown, docId: unknown): Promise<PulsifyIpcResult> => {
			if (
				typeof id !== "string" ||
				!id ||
				id.length > 128 ||
				typeof docId !== "string"
			)
				return failure("INVALID_MESSAGE", "Invalid open request");
			if (closed) return failure("CLOSED", "Pulsify store closed");
			try {
				await opening;
			} catch (error) {
				return closed
					? failure("CLOSED", "Pulsify store closed")
					: failure(
							"CONNECTION_FAILED",
							`Cannot open the Pulsify database: ${error instanceof Error ? error.message : String(error)}`,
						);
			}
			if (closed) return failure("CLOSED", "Pulsify store closed");
			if (event.sender.isDestroyed())
				return failure("CLOSED", "Window destroyed");
			const client = clientOf(event.sender);
			if (client.sessions.has(id))
				return failure("INVALID_MESSAGE", "Session already open");
			const session: Session = {
				id,
				docId,
				sender: event.sender,
				frame: [event.processId, event.frameId],
			};
			client.sessions.set(id, session);
			let peers = documents.get(docId);
			if (!peers) documents.set(docId, (peers = new Set()));
			peers.add(session);
			return { ok: true };
		},
	);
	ipcMain.handle(
		channels.send,
		async (event, id: unknown, frame: unknown): Promise<PulsifyIpcResult> => {
			const session =
				typeof id === "string"
					? clients.get(event.sender)?.sessions.get(id)
					: undefined;
			if (!session || closed) return failure("CLOSED", "Session closed");
			if (!(frame instanceof Uint8Array))
				return failure("INVALID_MESSAGE", "Expected a binary frame");
			if (frame.byteLength > MAX_FRAME_BYTES)
				return failure("LIMIT_EXCEEDED", "Frame too large");
			let backend: StoreBackend;
			try {
				backend = await opening;
			} catch {
				return failure("CLOSED", "Session closed");
			}
			return backend.send(
				session.docId,
				frame,
				(bytes) => {
					if (documents.get(session.docId)?.has(session))
						push(session, channels.message, bytes);
				},
				(bytes) => {
					const peers = documents.get(session.docId);
					if (peers)
						for (const peer of peers)
							if (peer !== session) push(peer, channels.message, bytes);
				},
			);
		},
	);
	ipcMain.handle(channels.close, (event, id: unknown) => {
		if (typeof id !== "string") return;
		const session = clients.get(event.sender)?.sessions.get(id);
		if (session) drop(session);
	});

	return {
		ready,
		async close() {
			if (closed) return;
			closed = true;
			ipcMain.removeHandler(channels.open);
			ipcMain.removeHandler(channels.markDeleted);
			ipcMain.removeHandler(channels.cached);
			ipcMain.removeHandler(channels.send);
			ipcMain.removeHandler(channels.close);
			const error = new PulseError("CLOSED", "Pulsify store closed");
			for (const client of [...clients.values()])
				for (const session of [...client.sessions.values()])
					drop(session, error);
			await opening.catch(() => {});
			await runtime.dispose();
		},
	};
}
