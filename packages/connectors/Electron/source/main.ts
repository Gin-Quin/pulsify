import {
	encodeBroadcast,
	MAX_FRAME_BYTES,
	PulseError,
	relayStoreMessage,
} from "@pulsify/core/protocol";
import { SqlitePatchStore, type SqliteConnection } from "@pulsify/core/storage";
import {
	channelsOf,
	DEFAULT_CHANNEL,
	type PulsifyIpcResult,
} from "./bridge.js";

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
 * Serve Pulsify documents from SQLite in Electron's main process. Each renderer
 * session relays protocol frames through `relayStoreMessage`; stored rows are
 * pushed to every other session of the document, across windows.
 */
export function servePulsifyStore(
	options: PulsifyStoreOptions,
): PulsifyStoreServer {
	const { ipcMain } = options;
	const channels = channelsOf(options.channel ?? DEFAULT_CHANNEL);
	const owned = typeof options.database === "string";
	const clients = new Map<ElectronWebContents, Client>();
	const documents = new Map<string, Set<Session>>();
	let closed = false;
	let database: BetterSqliteDatabase | undefined;
	const opening = (
		typeof options.database === "string"
			? openDatabase(options.database)
			: Promise.resolve(options.database)
	).then((opened) => {
		database = opened;
		if (closed) throw new PulseError("CLOSED", "Pulsify store closed");
		return new SqlitePatchStore(betterSqliteConnection(opened));
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
			const store = await opening;
			return serialize(database!, async () => {
				let result: Awaited<ReturnType<typeof relayStoreMessage>>;
				try {
					result = await relayStoreMessage(store, frame, {
						docId: session.docId,
						protocolVersion: 2,
					});
				} catch (error) {
					return error instanceof PulseError
						? failure(error.code, error.message)
						: failure("INVALID_MESSAGE", String(error));
				}
				const peers = documents.get(session.docId);
				if (peers?.has(session))
					for (const response of result.responses)
						push(session, channels.message, compact(response));
				if (result.broadcast && peers) {
					const bytes = compact(
						encodeBroadcast(session.docId, result.broadcast, 2),
					);
					for (const peer of peers)
						if (peer !== session) push(peer, channels.message, bytes);
				}
				return { ok: true };
			});
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
			ipcMain.removeHandler(channels.send);
			ipcMain.removeHandler(channels.close);
			const error = new PulseError("CLOSED", "Pulsify store closed");
			for (const client of [...clients.values()])
				for (const session of [...client.sessions.values()])
					drop(session, error);
			await opening.catch(() => {});
			if (owned && database) {
				const opened = database;
				await serialize(opened, async () => {
					opened.close();
				});
			}
		},
	};
}
