import {
	PulseError,
	validateVector,
	type PulseVersionVector,
} from "pulsify-core/protocol";
import {
	GAP_OPERATIONS,
	isGap,
	lastRegisterOf,
	coversDocument,
	documentPrefixes,
	type AppendResult,
	type DocumentStore,
	type MissingPage,
	type MissingPageOptions,
	type StoredPatchRow,
} from "pulsify-core/storage";
import {
	covered,
	MAX_MESSAGE_ROWS,
	MAX_PATCH_BYTES,
	MAX_ROW_BATCH_NODES,
	MAX_VECTOR_ENTRIES,
	rowsFromFrame,
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
/**
 * An actor's newest write to a register without history, overwritten in
 * place: `[docId, sid, register]` is the primary key.
 */
type ValueRecord = {
	docId: string;
	sid: number;
	register: string;
	clock: number;
	dependencies: PulseVersionVector;
	operations: Uint8Array;
};

type IndexedDbMissingCursor = {
	sid: number;
	from: number;
	straddle: boolean;
	vv: PulseVersionVector;
};
const MISSING_SCAN_BATCH = 128;

// Version 3 adds the values. Version 2 was never released: its `registers`
// store is dropped, and its rows stay as history rows. Version 5 indexes the
// values by clock.
const VERSION = 5;
const TOMBSTONES = "tombstones";
const ROWS = "rows";
const CLOCKS = "clocks";
const VALUES = "values";
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, i) => b[i] === byte);
/** Register bytes as a key every IndexedDB implementation orders the same. */
const registerKey = (register: Uint8Array): string =>
	String.fromCharCode(...register);
/** `[docId, sid, clock]` of the values: an actor's values in clock order. */
const VALUES_BY_CLOCK = "clock";
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
const unpackValue = (record: ValueRecord): StoredPatchRow => ({
	docId: record.docId,
	sid: record.sid,
	clock: record.clock,
	span: 1,
	dependencies: record.dependencies,
	operations: record.operations,
});
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
export class IndexedDbPatchStore implements DocumentStore {
	readonly name: string;
	private opening: Promise<IDBDatabase> | undefined;
	/** The open connection, until it is lost or the store is closed. */
	private connection: IDBDatabase | undefined;
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
		this.connection = undefined;
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
		return this.transaction(
			"readwrite",
			async (rows_, clocks, values, tombstones) => {
				await this.assertLive(tombstones, docId);
				return this.write(rows_, clocks, values, docId, rows);
			},
		);
	}
	async vector(docId: string): Promise<PulseVersionVector> {
		validateDocId(docId);
		return this.transaction(
			"readonly",
			async (_, clocks, _values, tombstones) => {
				await this.assertLive(tombstones, docId);
				return this.readVector(clocks, docId);
			},
		);
	}
	private async readMissingPage(
		docId: string,
		remote: PulseVersionVector,
		{
			after,
			maxBytes = 2 * MAX_PATCH_BYTES,
			maxRows = MAX_MESSAGE_ROWS,
			maxNodes = MAX_ROW_BATCH_NODES,
		}: MissingPageOptions,
		recovery = false,
	): Promise<MissingPage> {
		validateDocId(docId);
		validateVector(remote);
		const cursor = after as IndexedDbMissingCursor | undefined;
		const peer = new Map(remote);
		return this.transaction(
			"readonly",
			async (rows, clocks, values, tombstones): Promise<MissingPage> => {
				if (!recovery) await this.assertLive(tombstones, docId);
				const liveVv = await this.readVector(clocks, docId);
				const vv: PulseVersionVector = cursor
					? [
							...cursor.vv.filter(([sid]) => sid < cursor.sid),
							...liveVv.filter(([sid]) => sid >= cursor.sid),
						]
					: liveVv;
				const behind = liveVv.filter(
					([sid, clock]) =>
						(!cursor || sid >= cursor.sid) && clock > (peer.get(sid) ?? 0),
				);
				if (!behind.length) return { rows: [], vv, next: undefined };
				const keys = this.keys;
				const page: StoredPatchRow[] = [];
				let pageBytes = 0;
				let pageNodes = 0;
				const tryEmit = (row: StoredPatchRow): boolean => {
					if (row.operations.length > MAX_PATCH_BYTES)
						throw new PulseError(
							"LIMIT_EXCEEDED",
							"Patch payload exceeds 1 MiB",
						);
					const size =
						row.operations.length +
						row.dependencies.length * 16 +
						docId.length * 4 +
						64;
					const rowNodes = 7 + 3 * row.dependencies.length;
					if (
						page.length &&
						(pageBytes + size > maxBytes ||
							page.length >= maxRows ||
							pageNodes + rowNodes > maxNodes)
					)
						return false;
					page.push(row);
					pageBytes += size;
					pageNodes += rowNodes;
					return true;
				};
				for (const [sid, frontier] of behind) {
					const resuming = cursor !== undefined && sid === cursor.sid;
					const from = resuming ? cursor.from : Math.max(peer.get(sid) ?? 0, 1);
					const straddle = resuming ? cursor.straddle : true;
					if (from >= frontier) continue;
					/**
					 * Reads `source`, keyed by `[docId, sid, clock]`, in clock order
					 * from `start` up to the frontier, one bounded batch at a time.
					 */
					const scan = <R extends { clock: number }>(
						source: IDBObjectStore | IDBIndex,
						start: number,
						keep: (record: R) => StoredPatchRow | undefined,
					) => {
						let position = start;
						// An empty open range is a DataError in IndexedDB, not an empty result.
						let done = position >= frontier;
						let queue: StoredPatchRow[] = [];
						let index = 0;
						return {
							async peek(): Promise<StoredPatchRow | undefined> {
								while (index >= queue.length && !done) {
									const batch = await request<R[]>(
										source.getAll(
											keys.bound(
												[docId, sid, position],
												[docId, sid, frontier],
												false,
												true,
											),
											MISSING_SCAN_BATCH,
										),
									);
									done = batch.length < MISSING_SCAN_BATCH;
									if (batch.length) position = batch.at(-1)!.clock + 1;
									if (position >= frontier) done = true;
									queue = [];
									index = 0;
									for (const record of batch) {
										const row = keep(record);
										if (row) queue.push(row);
									}
								}
								return queue[index];
							},
							take: (): StoredPatchRow => queue[index++]!,
						};
					};
					// With a straddle, each scan starts at its last record at or before `from`.
					const anchor = async (
						source: IDBObjectStore | IDBIndex,
					): Promise<number> => {
						if (!straddle || from <= 1) return from;
						const found = await request(
							source.openKeyCursor(
								keys.bound([docId, sid], [docId, sid, from]),
								"prev",
							),
						);
						return found ? (found.key as [string, number, number])[2] : from;
					};
					const byClock = values.index(VALUES_BY_CLOCK);
					const [opStart, valStart] = await Promise.all([
						anchor(rows),
						anchor(byClock),
					]);
					const ops = scan<RowRecord>(rows, opStart, (record) =>
						record.ready &&
						(straddle || record.clock >= from) &&
						!isGap(record.operations)
							? unpack(record)
							: undefined,
					);
					const vals = scan<ValueRecord>(byClock, valStart, (record) =>
						isGap(record.operations) ? undefined : unpackValue(record),
					);
					const takeHeld = async (): Promise<StoredPatchRow | undefined> => {
						const op = await ops.peek();
						const val = await vals.peek();
						if (!op && !val) return undefined;
						return op && (!val || op.clock <= val.clock)
							? ops.take()
							: vals.take();
					};
					let curr = await takeHeld();
					let next = curr ? await takeHeld() : undefined;
					if (straddle) {
						while (curr && next && next.clock <= from) {
							curr = next;
							next = await takeHeld();
						}
					}
					if (!curr || curr.clock > from) {
						const gapEnd = curr ? curr.clock : frontier;
						if (gapEnd > from) {
							const gap: StoredPatchRow = {
								docId,
								sid,
								clock: from,
								span: gapEnd - from,
								dependencies: from > 1 ? [[sid, from]] : [],
								operations: GAP_OPERATIONS.slice(),
							};
							if (!tryEmit(gap))
								return {
									rows: page,
									vv,
									next: {
										sid,
										from,
										straddle: false,
										vv,
									} satisfies IndexedDbMissingCursor,
								};
						}
					}
					while (curr) {
						const span = (next ? next.clock : frontier) - curr.clock;
						const isStraddling = straddle && curr.clock < from;
						if (!tryEmit({ ...curr, span }))
							return {
								rows: page,
								vv,
								next: {
									sid,
									from: isStraddling ? from : curr.clock,
									straddle: isStraddling,
									vv,
								} satisfies IndexedDbMissingCursor,
							};
						curr = next;
						next = curr ? await takeHeld() : undefined;
					}
				}
				return { rows: page, vv, next: undefined };
			},
		);
	}
	async missing(
		docId: string,
		remote: PulseVersionVector,
	): Promise<StoredPatchRow[]> {
		return (
			await this.readMissingPage(
				docId,
				remote,
				{ maxBytes: Infinity, maxRows: Infinity, maxNodes: Infinity },
				false,
			)
		).rows;
	}
	async missingPage(
		docId: string,
		remote: PulseVersionVector,
		options: MissingPageOptions = {},
	): Promise<MissingPage> {
		return this.readMissingPage(docId, remote, options, false);
	}
	async recoverRows(docId: string): Promise<StoredPatchRow[]> {
		return (
			await this.readMissingPage(
				docId,
				[],
				{ maxBytes: Infinity, maxRows: Infinity, maxNodes: Infinity },
				true,
			)
		).rows;
	}
	private async deleted(
		store: IDBObjectStore,
		docId: string,
	): Promise<boolean> {
		const found = await Promise.all(
			documentPrefixes(docId).map((prefix) => request(store.get(prefix))),
		);
		return found.some((value) => value !== undefined);
	}
	private async assertLive(
		store: IDBObjectStore,
		docId: string,
	): Promise<void> {
		if (await this.deleted(store, docId))
			throw new PulseError(
				"NOT_FOUND",
				`Document ${docId} was permanently deleted`,
			);
	}
	async isDeleted(docId: string): Promise<boolean> {
		return this.transaction("readonly", async (_r, _c, _v, tombstones) =>
			this.deleted(tombstones, docId),
		);
	}
	/**
	 * Permanently block a subtree, retaining local operations for explicit recovery.
	 * Calls `onDeleted(newlyDeleted)` once the deletion marker is committed, even if
	 * retaining recovery rows fails.
	 */
	async markDeleted(
		docId: string,
		recovery: readonly StoredPatchRow[] = [],
		onDeleted?: (newlyDeleted: boolean) => void,
	): Promise<void> {
		validateDocId(docId);
		let newlyDeleted: boolean | undefined;
		try {
			const groups = new Map<string, StoredPatchRow[]>();
			for (const row of recovery) {
				if (!coversDocument(docId, row.docId))
					throw new PulseError(
						"INVALID_MESSAGE",
						"Recovery row outside deleted subtree",
					);
				const group = groups.get(row.docId) ?? [];
				group.push(row);
				groups.set(row.docId, group);
			}
			for (const rows of groups.values())
				for (let i = 0; i < rows.length; i += 4096)
					validateRows(rows.slice(i, i + 4096));
			newlyDeleted = await this.transaction(
				"readwrite",
				async (rows, clocks, values, tombstones) => {
					for (const [id, batch] of groups)
						await this.write(rows, clocks, values, id, batch);
					return this.putTombstone(tombstones, docId);
				},
			);
			onDeleted?.(newlyDeleted);
		} catch (error) {
			if (newlyDeleted === undefined) {
				try {
					const created = await this.transaction(
						"readwrite",
						async (_rows, _clocks, _values, tombstones) =>
							this.putTombstone(tombstones, docId),
					);
					onDeleted?.(created);
				} catch {
					// Database unavailable; rethrow the original error.
				}
			}
			throw error;
		}
	}
	private async putTombstone(
		tombstones: IDBObjectStore,
		docId: string,
	): Promise<boolean> {
		if (await this.deleted(tombstones, docId)) return false;
		tombstones.delete(this.keys.bound(`${docId}/`, `${docId}0`, false, true));
		tombstones.put(true, docId);
		return true;
	}
	async deleteDocuments(
		docId: string,
		options: { preserveRows?: boolean } = {},
	): Promise<number> {
		validateDocId(docId);
		return this.transaction(
			"readwrite",
			async (rows, clocks, values, tombstones) => {
				await this.putTombstone(tombstones, docId);
				if (options.preserveRows) return 0;
				const ranges = [
					this.documentRange(docId),
					this.keys.bound([`${docId}/`], [`${docId}0`], false, true),
				];
				const ids = new Set<string>();
				for (const range of ranges) {
					for (const store of [rows, values])
						for (const key of await request(store.getAllKeys(range)))
							ids.add((key as [string])[0]);
					rows.delete(range);
					clocks.delete(range);
					values.delete(range);
				}
				return ids.size;
			},
		);
	}
	async documents(docId: string, after = "", limit = 256): Promise<string[]> {
		validateDocId(docId);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
			throw new RangeError("Invalid document limit");
		return this.transaction("readonly", async (_r, clocks, _v, tombstones) => {
			await this.assertLive(tombstones, docId);
			const result: string[] = [];
			if (
				docId > after &&
				(await request(clocks.getKey(this.documentRange(docId)))) !== undefined
			)
				result.push(docId);
			const lower = `${docId}/`,
				upper = `${docId}0`;
			if (result.length === limit || after >= upper) return result;
			return new Promise<string[]>((resolve, reject) => {
				const request = clocks.openKeyCursor(
					this.keys.bound(
						after >= lower ? [after, []] : [lower],
						[upper],
						false,
						true,
					),
				);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) {
						resolve(result);
						return;
					}
					const id = (cursor.key as [string])[0];
					const next = () => cursor.continue([id, []]);
					this.deleted(tombstones, id).then((deleted) => {
						if (!deleted) result.push(id);
						if (result.length === limit) resolve(result);
						else next();
					}, reject);
				};
			});
		});
	}

	/** Deletes every stored row of one document. */
	async forget(docId: string): Promise<void> {
		validateDocId(docId);
		await this.transaction("readwrite", async (rows, clocks, values) => {
			const range = this.documentRange(docId);
			rows.delete(range);
			clocks.delete(range);
			values.delete(range);
		});
	}
	/** Erases cached/recovery rows; permanent deletion markers remain. */
	async clear(): Promise<void> {
		await this.transaction("readwrite", async (rows, clocks, values) => {
			rows.clear();
			clocks.clear();
			values.clear();
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
				if (!db.objectStoreNames.contains(TOMBSTONES))
					db.createObjectStore(TOMBSTONES);
				if (!db.objectStoreNames.contains(ROWS))
					db.createObjectStore(ROWS, {
						keyPath: ["docId", "sid", "clock"],
					}).createIndex(BY_STATE, ["docId", "ready", "sid", "end"]);
				if (!db.objectStoreNames.contains(CLOCKS))
					db.createObjectStore(CLOCKS, { keyPath: ["docId", "sid"] });
				if (db.objectStoreNames.contains("registers"))
					db.deleteObjectStore("registers");
				const valueStore = db.objectStoreNames.contains(VALUES)
					? open.transaction!.objectStore(VALUES)
					: db.createObjectStore(VALUES, {
							keyPath: ["docId", "sid", "register"],
						});
				// Built from the values a version 3 or 4 database already holds.
				if (!valueStore.indexNames.contains(VALUES_BY_CLOCK))
					valueStore.createIndex(VALUES_BY_CLOCK, ["docId", "sid", "clock"]);
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
				this.connection = db;
				db.onversionchange = () =>
					this.lose(db, "IndexedDB upgraded elsewhere");
				db.onclose = () => this.lose(db, "IndexedDB connection lost");
				resolve(db);
			};
		});
	}
	/** Drops a dead connection so the next call reopens, and fails its sessions. */
	private lose(db: IDBDatabase, reason: string): void {
		if (this.connection !== db) return;
		this.connection = undefined;
		this.opening = undefined;
		db.close();
		const error = new PulseError("CONNECTION_FAILED", reason);
		for (const listener of [...this.lost]) listener(error);
	}
	/**
	 * Some browsers (WebKit) lose the connection without a `close` event: it
	 * then surfaces as an `InvalidStateError` or `UnknownError` on transactions.
	 */
	private checkLost(db: IDBDatabase, error: unknown): void {
		const name = (error as { name?: unknown } | null)?.name;
		if (name === "InvalidStateError" || name === "UnknownError")
			this.lose(db, "IndexedDB connection lost");
	}
	/** Runs `work` in one transaction and resolves once it has committed. */
	private async transaction<T>(
		mode: IDBTransactionMode,
		work: (
			rows: IDBObjectStore,
			clocks: IDBObjectStore,
			values: IDBObjectStore,
			tombstones: IDBObjectStore,
		) => Promise<T>,
	): Promise<T> {
		const db = await this.database();
		return new Promise<T>((resolve, reject) => {
			let tx: IDBTransaction;
			try {
				tx = db.transaction(
					[ROWS, CLOCKS, VALUES, TOMBSTONES],
					mode,
					this.options.durability
						? { durability: this.options.durability }
						: undefined,
				);
			} catch (error) {
				this.checkLost(db, error);
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
			tx.onabort = () => {
				this.checkLost(db, tx.error);
				reject(storageError(failure ?? tx.error ?? "Transaction aborted"));
			};
			work(
				tx.objectStore(ROWS),
				tx.objectStore(CLOCKS),
				tx.objectStore(VALUES),
				tx.objectStore(TOMBSTONES),
			).then(
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
	/**
	 * The `SqlitePatchStore.append` rules, one request after the other: a read
	 * in a transaction sees the writes made before it.
	 */
	private async write(
		store: IDBObjectStore,
		clocks: IDBObjectStore,
		values: IDBObjectStore,
		docId: string,
		rows: readonly StoredPatchRow[],
	): Promise<AppendResult> {
		const keys = this.keys;
		const [frontierVector, waitingRecords] = await Promise.all([
			this.readVector(clocks, docId),
			request<RowRecord[]>(
				store.index(BY_STATE).getAll(keys.bound([docId, 0], [docId, 0, []])),
			),
		]);
		const frontier = new Map(frontierVector);
		let waiting = waitingRecords.map(unpack);
		const changedActors = new Set<number>();
		let inserted = 0,
			ready = 0;

		const get = (sid: number, clock: number) =>
			request<RowRecord | undefined>(store.get([docId, sid, clock]));
		/** The stored row of an actor that starts last before a sequence number. */
		const before = async (sid: number, clock: number) =>
			(
				await request(
					store.openCursor(
						keys.bound([docId, sid], [docId, sid, clock], false, true),
						"prev",
					),
				)
			)?.value as RowRecord | undefined;
		const after = async (sid: number, clock: number) =>
			(
				await request(
					store.openCursor(
						keys.bound([docId, sid, clock], [docId, sid, []], true),
					),
				)
			)?.value as RowRecord | undefined;
		/** Drop the waiting rows of an actor that start in `[from, to)`: replaced. */
		const dropWaiting = (sid: number, from: number, to: number) => {
			if (from >= to) return;
			store.delete(
				keys.bound([docId, sid, from], [docId, sid, to], false, true),
			);
			waiting = waiting.filter(
				(row) => row.sid !== sid || row.clock < from || row.clock >= to,
			);
		};
		/** Where each value of an actor is, read once for rows sent again. */
		const valuesOf = new Map<number, Map<number, Uint8Array>>();
		/** The operations held at this sequence number: a row, or a value. */
		const heldAt = async (sid: number, clock: number) => {
			const row = await get(sid, clock);
			if (row) return row.operations;
			let clocks = valuesOf.get(sid);
			if (!clocks) {
				const records = await request<ValueRecord[]>(
					values.getAll(keys.bound([docId, sid], [docId, sid, []])),
				);
				clocks = new Map(
					records.map((value) => [value.clock, value.operations]),
				);
				valuesOf.set(sid, clocks);
			}
			return clocks.get(clock);
		};
		/**
		 * Store a ready row: a last-value row as its actor's value of the
		 * register, replacing the older one; a gap row not at all, as the
		 * frontier says how far the actor goes. Whether it stays a row.
		 */
		const keep = (row: StoredPatchRow): boolean => {
			const last = lastRegisterOf(row.operations);
			if (last) {
				const { operations } = pack(row, true);
				values.put({
					docId,
					sid: row.sid,
					register: registerKey(last.register),
					clock: row.clock,
					dependencies: row.dependencies.map(([sid, clock]) => [sid, clock]),
					operations,
				} satisfies ValueRecord);
				valuesOf.delete(row.sid);
			}
			return !last && !isGap(row.operations);
		};

		for (const row of rows) {
			const reached = frontier.get(row.sid) ?? 1,
				end = row.clock + row.span;
			if (row.clock < reached) {
				// Known, or replaced here: only its contents can conflict, and only
				// its span can say that more writes were replaced.
				const held = await heldAt(row.sid, row.clock);
				if (
					held &&
					!isGap(held) &&
					!isGap(row.operations) &&
					!sameBytes(held, row.operations)
				)
					throw new PulseError("CONFLICT", "Conflicting storage segment");
				if (end <= reached) continue;
				dropWaiting(row.sid, reached, end);
				frontier.set(row.sid, end);
				changedActors.add(row.sid);
				inserted++;
				continue;
			}
			const readyNow =
				row.clock === reached && covered(frontier, row.dependencies);
			const own = new Map(row.dependencies).get(row.sid) ?? 0;
			if (readyNow && !waiting.some((each) => each.sid === row.sid)) {
				// Ready rows start below the frontier and none waits: no stored row
				// starts at or after this one. Only the fork check remains.
				if (row.clock > 1 && own < row.clock)
					throw new PulseError("CONFLICT", "Actor history fork");
			} else {
				const existing = await get(row.sid, row.clock);
				if (existing) {
					// A waiting row with the same start: only contents conflict.
					if (
						!isGap(existing.operations) &&
						!isGap(row.operations) &&
						!sameBytes(existing.operations, row.operations)
					)
						throw new PulseError("CONFLICT", "Conflicting storage segment");
					// The longer span knows of more replaced writes.
					if (row.span > existing.span) {
						store.put({ ...existing, span: row.span, end } satisfies RowRecord);
						// The waiting rows it now covers were replaced.
						dropWaiting(row.sid, row.clock + 1, end);
						for (const each of waiting)
							if (each.sid === row.sid && each.clock === row.clock)
								each.span = row.span;
					}
					continue;
				}
				const previous = await before(row.sid, row.clock);
				if (previous) {
					// It starts among the writes a waiting row has replaced.
					if (previous.end > row.clock) continue;
					if (own < previous.end)
						throw new PulseError("CONFLICT", "Actor history fork");
				}
				const next = await after(row.sid, end - 1);
				if (next && (new Map(next.dependencies).get(row.sid) ?? 0) < end)
					throw new PulseError("CONFLICT", "Actor history fork");
				// Rows still waiting that this row has replaced.
				dropWaiting(row.sid, row.clock + 1, end);
			}
			inserted++;
			if (readyNow) {
				if (keep(row)) store.put(pack(row, true));
				frontier.set(row.sid, end);
				changedActors.add(row.sid);
				ready++;
			} else {
				store.put(pack(row, false));
				waiting.push(pack(row, false));
			}
		}
		if (
			new Set([...frontier.keys(), ...waiting.map((row) => row.sid)]).size >
			MAX_VECTOR_ENTRIES
		)
			throw new PulseError("LIMIT_EXCEEDED", "Document actor limit exceeded");

		waiting.sort((a, b) => a.sid - b.sid || a.clock - b.clock);
		let changed: boolean;
		do {
			changed = false;
			const blocked: StoredPatchRow[] = [];
			for (const row of waiting) {
				if (
					row.clock !== (frontier.get(row.sid) ?? 1) ||
					!covered(frontier, row.dependencies)
				) {
					blocked.push(row);
					continue;
				}
				if (keep(row)) store.put(pack(row, true));
				else store.delete([docId, row.sid, row.clock]);
				frontier.set(row.sid, row.clock + row.span);
				changedActors.add(row.sid);
				ready++;
				changed = true;
			}
			waiting = blocked;
		} while (changed);

		for (const sid of changedActors)
			clocks.put({
				docId,
				sid,
				clock: frontier.get(sid)!,
			} satisfies ClockRecord);
		const vector: PulseVersionVector = [...frontier].sort(
			(a, b) => a[0] - b[0],
		);
		return { inserted, ready, pending: waiting.length, vector };
	}
}
