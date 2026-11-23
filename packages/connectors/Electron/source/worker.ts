import { parentPort, workerData } from "node:worker_threads";
import {
	decodeMessage,
	encodeBroadcast,
	PulseError,
	streamStoreMessage,
} from "pulsify-core/protocol";
import { SqlitePatchStore, type SqliteConnection } from "pulsify-core/storage";

type BetterSqliteDatabase = {
	exec(sql: string): unknown;
	prepare(sql: string): {
		run(...bindings: unknown[]): unknown;
		get(...bindings: unknown[]): unknown;
		all(...bindings: unknown[]): unknown[];
	};
	transaction<T>(work: () => T): (() => T) & { immediate(): T };
	close(): unknown;
};

export type WorkerRequest =
	| { id: number; type: "cached"; docId: string }
	| { id: number; type: "send"; docId: string; frame: Uint8Array }
	| { id: number; type: "markDeleted"; docId: string; frames: Uint8Array[] }
	| { id: number; type: "close" };

export type WorkerReply =
	| { type: "ready" }
	| { type: "ready"; error: string }
	| { id: number; type: "cached"; found: boolean }
	| { id: number; type: "frame"; bytes: Uint8Array }
	| { id: number; type: "done"; broadcast?: Uint8Array }
	| { id: number; type: "deleted"; deleted: boolean }
	| {
			id: number;
			type: "error";
			code: string;
			message: string;
			deleted?: boolean;
	  }
	| { id: number; type: "closed" };

function compact(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (
		bytes.byteOffset === 0 &&
		bytes.byteLength === bytes.buffer.byteLength &&
		bytes.buffer instanceof ArrayBuffer
	)
		return bytes as Uint8Array<ArrayBuffer>;
	return bytes.slice();
}

async function run(): Promise<void> {
	const port = parentPort;
	if (!port) return;
	const { path } = workerData as { path: string };
	let database: BetterSqliteDatabase;
	let store: SqlitePatchStore;
	try {
		const { default: Database } = await import("better-sqlite3");
		database = new Database(path, { timeout: 5000 });
		try {
			database.exec("PRAGMA journal_mode = WAL");
		} catch (error) {
			database.close();
			throw error;
		}
		const statements = new Map<string, ReturnType<typeof database.prepare>>();
		const connection: SqliteConnection = {
			exec: (sql) => database.exec(sql),
			query(sql) {
				let statement = statements.get(sql);
				if (!statement)
					statements.set(sql, (statement = database.prepare(sql)));
				return statement;
			},
			transaction: (work) => database.transaction(work),
		};
		store = new SqlitePatchStore(connection);
	} catch (error) {
		port.postMessage({
			type: "ready",
			error: error instanceof Error ? error.message : String(error),
		} satisfies WorkerReply);
		port.close();
		return;
	}

	let queue: Promise<void> = Promise.resolve();
	let closed = false;

	const handle = async (request: WorkerRequest): Promise<void> => {
		if (closed) {
			if (request.type === "close") {
				port.postMessage({
					id: request.id,
					type: "closed",
				} satisfies WorkerReply);
				return;
			}
			port.postMessage({
				id: request.id,
				type: "error",
				code: "CLOSED",
				message: "Pulsify store closed",
			} satisfies WorkerReply);
			return;
		}
		switch (request.type) {
			case "cached": {
				try {
					const found = (await store.vector(request.docId)).length > 0;
					port.postMessage({
						id: request.id,
						type: "cached",
						found,
					} satisfies WorkerReply);
				} catch (error) {
					const [code, message] =
						error instanceof PulseError
							? [error.code, error.message]
							: ["CONNECTION_FAILED", String(error)];
					port.postMessage({
						id: request.id,
						type: "error",
						code,
						message,
					} satisfies WorkerReply);
				}
				return;
			}
			case "send": {
				try {
					const result = await streamStoreMessage(store, request.frame, {
						docId: request.docId,
						protocolVersion: 2,
					});
					for await (const response of result.responses) {
						const bytes = compact(response);
						port.postMessage(
							{ id: request.id, type: "frame", bytes } satisfies WorkerReply,
							[bytes.buffer],
						);
					}
					if (result.broadcast) {
						const broadcast = compact(
							encodeBroadcast(request.docId, result.broadcast, 2),
						);
						port.postMessage(
							{ id: request.id, type: "done", broadcast } satisfies WorkerReply,
							[broadcast.buffer],
						);
					} else {
						port.postMessage({
							id: request.id,
							type: "done",
						} satisfies WorkerReply);
					}
				} catch (error) {
					const [code, message] =
						error instanceof PulseError
							? [error.code, error.message]
							: ["INVALID_MESSAGE", String(error)];
					port.postMessage({
						id: request.id,
						type: "error",
						code,
						message,
					} satisfies WorkerReply);
				}
				return;
			}
			case "markDeleted": {
				let deleted = false;
				try {
					const rows = request.frames.flatMap((frame) => {
						const message = decodeMessage(frame);
						if (message.kind !== 3)
							throw new PulseError("INVALID_MESSAGE", "Invalid recovery frame");
						return message.rows;
					});
					await store.markDeleted(request.docId, rows);
					deleted = await store.isDeleted(request.docId);
					port.postMessage({
						id: request.id,
						type: "deleted",
						deleted,
					} satisfies WorkerReply);
				} catch (error) {
					try {
						await store.deleteDocuments(request.docId, { preserveRows: true });
					} catch {}
					try {
						deleted = await store.isDeleted(request.docId);
					} catch {}
					const [code, message] =
						error instanceof PulseError
							? [error.code, error.message]
							: ["CONNECTION_FAILED", String(error)];
					port.postMessage({
						id: request.id,
						type: "error",
						code,
						message,
						deleted,
					} satisfies WorkerReply);
				}
				return;
			}
			case "close": {
				closed = true;
				try {
					database.close();
				} finally {
					port.postMessage({
						id: request.id,
						type: "closed",
					} satisfies WorkerReply);
					port.close();
				}
				return;
			}
		}
	};

	port.on("message", (request: WorkerRequest) => {
		queue = queue.then(() => handle(request));
	});
	port.postMessage({ type: "ready" } satisfies WorkerReply);
}

void run();
