import type { PulsePatchRow } from "../connection/PulsePatch.js";
import type { Patch } from "json-joy/lib/json-crdt-patch/Patch.js";
import {
	mergeVectors,
	validateVector,
	vectorCovers,
	type PulseVersionVector,
} from "../connection/PulseVersionVector.js";
import { PulseError } from "./errors.js";
import { MAX_PATCH_BYTES } from "./chunkRows.js";

export const MAX_LOG_ROWS = 100_000;
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
const key = (row: PulsePatchRow) => `${row.sid}:${row.clock}`;
const end = (row: PulsePatchRow) => row.clock + row.span;
const same = (a: PulsePatchRow, b: PulsePatchRow) =>
	a.span === b.span &&
	JSON.stringify(a.dependencies) === JSON.stringify(b.dependencies) &&
	a.operations.length === b.operations.length &&
	a.operations.every((byte, i) => b.operations[i] === byte);
function copyRow(row: PulsePatchRow, lazy = false): PulsePatchRow {
	const metadata = {
		docId: row.docId,
		sid: row.sid,
		clock: row.clock,
		span: row.span,
		dependencies: row.dependencies.map(([sid, clock]): [number, number] => [
			sid,
			clock,
		]),
	};
	return lazy
		? {
				...metadata,
				get operations() {
					return row.operations.slice();
				},
			}
		: { ...metadata, operations: row.operations.slice() };
}
function lowerBound(rows: PulsePatchRow[], clock: number): number {
	let lo = 0;
	let hi = rows.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (rows[mid]!.clock < clock) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Immutable segments with explicit causal dependencies, including Lamport jumps. */
export class PatchLog {
	private readonly rows = new Map<string, PulsePatchRow>();
	private readonly byActor = new Map<number, PulsePatchRow[]>();
	private readonly pending = new Map<string, PulsePatchRow>();
	private frontier: PulseVersionVector = [];
	private bytes = 0;
	private encodedLocalBytes = 0;
	constructor(public readonly docId: string) {}
	get vector(): PulseVersionVector {
		return this.frontier.map(([sid, time]) => [sid, time]);
	}
	get size(): number {
		return this.rows.size;
	}
	get pendingCount(): number {
		return this.pending.size;
	}

	/** Returns only newly causally available rows, in application order. */
	append(
		incoming: readonly PulsePatchRow[],
		beforeCommit?: (ready: PulsePatchRow[]) => void,
	): PulsePatchRow[] {
		return this.insert(incoming, beforeCommit, false);
	}

	/** Takes ownership of an internal patch; serialize only when wire rows are requested. */
	appendPatch(
		patch: Patch,
		toWire: (
			docId: string,
			patch: Patch,
			dependencies: PulseVersionVector,
		) => PulsePatchRow,
		beforeCommit?: (ready: PulsePatchRow[]) => void,
	): PulsePatchRow[] {
		const id = patch.getId();
		if (!id) return [];
		let encodedBytes = 0;
		let committed = false;
		const log = this;
		const row: PulsePatchRow = {
			docId: this.docId,
			sid: id.sid,
			clock: id.time,
			span: patch.span(),
			dependencies: this.vector,
			get operations() {
				const bytes = toWire(row.docId, patch, row.dependencies).operations;
				if (!bytes.length || bytes.length > MAX_PATCH_BYTES)
					throw new PulseError("LIMIT_EXCEEDED", "Invalid encoded patch size");
				if (log.bytes + log.encodedLocalBytes + bytes.length > MAX_LOG_BYTES)
					throw new PulseError(
						"LIMIT_EXCEEDED",
						"Document history limit exceeded",
					);
				if (committed) log.encodedLocalBytes += bytes.length;
				encodedBytes = bytes.length;
				// Replacing the getter caches the bytes and releases the native patch closure.
				Object.defineProperty(row, "operations", {
					value: bytes,
					enumerable: true,
				});
				return bytes;
			},
		};
		const ready = this.insert([row], beforeCommit, true, () => encodedBytes);
		committed = true;
		this.encodedLocalBytes += encodedBytes;
		return ready;
	}

	private insert(
		incoming: readonly PulsePatchRow[],
		beforeCommit: ((ready: PulsePatchRow[]) => void) | undefined,
		local: boolean,
		pendingBytes?: () => number,
	): PulsePatchRow[] {
		const fresh: PulsePatchRow[] = [];
		const staged = new Map<string, PulsePatchRow>();
		const stagedActors = new Map<number, PulsePatchRow[]>();
		let bytes = this.bytes;
		for (const row of incoming) {
			if (!local && row.operations.length > MAX_PATCH_BYTES)
				throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
			validateVector(row.dependencies);
			if (
				row.docId !== this.docId ||
				row.sid < 65536 ||
				!Number.isSafeInteger(row.sid) ||
				row.clock < 1 ||
				!Number.isSafeInteger(row.clock) ||
				row.span < 1 ||
				!Number.isSafeInteger(end(row)) ||
				(!local && !row.operations.length)
			)
				throw new PulseError("INVALID_MESSAGE", "Invalid patch segment");
			if ((new Map(row.dependencies).get(row.sid) ?? 0) > row.clock)
				throw new PulseError("INVALID_MESSAGE", "Invalid predecessor");
			const existing = staged.get(key(row)) ?? this.rows.get(key(row));
			if (existing) {
				if (local)
					throw new PulseError("CONFLICT", "Local patch ID already exists");
				if (!same(existing, row))
					throw new PulseError(
						"CONFLICT",
						"Conflicting segment for the same operation ID",
					);
				continue;
			}
			for (const actorRows of [
				this.byActor.get(row.sid),
				stagedActors.get(row.sid),
			]) {
				if (!actorRows) continue;
				const i = lowerBound(actorRows, row.clock);
				for (const other of [actorRows[i - 1], actorRows[i]]) {
					if (!other) continue;
					if (row.clock < end(other) && other.clock < end(row))
						throw new PulseError("CONFLICT", "Overlapping immutable segments");
					const previous = row.clock > other.clock ? other : row;
					const next = previous === row ? other : row;
					if ((new Map(next.dependencies).get(row.sid) ?? 0) < end(previous))
						throw new PulseError("CONFLICT", "Actor history fork");
				}
			}
			const copy = local ? row : copyRow(row);
			staged.set(key(copy), copy);
			let actor = stagedActors.get(copy.sid);
			if (!actor) {
				actor = [];
				stagedActors.set(copy.sid, actor);
			}
			actor.splice(lowerBound(actor, copy.clock), 0, copy);
			bytes +=
				(local ? 0 : copy.operations.length) +
				copy.dependencies.length * 16 +
				copy.docId.length * 2 +
				40;
		}
		if (
			this.rows.size + staged.size > MAX_LOG_ROWS ||
			bytes + this.encodedLocalBytes > MAX_LOG_BYTES
		)
			throw new PulseError("LIMIT_EXCEEDED", "Document history limit exceeded");
		const pending = new Map(this.pending);
		let frontier = this.frontier;
		for (const [id, row] of staged) pending.set(id, row);
		let changed: boolean;
		do {
			changed = false;
			for (const [id, row] of pending) {
				if (!vectorCovers(frontier, row.dependencies)) continue;
				frontier = mergeVectors(frontier, [[row.sid, end(row)]]);
				pending.delete(id);
				fresh.push(row);
				changed = true;
			}
		} while (changed);
		beforeCommit?.(fresh);
		if (
			bytes + this.encodedLocalBytes + (pendingBytes?.() ?? 0) >
			MAX_LOG_BYTES
		)
			throw new PulseError("LIMIT_EXCEEDED", "Document history limit exceeded");
		for (const [id, row] of staged) {
			this.rows.set(id, row);
			let actor = this.byActor.get(row.sid);
			if (!actor) {
				actor = [];
				this.byActor.set(row.sid, actor);
			}
			actor.splice(lowerBound(actor, row.clock), 0, row);
		}
		this.pending.clear();
		for (const [id, row] of pending) this.pending.set(id, row);
		this.frontier = frontier;
		this.bytes = bytes;
		return fresh.map((row) => copyRow(row, local));
	}

	missing(vv: PulseVersionVector): PulsePatchRow[] {
		validateVector(vv);
		const clocks = new Map(vv);
		const result: PulsePatchRow[] = [];
		for (const [sid, rows] of this.byActor) {
			const clock = clocks.get(sid) ?? 0;
			let i = lowerBound(rows, clock);
			if (i && end(rows[i - 1]!) > clock) i--;
			for (; i < rows.length; i++) result.push(copyRow(rows[i]!));
		}
		return result;
	}
}
