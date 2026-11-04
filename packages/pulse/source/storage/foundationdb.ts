import { array, object, tuple } from "@gin-quin/codec";
import { wireCodec } from "../protocol/wireCodec.js";
import { PulseError } from "../protocol/errors.js";
import { validateDocId } from "../protocol/validateDocId.js";
import { MAX_VECTOR_ENTRIES } from "../protocol/limits.js";
import {
	validateVector,
	type PulseVersionVector,
} from "../connection/PulseVersionVector.js";
import {
	assertCompatible,
	covered,
	rowsFromFrame,
	sameRow,
	validateRows,
	type AppendResult,
	type PatchStore,
	type StoredPatchRow,
} from "./rows.js";

export interface OrderedKeyValueTransaction {
	get(key: Uint8Array): Promise<Uint8Array | undefined>;
	range(
		begin: Uint8Array,
		end: Uint8Array,
		options?: { limit?: number; reverse?: boolean },
	): Promise<Array<{ key: Uint8Array; value: Uint8Array }>>;
	set(key: Uint8Array, value: Uint8Array): void | Promise<void>;
	clear(key: Uint8Array): void | Promise<void>;
}
/** Adapter boundary: implementations must retry the whole callback on FDB conflicts. */
export interface OrderedKeyValueDatabase {
	transact<T>(work: (tx: OrderedKeyValueTransaction) => Promise<T>): Promise<T>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const chunkBytes = 64 * 1024; // FDB values are limited to 100 KiB; patches can reach 1 MiB.
const metadataCodec = wireCodec(
	object({
		docId: "string",
		sid: "uint",
		clock: "uint",
		span: "uint",
		dependencies: array(tuple("uint", "uint")),
		chunks: "uint",
	}),
);
type Metadata = ReturnType<typeof metadataCodec.decode>;
const hex = (value: number): string => value.toString(16).padStart(14, "0");
const bytesKey = (key: string): Uint8Array => encoder.encode(key);
function documentKey(docId: string): string {
	return [...encoder.encode(docId)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Ordered headers, separately chunked opaque payloads and transactional causal clocks. */
export class FoundationDBPatchStore implements PatchStore {
	private readonly namespace: string;
	constructor(
		private readonly db: OrderedKeyValueDatabase,
		namespace = "pulsify/",
	) {
		if (
			!namespace.length ||
			namespace.length > 128 ||
			!namespace.isWellFormed()
		)
			throw new Error("Invalid FoundationDB namespace");
		// Encode the entire namespace as one component: separators must never alias another store's keys.
		this.namespace = `${documentKey(namespace)}/`;
	}
	private prefix(kind: string, docId: string): string {
		return `${this.namespace}${kind}/${documentKey(docId)}/`;
	}
	private index(row: Pick<StoredPatchRow, "docId" | "sid" | "clock">): string {
		return `${this.prefix("i", row.docId)}${hex(row.sid)}/${hex(row.clock)}`;
	}
	private payload(
		row: Pick<StoredPatchRow, "docId" | "sid" | "clock">,
	): string {
		return `${this.prefix("p", row.docId)}${hex(row.sid)}/${hex(row.clock)}/`;
	}
	private async scan(
		tx: OrderedKeyValueTransaction,
		prefix: string,
	): Promise<Array<{ key: Uint8Array; value: Uint8Array }>> {
		return tx.range(bytesKey(prefix), bytesKey(`${prefix}\uffff`));
	}
	private async load(
		tx: OrderedKeyValueTransaction,
		header: Metadata,
	): Promise<StoredPatchRow> {
		const chunks = await this.scan(tx, this.payload(header));
		if (chunks.length !== header.chunks)
			throw new PulseError("INVALID_MESSAGE", "Incomplete stored payload");
		const operations = new Uint8Array(
			chunks.reduce((sum, item) => sum + item.value.length, 0),
		);
		let offset = 0;
		for (const chunk of chunks) {
			operations.set(chunk.value, offset);
			offset += chunk.value.length;
		}
		return {
			docId: header.docId,
			sid: header.sid,
			clock: header.clock,
			span: header.span,
			dependencies: header.dependencies,
			operations,
		};
	}
	private async clocks(
		tx: OrderedKeyValueTransaction,
		docId: string,
	): Promise<PulseVersionVector> {
		return (await this.scan(tx, this.prefix("c", docId))).map(
			({ key, value }) => [
				Number.parseInt(decoder.decode(key).split("/").at(-1)!, 16),
				Number(decoder.decode(value)),
			],
		);
	}
	async appendEncoded(frame: Uint8Array): Promise<AppendResult> {
		return this.append(rowsFromFrame(frame));
	}
	async append(rows: readonly StoredPatchRow[]): Promise<AppendResult> {
		const docId = validateRows(rows);
		if (docId === undefined) return { inserted: 0, ready: 0, pending: 0 };
		const prepared = rows.map((input) => {
			const row: StoredPatchRow = {
				docId: input.docId,
				sid: input.sid,
				clock: input.clock,
				span: input.span,
				dependencies: input.dependencies.map(([sid, clock]) => [sid, clock]),
				operations: new Uint8Array(input.operations),
			};
			const chunks = Math.ceil(row.operations.length / chunkBytes);
			const metadata = metadataCodec.encode({
				docId,
				sid: row.sid,
				clock: row.clock,
				span: row.span,
				dependencies: row.dependencies,
				chunks,
			});
			const keyBytes = encoder.encode(`${this.payload(row)}${hex(0)}`).length;
			// FDB counts mutation keys and both write-conflict boundaries. Allow additionally
			// for metadata/clock writes, neighbor reads, and the shared pending/clock scans.
			const budget =
				row.operations.length +
				metadata.length * 3 +
				keyBytes * (chunks * 3 + 32) +
				1024;
			return { row, metadata, budget };
		});
		// Reserve margin below FDB's 10 MiB limit. Pending repair fan-outs need a separate application bound.
		if (prepared.reduce((sum, item) => sum + item.budget, 0) > 8 * 1024 * 1024)
			throw new PulseError(
				"LIMIT_EXCEEDED",
				"FoundationDB batch exceeds transaction budget",
			);
		return this.db.transact(async (tx) => {
			let inserted = 0,
				ready = 0;
			for (const { row, metadata } of prepared) {
				const index = this.index(row),
					key = bytesKey(index);
				const existing = await tx.get(key);
				if (existing) {
					if (
						!sameRow(await this.load(tx, metadataCodec.decode(existing)), row)
					)
						throw new PulseError("CONFLICT", "Conflicting storage segment");
					continue;
				}
				const actorPrefix = `${this.prefix("i", docId)}${hex(row.sid)}/`;
				const neighbours = [
					...(await tx.range(bytesKey(actorPrefix), key, {
						limit: 1,
						reverse: true,
					})),
					...(await tx.range(
						bytesKey(`${index}\0`),
						bytesKey(`${actorPrefix}\uffff`),
						{ limit: 1 },
					)),
				];
				for (const neighbour of neighbours) {
					const metadata = metadataCodec.decode(neighbour.value);
					assertCompatible(row, { ...metadata, operations: new Uint8Array() });
				}
				await tx.set(key, metadata);
				await tx.set(
					bytesKey(
						`${this.prefix("d", docId)}${hex(row.sid)}/${hex(row.clock)}`,
					),
					metadata,
				);
				for (
					let offset = 0, part = 0;
					offset < row.operations.length;
					offset += chunkBytes, part++
				)
					await tx.set(
						bytesKey(`${this.payload(row)}${hex(part)}`),
						row.operations.subarray(offset, offset + chunkBytes),
					);
				inserted++;
			}
			const frontier = new Map(await this.clocks(tx, docId));
			let pending = (await this.scan(tx, this.prefix("d", docId))).map(
				(item) => ({
					key: item.key,
					bytes: item.value,
					metadata: metadataCodec.decode(item.value),
				}),
			);
			if (
				new Set([
					...frontier.keys(),
					...pending.map((item) => item.metadata.sid),
				]).size > MAX_VECTOR_ENTRIES
			)
				throw new PulseError("LIMIT_EXCEEDED", "Document actor limit exceeded");
			const changedActors = new Set<number>();
			let changed: boolean;
			do {
				changed = false;
				const waiting: typeof pending = [];
				for (const item of pending) {
					const row = item.metadata;
					if (
						row.clock !== (frontier.get(row.sid) ?? 1) ||
						!covered(frontier, row.dependencies)
					) {
						waiting.push(item);
						continue;
					}
					const clock = Math.max(
						frontier.get(row.sid) ?? 0,
						row.clock + row.span,
					);
					frontier.set(row.sid, clock);
					changedActors.add(row.sid);
					// Index by exclusive end: directly seek beyond the remote frontier, even inside a span.
					await tx.set(
						bytesKey(
							`${this.prefix("o", docId)}${hex(row.sid)}/${hex(row.clock + row.span)}`,
						),
						item.bytes,
					);
					await tx.clear(item.key);
					ready++;
					changed = true;
				}
				pending = waiting;
			} while (changed);
			// Same grouped-clock optimization as PostgreSQL; no independent FDB tuning campaign.
			for (const sid of changedActors)
				await tx.set(
					bytesKey(`${this.prefix("c", docId)}${hex(sid)}`),
					encoder.encode(String(frontier.get(sid)!)),
				);
			return { inserted, ready, pending: pending.length };
		});
	}
	async vector(docId: string): Promise<PulseVersionVector> {
		validateDocId(docId);
		return this.db.transact((tx) => this.clocks(tx, docId));
	}
	async missing(
		docId: string,
		remote: PulseVersionVector,
	): Promise<StoredPatchRow[]> {
		validateDocId(docId);
		validateVector(remote);
		return this.db.transact(async (tx) => {
			const clocks = new Map(remote),
				rows: StoredPatchRow[] = [];
			for (const [sid] of await this.clocks(tx, docId)) {
				const prefix = `${this.prefix("o", docId)}${hex(sid)}/`;
				const missing = await tx.range(
					bytesKey(`${prefix}${hex(clocks.get(sid) ?? 0)}\0`),
					bytesKey(`${prefix}\uffff`),
				);
				for (const item of missing)
					rows.push(await this.load(tx, metadataCodec.decode(item.value)));
			}
			return rows;
		});
	}
}
