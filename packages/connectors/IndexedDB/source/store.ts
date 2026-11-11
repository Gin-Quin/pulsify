import {
	PulseError,
	validateVector,
	type PulseVersionVector,
} from "pulsify-core/protocol";
import {
	type AppendResult,
	type PatchStore,
	type StoredPatchRow,
} from "pulsify-core/storage";
import {
	assertCompatible,
	covered,
	MAX_VECTOR_ENTRIES,
	rowsFromFrame,
	sameRow,
	validateDocId,
	validateRows,
} from "./rows.js";

export type IndexedDbOptions = {
	/** Database name, also used for the cross-tab channel. Defaults to `"pulsify"`. */
	name?: string;
	/** Defaults to `globalThis.indexedDB`. */
	indexedDB?: IDBFactory;
	/** Defaults to `globalThis.IDBKeyRange`; pass the one matching `indexedDB`. */
	IDBKeyRange?: typeof IDBKeyRange;
	/** Durability hint for write transactions. */
	durability?: IDBTransactionDurability;
};

/** One immutable segment: `[docId, sid, clock]` is the primary key. */
type RowRecord = {
	docId: string;
	sid: number;
	clock: number;
	span: number;
	end: number;
	dependencies: PulseVersionVector;
	operations: Uint8Array;
	ready: 0 | 1;
};
/** The ready frontier of one actor: `[docId, sid]` is the primary key. */
type ClockRecord = { docId: string; sid: number; clock: number };

const VERSION = 1;
const ROWS = "rows";
const CLOCKS = "clocks";
/** `[docId, ready, sid, end]`: ready rows to send, or pending rows to promote. */
const BY_STATE = "state";

function request<T>(pending: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		pending.onsuccess = () => resolve(pending.result);
		pending.onerror = () => reject(pending.error);
	});
}
function unpack(record: RowRecord): StoredPatchRow {
	return {
		docId: record.docId,
		sid: record.sid,
		clock: record.clock,
		span: record.span,
		dependencies: record.dependencies,
		operations: record.operations,
	};
}
function pack(row: StoredPatchRow, ready: boolean): RowRecord {
	const { operations } = row;
	return {
		docId: row.docId,
		sid: row.sid,
		clock: row.clock,
		span: row.span,
		end: row.clock + row.span,
		dependencies: row.dependencies.map(([sid, clock]) => [sid, clock]),
		// A view would clone its whole underlying frame buffer.
		operations:
			operations.byteOffset === 0 &&
			operations.byteLength === operations.buffer.byteLength
				? operations
				: operations.slice(),
		ready: ready ? 1 : 0,
	};
}
function storageError(error: unknown): PulseError {
	if (error instanceof PulseError) return error;
	const name = (error as { name?: unknown } | null)?.name;
	return new PulseError(
		name === "QuotaExceededError" ? "LIMIT_EXCEEDED" : "CONNECTION_FAILED",
		`IndexedDB: ${error instanceof Error ? error.message : String(error)}`,
		{ cause: error },
	);
}

/**
 * The `SqlitePatchStore` semantics on IndexedDB: immutable rows, atomic
 * batches, and a per-document frontier advanced only by causally complete rows.
 */
export class IndexedDbPatchStore implements PatchStore {
	readonly name: string;
	private opening: Promise<IDBDatabase> | undefined;
	private closed = false;
	private readonly lost = new Set<(error: PulseError) => void>();
	constructor(private readonly options: IndexedDbOptions = {}) {
		this.name = options.name ?? "pulsify";
	}

	/** Opens the database once; a failed attempt is retried by the next call. */
	database(): Promise<IDBDatabase> {
		if (this.closed)
			return Promise.reject(
				new PulseError("CLOSED", "IndexedDB store closed", {
					retryable: false,
				}),
			);
		const opening = (this.opening ??= this.connect().catch((error) => {
			if (this.opening === opening) this.opening = undefined;
			throw storageError(error);
		}));
		return opening;
	}
	/** Called when the browser or another tab closes the connection. */
	onConnectionLost(listener: (error: PulseError) => void): () => void {
		this.lost.add(listener);
		return () => this.lost.delete(listener);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		void this.opening?.then(
			(db) => db.close(),
			() => {},
		);
		this.opening = undefined;
	}

	async appendEncoded(frame: Uint8Array): Promise<AppendResult> {
		return this.append(rowsFromFrame(frame));
	}
	async append(rows: readonly StoredPatchRow[]): Promise<AppendResult> {
		const docId = validateRows(rows);
		if (docId === undefined) return { inserted: 0, ready: 0, pending: 0 };
		return this.transaction("readwrite", (rows_, clocks) =>
			this.write(rows_, clocks, docId, rows),
		);
	}
	async vector(docId: string): Promise<PulseVersionVector> {
		validateDocId(docId);
		return this.transaction("readonly", async (_, clocks) =>
			this.readVector(clocks, docId),
		);
	}
	async missing(
		docId: string,
		remote: PulseVersionVector,
	): Promise<StoredPatchRow[]> {
		validateDocId(docId);
		validateVector(remote);
		const peer = new Map(remote);
		return this.transaction("readonly", async (rows, clocks) => {
			const index = rows.index(BY_STATE);
			const runs = await Promise.all(
				(await this.readVector(clocks, docId))
					.filter(([sid, clock]) => clock > (peer.get(sid) ?? 0))
					.map(([sid]) =>
						request<RowRecord[]>(
							index.getAll(
								this.keys.bound(
									[docId, 1, sid, peer.get(sid) ?? 0],
									[docId, 1, sid, Infinity],
									true,
								),
							),
						),
					),
			);
			return runs.flat().map(unpack);
		});
	}
	/** Deletes every stored row of one document. */
	async forget(docId: string): Promise<void> {
		validateDocId(docId);
		await this.transaction("readwrite", async (rows, clocks) => {
			const range = this.documentRange(docId);
			rows.delete(range);
			clocks.delete(range);
		});
	}
	/** Deletes every document in this database. */
	async clear(): Promise<void> {
		await this.transaction("readwrite", async (rows, clocks) => {
			rows.clear();
			clocks.clear();
		});
	}

	private get keys(): typeof IDBKeyRange {
		const keys = this.options.IDBKeyRange ?? globalThis.IDBKeyRange;
		if (!keys)
			throw new PulseError("CONNECTION_FAILED", "IDBKeyRange is unavailable", {
				retryable: false,
			});
		return keys;
	}
	private documentRange(docId: string): IDBKeyRange {
		return this.keys.bound([docId], [docId, []]);
	}
	private connect(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const factory = this.options.indexedDB ?? globalThis.indexedDB;
			if (!factory)
				throw new PulseError("CONNECTION_FAILED", "IndexedDB is unavailable", {
					retryable: false,
				});
			const open = factory.open(this.name, VERSION);
			open.onupgradeneeded = () => {
				const db = open.result;
				if (!db.objectStoreNames.contains(ROWS))
					db.createObjectStore(ROWS, {
						keyPath: ["docId", "sid", "clock"],
					}).createIndex(BY_STATE, ["docId", "ready", "sid", "end"]);
				if (!db.objectStoreNames.contains(CLOCKS))
					db.createObjectStore(CLOCKS, { keyPath: ["docId", "sid"] });
			};
			open.onerror = () =>
				reject(
					new PulseError("CONNECTION_FAILED", "Cannot open IndexedDB", {
						cause: open.error,
					}),
				);
			open.onsuccess = () => {
				const db = open.result;
				if (this.closed) {
					db.close();
					reject(
						new PulseError("CLOSED", "IndexedDB store closed", {
							retryable: false,
						}),
					);
					return;
				}
				const lose = (reason: string) => {
					db.close();
					if (this.opening === opening) this.opening = undefined;
					const error = new PulseError("CONNECTION_FAILED", reason);
					for (const listener of [...this.lost]) listener(error);
				};
				const opening = this.opening;
				db.onversionchange = () => lose("IndexedDB upgraded elsewhere");
				db.onclose = () => lose("IndexedDB connection lost");
				resolve(db);
			};
		});
	}
	/** Runs `work` in one transaction and resolves once it has committed. */
	private async transaction<T>(
		mode: IDBTransactionMode,
		work: (rows: IDBObjectStore, clocks: IDBObjectStore) => Promise<T>,
	): Promise<T> {
		const db = await this.database();
		return new Promise<T>((resolve, reject) => {
			let tx: IDBTransaction;
			try {
				tx = db.transaction(
					[ROWS, CLOCKS],
					mode,
					this.options.durability
						? { durability: this.options.durability }
						: undefined,
				);
			} catch (error) {
				reject(storageError(error));
				return;
			}
			let result: { value: T } | undefined, failure: unknown;
			tx.oncomplete = () =>
				result
					? resolve(result.value)
					: reject(
							storageError(failure ?? "Transaction completed without a result"),
						);
			tx.onabort = () =>
				reject(storageError(failure ?? tx.error ?? "Transaction aborted"));
			work(tx.objectStore(ROWS), tx.objectStore(CLOCKS)).then(
				(value) => {
					result = { value };
				},
				(error: unknown) => {
					failure ??= error;
					try {
						tx.abort();
					} catch {
						// Already aborted by the failed request.
					}
				},
			);
		});
	}
	private async readVector(
		clocks: IDBObjectStore,
		docId: string,
	): Promise<PulseVersionVector> {
		const records = await request<ClockRecord[]>(
			clocks.getAll(this.documentRange(docId)),
		);
		return records.map(({ sid, clock }) => [sid, clock]);
	}
	private async write(
		store: IDBObjectStore,
		clocks: IDBObjectStore,
		docId: string,
		rows: readonly StoredPatchRow[],
	): Promise<AppendResult> {
		const keys = this.keys;
		const byActor = new Map<number, StoredPatchRow[]>();
		for (const row of rows) {
			const list = byActor.get(row.sid);
			if (list) list.push(row);
			else byActor.set(row.sid, [row]);
		}
		// The stored rows around and inside each actor's incoming clock range
		// are enough to detect duplicates, overlaps and forks.
		const nearby = Promise.all(
			[...byActor].map(async ([sid, list]) => {
				list.sort((a, b) => a.clock - b.clock);
				const first = list[0]!.clock,
					last = list[list.length - 1]!.clock;
				const [before, within, after] = await Promise.all([
					request(
						store.openCursor(
							keys.bound([docId, sid], [docId, sid, first], false, true),
							"prev",
						),
					),
					request<RowRecord[]>(
						store.getAll(keys.bound([docId, sid, first], [docId, sid, last])),
					),
					request(
						store.openCursor(
							keys.bound([docId, sid, last], [docId, sid, []], true),
						),
					),
				]);
				const stored = within.map(unpack);
				if (before) stored.unshift(unpack(before.value as RowRecord));
				if (after) stored.push(unpack(after.value as RowRecord));
				return { list, stored };
			}),
		);
		const [actors, frontierVector, waiting] = await Promise.all([
			nearby,
			this.readVector(clocks, docId),
			request<RowRecord[]>(
				store.index(BY_STATE).getAll(keys.bound([docId, 0], [docId, 0, []])),
			),
		]);

		const fresh: StoredPatchRow[] = [];
		for (const { list, stored } of actors) {
			const known = new Map(stored.map((row) => [row.clock, row]));
			const added: StoredPatchRow[] = [];
			for (const row of list) {
				const existing = known.get(row.clock);
				if (existing) {
					if (!sameRow(existing, row))
						throw new PulseError("CONFLICT", "Conflicting storage segment");
					continue;
				}
				known.set(row.clock, row);
				added.push(row);
			}
			if (!added.length) continue;
			fresh.push(...added);
			const isNew = new Set(added);
			const merged = [...known.values()].sort((a, b) => a.clock - b.clock);
			for (let i = 1; i < merged.length; i++) {
				const previous = merged[i - 1]!,
					next = merged[i]!;
				if (isNew.has(previous) || isNew.has(next))
					assertCompatible(previous, next);
			}
		}

		const frontier = new Map(frontierVector);
		let pending: StoredPatchRow[] = [...waiting.map(unpack), ...fresh].sort(
			(a, b) => a.sid - b.sid || a.clock - b.clock,
		);
		if (
			new Set([...frontier.keys(), ...pending.map((row) => row.sid)]).size >
			MAX_VECTOR_ENTRIES
		)
			throw new PulseError("LIMIT_EXCEEDED", "Document actor limit exceeded");
		const promoted = new Set<StoredPatchRow>();
		const changedActors = new Set<number>();
		let changed: boolean;
		do {
			changed = false;
			const blocked: StoredPatchRow[] = [];
			for (const row of pending) {
				if (
					row.clock !== (frontier.get(row.sid) ?? 1) ||
					!covered(frontier, row.dependencies)
				) {
					blocked.push(row);
					continue;
				}
				frontier.set(row.sid, row.clock + row.span);
				changedActors.add(row.sid);
				promoted.add(row);
				changed = true;
			}
			pending = blocked;
		} while (changed);

		const freshRows = new Set(fresh);
		for (const row of fresh) store.put(pack(row, promoted.has(row)));
		for (const row of promoted)
			if (!freshRows.has(row)) store.put(pack(row, true));
		for (const sid of changedActors)
			clocks.put({
				docId,
				sid,
				clock: frontier.get(sid)!,
			} satisfies ClockRecord);
		return {
			inserted: fresh.length,
			ready: promoted.size,
			pending: pending.length,
		};
	}
}
