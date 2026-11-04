import {
	clipState,
	sameStateHeader,
	stateLastRow,
	type StateDelta,
} from "./stateDeltas.js";
import { decodeCorePatch } from "../core/operations.js";
import {
	scalarEntryOf,
	scalarRunOf,
	sameRunDependencies,
} from "./scalarRuns.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import { ScalarPatch, type CorePatch as Patch } from "../core/operations.js";
import {
	MAX_VECTOR_ENTRIES,
	validateVector,
	type PulseVersionVector,
} from "../connection/PulseVersionVector.js";
import { PulseError } from "./errors.js";
import { MAX_PATCH_BYTES } from "./chunkRows.js";

export const MAX_LOG_ROWS = 100_000;
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
const key = (row: PulsePatchRow) => `${row.sid}:${row.clock}`;
const end = (row: PulsePatchRow) => row.clock + row.span;
function same(a: PulsePatchRow, b: PulsePatchRow): boolean {
	if (a.span !== b.span || a.dependencies.length !== b.dependencies.length)
		return false;
	for (let i = 0; i < a.dependencies.length; i++) {
		const left = a.dependencies[i]!,
			right = b.dependencies[i]!;
		if (left[0] !== right[0] || left[1] !== right[1]) return false;
	}
	const left = a.operations,
		right = b.operations;
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
	return true;
}
type ToWire = (
	docId: string,
	patch: Patch,
	dependencies: PulseVersionVector,
) => PulsePatchRow;
type ByteBudget = { metadata: number; encoded: number };

/** One shared accessor, rather than a getter closure allocated for every edit. */
class LocalPatchRow implements PulsePatchRow {
	private cached: Uint8Array | undefined;
	readonly nativePatch: ScalarPatch | undefined;
	private patch: Patch | undefined;
	private encode: ToWire | undefined;
	encodedBytes = 0;
	committed = false;
	constructor(
		public docId: string,
		public sid: number,
		public clock: number,
		public span: number,
		public dependencies: PulseVersionVector,
		patch: Patch,
		encode: ToWire,
		private readonly budget: ByteBudget,
	) {
		this.patch = patch;
		this.nativePatch = patch instanceof ScalarPatch ? patch : undefined;
		this.encode = encode;
	}
	get operations(): Uint8Array {
		if (this.cached) return this.cached;
		const bytes = new Uint8Array(
			this.encode!(this.docId, this.patch!, this.dependencies).operations,
		);
		if (!bytes.length || bytes.length > MAX_PATCH_BYTES)
			throw new PulseError("LIMIT_EXCEEDED", "Invalid encoded patch size");
		if (
			this.budget.metadata + this.budget.encoded + bytes.length >
			MAX_LOG_BYTES
		)
			throw new PulseError("LIMIT_EXCEEDED", "Document history limit exceeded");
		this.encodedBytes = bytes.length;
		if (this.committed) this.budget.encoded += bytes.length;
		this.cached = bytes;
		this.patch = undefined;
		this.encode = undefined;
		return bytes;
	}
}

function clockAt(vector: PulseVersionVector, sid: number): number {
	let lo = 0,
		hi = vector.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (vector[mid]![0] < sid) lo = mid + 1;
		else hi = mid;
	}
	return vector[lo]?.[0] === sid ? vector[lo]![1] : 0;
}
/** Existing snapshots are never mutated: locally retained patches can share them. */
function advance(
	vector: PulseVersionVector,
	sid: number,
	clock: number,
): PulseVersionVector {
	let lo = 0,
		hi = vector.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (vector[mid]![0] < sid) lo = mid + 1;
		else hi = mid;
	}
	const next = vector.slice();
	if (vector[lo]?.[0] === sid) next[lo] = [sid, Math.max(clock, next[lo]![1])];
	else {
		if (vector.length >= MAX_VECTOR_ENTRIES)
			throw new PulseError("INVALID_MESSAGE", "Invalid version vector");
		next.splice(lo, 0, [sid, clock]);
	}
	return next;
}
function covers(
	clocks: ReadonlyMap<number, number>,
	required: PulseVersionVector,
): boolean {
	for (const [sid, clock] of required)
		if ((clocks.get(sid) ?? 0) < clock) return false;
	return true;
}
function copyRow(
	row: PulsePatchRow,
	lazy = false,
	owned = false,
): PulsePatchRow {
	if (owned && scalarEntryOf(row)) return row;
	const dependencies = row.dependencies.map(
		([sid, clock]): [number, number] => [sid, clock],
	);
	return lazy
		? {
				docId: row.docId,
				sid: row.sid,
				clock: row.clock,
				span: row.span,
				dependencies,
				get operations() {
					return new Uint8Array(row.operations);
				},
			}
		: {
				docId: row.docId,
				sid: row.sid,
				clock: row.clock,
				span: row.span,
				dependencies,
				operations: new Uint8Array(row.operations),
			};
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

/** Immutable actor sequences with causal dependencies and contiguous frontiers. */
export class PatchLog {
	private rowCount = 0;
	private readonly byActor = new Map<number, PulsePatchRow[]>();
	private readonly pending = new Map<string, PulsePatchRow>();
	private frontier: PulseVersionVector = [];
	private readonly summaries: StateDelta[] = [];
	private readonly statesByActor = new Map<number, StateDelta[]>();
	private readonly nativeTails = new Map<
		number,
		{ first: LocalPatchRow; last: LocalPatchRow; external: PulseVersionVector }
	>();
	private historyCache: { count: number; vv: PulseVersionVector } | undefined;
	private readonly budget: ByteBudget = { metadata: 0, encoded: 0 };
	constructor(public readonly docId: string) {}
	get vector(): PulseVersionVector {
		return this.frontier.map(([sid, time]) => [sid, time]);
	}
	get size(): number {
		return this.rowCount;
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

	/** Takes ownership of an internal patch; wire output remains isolated. */
	appendPatch(
		patch: Patch,
		toWire: ToWire,
		beforeCommit?: (ready: PulsePatchRow[]) => void,
	): PulsePatchRow[] {
		return this.appendNative(patch, toWire, beforeCommit, false);
	}

	/**
	 * Internal runtime path. Returned rows and dependency snapshots are borrowed
	 * from the journal and must not be mutated or exposed to application code.
	 * The public appendPatch API continues returning independent metadata/bytes.
	 */
	appendLocalPatch(
		patch: Patch,
		toWire: ToWire,
		beforeCommit?: (ready: PulsePatchRow[]) => void,
	): PulsePatchRow[] {
		return this.appendNative(patch, toWire, beforeCommit, true);
	}

	/** Internal receive path: input is copied; returned rows are borrowed. */
	appendRemoteRows(
		incoming: readonly PulsePatchRow[],
		beforeCommit?: (ready: PulsePatchRow[]) => void,
	): PulsePatchRow[] {
		for (const row of incoming) this.assertStateHistory(row);
		if (!this.pending.size) {
			const ready =
				incoming.length === 1
					? this.appendSingleRemote(incoming[0]!, beforeCommit)
					: incoming.length > 1
						? this.appendActorBatch(incoming, beforeCommit)
						: undefined;
			if (ready !== undefined) return ready;
		}
		return this.insert(incoming, beforeCommit, false, undefined, true);
	}

	/** Ascending actor history can be checked once without building a work queue. */
	private appendActorBatch(
		incoming: readonly PulsePatchRow[],
		beforeCommit: ((ready: PulsePatchRow[]) => void) | undefined,
	): PulsePatchRow[] | undefined {
		const sid = incoming[0]!.sid;
		for (let i = 1; i < incoming.length; i++) {
			const row = incoming[i]!;
			if (row.sid !== sid || row.clock <= incoming[i - 1]!.clock)
				return undefined;
		}
		const actor = this.byActor.get(sid),
			previous = actor?.[actor.length - 1];
		let nextClock = clockAt(this.frontier, sid) || 1;
		let bytes = this.budget.metadata;
		const ready: PulsePatchRow[] = [];
		for (const row of incoming) {
			if (row.operations.length > MAX_PATCH_BYTES)
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
				!row.operations.length
			)
				throw new PulseError("INVALID_MESSAGE", "Invalid patch segment");
			const predecessor = clockAt(row.dependencies, sid);
			if (predecessor > row.clock)
				throw new PulseError("INVALID_MESSAGE", "Invalid predecessor");
			const existing = this.find(row.sid, row.clock);
			if (existing) {
				if (!same(existing, row))
					throw new PulseError(
						"CONFLICT",
						"Conflicting segment for the same operation ID",
					);
				continue;
			}
			if (row.clock !== nextClock) return undefined;
			if (nextClock > 1 && predecessor < nextClock)
				throw new PulseError("CONFLICT", "Actor history fork");
			for (const [actorId, clock] of row.dependencies) {
				const have =
					actorId === sid && (previous || ready.length)
						? nextClock
						: clockAt(this.frontier, actorId);
				if (have < clock) return undefined;
			}
			const copy = copyRow(row, false, true);
			ready.push(copy);
			bytes +=
				copy.operations.length +
				copy.dependencies.length * 16 +
				copy.docId.length * 2 +
				40;
			nextClock = end(copy);
		}
		if (
			this.rowCount + ready.length > MAX_LOG_ROWS ||
			bytes + this.budget.encoded > MAX_LOG_BYTES
		)
			throw new PulseError("LIMIT_EXCEEDED", "Document history limit exceeded");
		const next = ready.length
			? advance(this.frontier, sid, nextClock)
			: this.frontier;
		if (beforeCommit) beforeCommit(ready);
		if (ready.length) {
			const history = actor ?? [];
			for (let i = 0; i < ready.length; i++) {
				this.rowCount++;
				history.push(ready[i]!);
			}
			if (!actor) this.byActor.set(sid, history);
		}
		this.frontier = next;
		this.budget.metadata = bytes;
		return ready;
	}

	/** A contiguous delivery needs no staging maps or causal work queue. */
	private appendSingleRemote(
		row: PulsePatchRow,
		beforeCommit: ((ready: PulsePatchRow[]) => void) | undefined,
	): PulsePatchRow[] | undefined {
		if (row.operations.length > MAX_PATCH_BYTES)
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
			!row.operations.length
		)
			throw new PulseError("INVALID_MESSAGE", "Invalid patch segment");
		const predecessor = clockAt(row.dependencies, row.sid);
		if (predecessor > row.clock)
			throw new PulseError("INVALID_MESSAGE", "Invalid predecessor");
		const existing = this.find(row.sid, row.clock);
		if (existing) {
			if (!same(existing, row))
				throw new PulseError(
					"CONFLICT",
					"Conflicting segment for the same operation ID",
				);
			if (beforeCommit) beforeCommit([]);
			return [];
		}
		const actor = this.byActor.get(row.sid);
		if (row.clock !== (clockAt(this.frontier, row.sid) || 1)) return undefined;
		if (row.clock > 1 && predecessor < row.clock)
			throw new PulseError("CONFLICT", "Actor history fork");
		for (const [sid, clock] of row.dependencies)
			if (clockAt(this.frontier, sid) < clock) return undefined;
		const bytes =
			this.budget.metadata +
			row.operations.length +
			row.dependencies.length * 16 +
			row.docId.length * 2 +
			40;
		if (
			this.rowCount + 1 > MAX_LOG_ROWS ||
			bytes + this.budget.encoded > MAX_LOG_BYTES
		)
			throw new PulseError("LIMIT_EXCEEDED", "Document history limit exceeded");
		const next = advance(this.frontier, row.sid, end(row));
		const copy = copyRow(row, false, true),
			ready = [copy];
		if (beforeCommit) beforeCommit(ready);
		this.rowCount++;
		if (actor) actor.push(copy);
		else this.byActor.set(row.sid, [copy]);
		this.frontier = next;
		this.budget.metadata = bytes;
		return ready;
	}

	private appendNative(
		patch: Patch,
		toWire: ToWire,
		beforeCommit: ((ready: PulsePatchRow[]) => void) | undefined,
		borrowed: boolean,
	): PulsePatchRow[] {
		const id = patch.getId();
		if (!id) return [];
		const row = new LocalPatchRow(
			this.docId,
			id.sid,
			id.time,
			patch.span(),
			borrowed ? this.frontier : this.vector,
			patch,
			toWire,
			this.budget,
		);
		let ready: PulsePatchRow[];
		if (!this.pending.size) {
			const actor = this.byActor.get(row.sid);
			const previous = actor?.[actor.length - 1];
			if (
				row.sid < 65536 ||
				!Number.isSafeInteger(row.sid) ||
				row.clock < 1 ||
				!Number.isSafeInteger(row.clock) ||
				!Number.isSafeInteger(row.span) ||
				!Number.isSafeInteger(end(row)) ||
				row.span < 1
			)
				throw new PulseError("INVALID_MESSAGE", "Invalid patch segment");
			if (
				this.find(row.sid, row.clock) ||
				(previous && row.clock < end(previous))
			)
				throw new PulseError("CONFLICT", "Local patch ID already exists");
			if (row.clock !== (clockAt(this.frontier, row.sid) || 1))
				throw new PulseError(
					"INVALID_MESSAGE",
					"Local actor sequence must be contiguous",
				);
			const bytes =
				this.budget.metadata +
				row.dependencies.length * 16 +
				row.docId.length * 2 +
				40;
			if (
				this.rowCount + 1 > MAX_LOG_ROWS ||
				bytes + this.budget.encoded > MAX_LOG_BYTES
			)
				throw new PulseError(
					"LIMIT_EXCEEDED",
					"Document history limit exceeded",
				);
			const next = advance(this.frontier, row.sid, end(row));
			const available = [row];
			if (beforeCommit)
				beforeCommit(borrowed ? available : [copyRow(row, true)]);
			if (bytes + this.budget.encoded + row.encodedBytes > MAX_LOG_BYTES)
				throw new PulseError(
					"LIMIT_EXCEEDED",
					"Document history limit exceeded",
				);
			this.rowCount++;
			if (actor) actor.push(row);
			else this.byActor.set(row.sid, [row]);
			this.frontier = next;
			this.budget.metadata = bytes;
			ready = borrowed ? available : [copyRow(row, true)];
		} else
			ready = this.insert(
				[row],
				beforeCommit,
				true,
				() => row.encodedBytes,
				borrowed,
			);
		this.recordNativeTail(row);
		row.committed = true;
		this.budget.encoded += row.encodedBytes;
		return ready;
	}

	private insert(
		incoming: readonly PulsePatchRow[],
		beforeCommit: ((ready: PulsePatchRow[]) => void) | undefined,
		local: boolean,
		pendingBytes?: () => number,
		borrowed = false,
	): PulsePatchRow[] {
		const fresh: PulsePatchRow[] = [];
		const staged = new Map<string, PulsePatchRow>();
		const stagedActors = new Map<number, PulsePatchRow[]>();
		let bytes = this.budget.metadata;
		for (const row of incoming) {
			this.assertStateHistory(row);
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
			if (clockAt(row.dependencies, row.sid) > row.clock)
				throw new PulseError("INVALID_MESSAGE", "Invalid predecessor");
			const existing = staged.get(key(row)) ?? this.find(row.sid, row.clock);
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
					if (clockAt(next.dependencies, row.sid) < end(previous))
						throw new PulseError("CONFLICT", "Actor history fork");
				}
			}
			const copy = local ? row : copyRow(row, false, true);
			staged.set(key(copy), copy);
			let actor = stagedActors.get(copy.sid);
			if (!actor) {
				actor = [];
				stagedActors.set(copy.sid, actor);
			}
			if (!actor.length || actor[actor.length - 1]!.clock < copy.clock)
				actor.push(copy);
			else actor.splice(lowerBound(actor, copy.clock), 0, copy);
			bytes +=
				(local ? 0 : copy.operations.length) +
				copy.dependencies.length * 16 +
				copy.docId.length * 2 +
				40;
		}
		if (
			this.rowCount + staged.size > MAX_LOG_ROWS ||
			bytes + this.budget.encoded > MAX_LOG_BYTES
		)
			throw new PulseError("LIMIT_EXCEEDED", "Document history limit exceeded");
		const pending = new Map(this.pending);
		const clocks = new Map(this.frontier);
		for (const [id, row] of staged) pending.set(id, row);
		const candidates = [...pending.values()];
		// Sorting is unnecessary on the normal ascending batch path. For reverse
		// arrival it prevents a separate full scan for every same-actor row.
		let ordered = true;
		for (let i = 1; i < candidates.length; i++) {
			const left = candidates[i - 1]!,
				right = candidates[i]!;
			if (
				left.sid > right.sid ||
				(left.sid === right.sid && left.clock > right.clock)
			) {
				ordered = false;
				break;
			}
		}
		if (!ordered) candidates.sort((a, b) => a.sid - b.sid || a.clock - b.clock);
		let changed: boolean;
		do {
			changed = false;
			for (let i = 0; i < candidates.length; i++) {
				const row = candidates[i];
				if (
					!row ||
					row.clock > (clocks.get(row.sid) ?? 1) ||
					!covers(clocks, row.dependencies)
				)
					continue;
				if (!clocks.has(row.sid) && clocks.size >= MAX_VECTOR_ENTRIES)
					throw new PulseError("INVALID_MESSAGE", "Invalid version vector");
				clocks.set(row.sid, Math.max(end(row), clocks.get(row.sid) ?? 0));
				pending.delete(key(row));
				candidates[i] = undefined!;
				fresh.push(row);
				changed = true;
			}
		} while (changed);
		const frontier = fresh.length
			? [...clocks].sort((a, b) => a[0] - b[0])
			: this.frontier;
		if (beforeCommit)
			beforeCommit(borrowed ? fresh : fresh.map((row) => copyRow(row, local)));
		if (bytes + this.budget.encoded + (pendingBytes?.() ?? 0) > MAX_LOG_BYTES)
			throw new PulseError("LIMIT_EXCEEDED", "Document history limit exceeded");
		for (const row of staged.values()) {
			this.rowCount++;
			let actor = this.byActor.get(row.sid);
			if (!actor) {
				actor = [];
				this.byActor.set(row.sid, actor);
			}
			if (!actor.length || actor[actor.length - 1]!.clock < row.clock)
				actor.push(row);
			else actor.splice(lowerBound(actor, row.clock), 0, row);
		}
		this.pending.clear();
		for (const [id, row] of pending) this.pending.set(id, row);
		this.frontier = frontier;
		this.budget.metadata = bytes;
		return borrowed ? fresh : fresh.map((row) => copyRow(row, local));
	}

	private recordNativeTail(row: LocalPatchRow): void {
		const patch = row.nativePatch;
		if (!patch) {
			this.nativeTails.delete(row.sid);
			return;
		}
		const tail = this.nativeTails.get(row.sid),
			previous = tail?.last.nativePatch;
		if (
			tail &&
			previous &&
			row.clock === tail.last.clock + 1 &&
			patch.lamport === previous.lamport + 1 &&
			patch.schema === previous.schema &&
			patch.target === previous.target &&
			patch.field === previous.field &&
			sameRunDependencies(
				row,
				{ sid: row.sid, clock: row.clock, external: tail.external },
				0,
			)
		)
			tail.last = row;
		else
			this.nativeTails.set(row.sid, {
				first: row,
				last: row,
				external: row.dependencies.filter(([sid]) => sid !== row.sid),
			});
	}
	/** O(actors) transport view of the current local homogeneous scalar tail. */
	borrowNativeTail(
		vv: PulseVersionVector,
	): { first: PulsePatchRow; last: PulsePatchRow; count: number } | undefined {
		validateVector(vv);
		let selected: ReturnType<PatchLog["borrowNativeTail"]>;
		for (const [sid, rows] of this.byActor) {
			const last = rows[rows.length - 1]!;
			const start = Math.max(1, clockAt(vv, sid));
			if (end(last) <= start) continue;
			if (selected) return undefined;
			const tail = this.nativeTails.get(sid);
			if (!tail || tail.last !== last || start < tail.first.clock)
				return undefined;
			const first = rows[lowerBound(rows, start)];
			if (!first || first.clock !== start) return undefined;
			selected = { first, last, count: last.clock - start + 1 };
		}
		if (
			selected &&
			clockAt(this.frontier, selected.last.sid) < end(selected.last)
		)
			return undefined;
		return selected;
	}

	/** Exact per-actor physical prefixes; unlike vector, these never claim state-only operations. */
	get historyVector(): PulseVersionVector {
		if (this.historyCache?.count !== this.rowCount) {
			const vv: PulseVersionVector = [];
			for (const [sid, rows] of this.byActor) {
				let clock = 1;
				for (const row of rows) {
					if (row.clock > clock) break;
					clock = Math.max(clock, end(row));
				}
				if (clock > 1) vv.push([sid, clock]);
			}
			vv.sort((a, b) => a[0] - b[0]);
			this.historyCache = { count: this.rowCount, vv };
		}
		return this.historyCache.vv.map(([sid, clock]) => [sid, clock]);
	}
	/** Internal read-only state coverage; not an operation journal. */
	borrowStates(): readonly StateDelta[] {
		return this.summaries;
	}
	private physicalCovers(sid: number, start: number, finish: number): boolean {
		if (start >= finish) return true;
		const rows = this.byActor.get(sid);
		if (!rows) return false;
		let at = lowerBound(rows, start);
		if (at && end(rows[at - 1]!) > start) at--;
		let clock = start;
		for (; at < rows.length && clock < finish; at++) {
			const row = rows[at]!;
			if (row.clock > clock) return false;
			clock = Math.max(clock, end(row));
		}
		return clock >= finish;
	}
	private assertHistoryAvailable(vv: PulseVersionVector): void {
		validateVector(vv);
		for (const delta of this.summaries) {
			const start = Math.max(delta.clock, clockAt(vv, delta.sid));
			const finish = delta.clock + delta.count;
			if (start < finish && !this.physicalCovers(delta.sid, start, finish))
				throw new PulseError(
					"HISTORY_UNAVAILABLE",
					"Requested operation history is state-only; fetch it from a full-history peer or store",
				);
		}
	}
	private assertRowMatches(row: PulsePatchRow, delta: StateDelta): void {
		let layout = -1;
		const patch = decodeCorePatch(row, {
			encode: () => {
				throw Error("unused");
			},
			decode: (id, bytes) => {
				layout = id;
				return bytes;
			},
		});
		const op = patch.ops.length === 1 ? patch.ops[0] : undefined;
		const expectedDeps = delta.external.map(([sid, c]): [number, number] => [
			sid,
			c,
		]);
		if (row.clock > 1) {
			const at = expectedDeps.findIndex(([sid]) => sid > row.sid);
			expectedDeps.splice(at < 0 ? expectedDeps.length : at, 0, [
				row.sid,
				row.clock,
			]);
		}
		if (
			row.docId !== this.docId ||
			row.span !== 1 ||
			patch.schema !== delta.schema ||
			patch.lamport !== delta.lamport + row.clock - delta.clock ||
			op?.kind !== 1 ||
			op.target !== delta.target ||
			op.field !== delta.field ||
			layout !== delta.layout ||
			op.value.constants.length ||
			op.value.texts.length ||
			JSON.stringify(row.dependencies) !== JSON.stringify(expectedDeps)
		)
			throw new PulseError(
				"CONFLICT",
				"Operation history contradicts received state coverage",
			);
		if (
			row.clock === delta.clock + delta.count - 1 &&
			!same(row, stateLastRow(delta))
		)
			throw new PulseError(
				"CONFLICT",
				"State winner conflicts with exact history",
			);
	}
	private assertStateHistory(row: PulsePatchRow): void {
		const states = this.statesByActor.get(row.sid);
		if (!states) return;
		let lo = 0,
			hi = states.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1,
				d = states[mid]!;
			if (d.clock + d.count <= row.clock) lo = mid + 1;
			else hi = mid;
		}
		for (let i = lo; i < states.length && states[i]!.clock < end(row); i++)
			this.assertRowMatches(row, states[i]!);
	}

	/** Atomically advance state coverage and release exact pending operations. */
	acceptState(
		delta: StateDelta,
		beforeCommit: (ready: PulsePatchRow[]) => void,
	): { changed: boolean; ready: PulsePatchRow[] } {
		if (delta.docId !== this.docId)
			throw new PulseError("INVALID_MESSAGE", "Wrong state document");
		const finish = delta.clock + delta.count,
			current = clockAt(this.frontier, delta.sid) || 1;
		if (
			delta.clock > current ||
			!covers(new Map(this.frontier), delta.external)
		)
			throw new PulseError(
				"HISTORY_UNAVAILABLE",
				"State delta needs an earlier causal base",
			);
		for (const old of this.statesByActor.get(delta.sid) ?? [])
			if (
				old.sid === delta.sid &&
				old.clock < finish &&
				old.clock + old.count > delta.clock
			) {
				if (!sameStateHeader(old, delta))
					throw new PulseError(
						"CONFLICT",
						"Overlapping state coverage conflicts",
					);
				if (
					old.clock + old.count === finish &&
					!same(stateLastRow(old), stateLastRow(delta))
				)
					throw new PulseError("CONFLICT", "State winner conflicts");
			}
		const history = this.byActor.get(delta.sid) ?? [];
		let at = lowerBound(history, delta.clock);
		if (at && end(history[at - 1]!) > delta.clock) at--;
		for (; at < history.length && history[at]!.clock < finish; at++)
			this.assertRowMatches(history[at]!, delta);
		if (history[at] && clockAt(history[at]!.dependencies, delta.sid) < finish)
			throw new PulseError("CONFLICT", "Actor history fork after state range");
		if (finish <= current) {
			beforeCommit([]);
			return { changed: false, ready: [] };
		}
		const last = stateLastRow(delta),
			existingLast = this.find(delta.sid, finish - 1);
		const rowBytes = existingLast
			? 0
			: last.operations.length +
				last.dependencies.length * 16 +
				last.docId.length * 2 +
				40;
		const needsRecord = !this.physicalCovers(delta.sid, current, finish - 1),
			stateBytes = needsRecord ? delta.bytes : 0;
		if (
			(needsRecord && this.summaries.length >= MAX_LOG_ROWS) ||
			this.rowCount + (existingLast ? 0 : 1) > MAX_LOG_ROWS ||
			this.budget.metadata + this.budget.encoded + stateBytes + rowBytes >
				MAX_LOG_BYTES
		)
			throw new PulseError("LIMIT_EXCEEDED", "State coverage limit exceeded");
		const frontier = advance(this.frontier, delta.sid, finish),
			clocks = new Map(frontier),
			pending = new Map(this.pending),
			ready: PulsePatchRow[] = [];
		let changed: boolean;
		do {
			changed = false;
			for (const [id, row] of pending) {
				if (
					row.clock <= (clocks.get(row.sid) ?? 1) &&
					covers(clocks, row.dependencies)
				) {
					if (!clocks.has(row.sid) && clocks.size >= MAX_VECTOR_ENTRIES)
						throw new PulseError("LIMIT_EXCEEDED", "Actor limit exceeded");
					clocks.set(row.sid, Math.max(end(row), clocks.get(row.sid) ?? 0));
					pending.delete(id);
					ready.push(row);
					changed = true;
				}
			}
		} while (changed);
		beforeCommit(ready);
		if (needsRecord) {
			const record = clipState(delta, current);
			this.summaries.push(record);
			const states = this.statesByActor.get(delta.sid) ?? [];
			states.push(record);
			this.statesByActor.set(delta.sid, states);
		}
		this.budget.metadata += stateBytes + rowBytes;
		if (!existingLast) {
			const actor = this.byActor.get(delta.sid) ?? [];
			actor.splice(lowerBound(actor, last.clock), 0, last);
			if (!this.byActor.has(delta.sid)) this.byActor.set(delta.sid, actor);
			this.rowCount++;
		}
		this.frontier = [...clocks].sort((a, b) => a[0] - b[0]);
		this.pending.clear();
		for (const [id, row] of pending) this.pending.set(id, row);
		return { changed: true, ready };
	}

	private find(sid: number, clock: number): PulsePatchRow | undefined {
		const history = this.byActor.get(sid);
		if (!history?.length || clock > history[history.length - 1]!.clock)
			return undefined;
		const at = lowerBound(history, clock);
		return history[at]?.clock === clock ? history[at] : undefined;
	}
	/** Internal borrowed rows; callers must neither mutate nor expose them. */
	borrowMissing(
		vv: PulseVersionVector,
		availableOnly = false,
	): PulsePatchRow[] {
		if (!availableOnly) this.assertHistoryAvailable(vv);
		validateVector(vv);
		const clocks = new Map(vv),
			result: PulsePatchRow[] = [];
		for (const [sid, history] of this.byActor) {
			const clock = clocks.get(sid) ?? 0;
			let i = lowerBound(history, clock);
			if (i && end(history[i - 1]!) > clock) i--;
			for (; i < history.length; i++) result.push(history[i]!);
		}
		return result;
	}
	/** Internal atomic contiguous run append; all rows are codec-owned. */
	appendContiguousRun(
		rows: PulsePatchRow[],
		beforeCommit: () => void,
	): boolean {
		const run = scalarRunOf(rows);
		if (!run || this.pending.size || this.summaries.length) return false;
		const { external, expandedBytes } = run;
		const first = rows[0]!;
		if (first.docId !== this.docId)
			throw new PulseError("INVALID_MESSAGE", "Wrong run document");
		const actor = this.byActor.get(first.sid),
			previous = actor?.[actor.length - 1];
		if (first.clock !== (previous ? end(previous) : 1)) return false;
		for (const [sid, clock] of external)
			if (clockAt(this.frontier, sid) < clock) return false;
		if (
			this.rowCount + rows.length > MAX_LOG_ROWS ||
			this.budget.metadata + this.budget.encoded + expandedBytes > MAX_LOG_BYTES
		)
			throw new PulseError("LIMIT_EXCEEDED", "Document history limit exceeded");
		const next = advance(this.frontier, first.sid, first.clock + rows.length);
		beforeCommit();
		const history = actor ?? [];
		// The codec bounds runs to 4096 rows. Native bulk append also avoids
		// the slow iterator path of frozen public frame arrays.
		Array.prototype.push.apply(history, rows);
		if (!actor) this.byActor.set(first.sid, history);
		this.rowCount += rows.length;
		this.frontier = next;
		this.budget.metadata += expandedBytes;
		return true;
	}
	missing(vv: PulseVersionVector): PulsePatchRow[] {
		this.assertHistoryAvailable(vv);
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

/** Only runtime-native rows carry this descriptor; public copies do not. */
export function nativePatchOf(row: PulsePatchRow): ScalarPatch | undefined {
	return row instanceof LocalPatchRow ? row.nativePatch : undefined;
}
