import {
	createEncoder,
	writeFloat64,
	writeVarString,
	toUint8Array,
} from "@gin-quin/codec";
import type { PulseMeta } from "../pulses/PulseMeta.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import type { PulseMessage } from "../connection/PulseMessage.js";
import { encodeMessage } from "../connection/PulseMessage.js";
import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import { PatchLog, nativePatchOf } from "./PatchLog.js";
import {
	scalarEntryOf,
	sameRunDependencies,
	runOperationSize,
	type ScalarColumn,
} from "./scalarRuns.js";
import {
	STATE_THRESHOLD,
	clipState,
	encodeStateMessage,
	type StateDelta,
} from "./stateDeltas.js";
import { chunkRows } from "./chunkRows.js";
import { PulseError } from "./errors.js";
import { MAX_PATCH_BYTES } from "./limits.js";

type Block = {
	rows: PulsePatchRow[];
	delta?: StateDelta;
	sid: number;
	clock: number;
	count: number;
	deps: PulseVersionVector;
};
type Update = Extract<PulseMessage, { kind: 2 | 4 }>;
function columnOf(
	row: PulsePatchRow,
	meta?: PulseMeta,
): ScalarColumn | undefined {
	const patch = nativePatchOf(row);
	if (patch && meta) {
		const column = meta.model.scalarColumn(patch.target, patch.field);
		if (column && patch.schema === meta.model.schemaId)
			return {
				...patch,
				layout: column.id + 2,
				count: 1,
				external: row.dependencies.filter(([sid]) => sid !== row.sid),
			};
	}
	const entry = scalarEntryOf(row);
	if (entry)
		return {
			...entry.run,
			clock: row.clock,
			lamport: entry.run.lamport + entry.offset,
			count: 1,
		};
	return undefined;
}
function valueOf(row: PulsePatchRow, meta?: PulseMeta): Uint8Array {
	const entry = scalarEntryOf(row);
	if (entry)
		return entry.run.source.slice(
			entry.run.spans[entry.offset * 2],
			entry.run.spans[entry.offset * 2 + 1],
		);
	const patch = nativePatchOf(row)!,
		column = meta!.model.scalarColumn(patch.target, patch.field)!,
		e = createEncoder();
	if (column.kind === "float64") writeFloat64(e, patch.value as number);
	else writeVarString(e, patch.value as string);
	return toUint8Array(e);
}
function matches(
	row: PulsePatchRow,
	column: ScalarColumn,
	offset: number,
): boolean {
	const native = nativePatchOf(row),
		entry = native ? undefined : scalarEntryOf(row),
		patch = native ?? entry?.run;
	if (!patch) return false;
	const clock = native ? native.clock : entry!.run.clock + entry!.offset,
		lamport = native ? native.lamport : entry!.run.lamport + entry!.offset;
	return (
		row.span === 1 &&
		row.sid === column.sid &&
		clock === column.clock + offset &&
		lamport === column.lamport + offset &&
		patch.schema === column.schema &&
		patch.target === column.target &&
		patch.field === column.field &&
		(!entry || entry.run.layout === column.layout) &&
		sameRunDependencies(row, column, offset)
	);
}
/** Condensation is a transport view. No rows are removed from the source journal. */
export function encodeStateUpdates(
	log: PatchLog,
	vv: PulseVersionVector,
	message: Update,
	meta?: PulseMeta,
): Uint8Array[] {
	const tail = meta && log.borrowNativeTail(vv);
	if (tail && tail.count >= STATE_THRESHOLD) {
		const column = columnOf(tail.first, meta);
		if (column) {
			const data = valueOf(tail.last, meta),
				delta: StateDelta = {
					...column,
					docId: log.docId,
					count: tail.count,
					data,
					bytes: 0,
				};
			return [encodeStateMessage(message, delta)];
		}
	}
	const available = log.borrowMissing(vv, true),
		known = new Map(vv),
		applied = new Map(log.vector),
		blocks: Block[] = [];
	const summaries = log
		.borrowStates()
		.filter((d) => d.clock + d.count > (known.get(d.sid) ?? 1))
		.map((d) => clipState(d, Math.max(d.clock, known.get(d.sid) ?? 1)));
	for (const delta of summaries)
		blocks.push({
			rows: [],
			delta,
			sid: delta.sid,
			clock: delta.clock,
			count: delta.count,
			deps: delta.external,
		});
	const coverage = new Map<number, StateDelta[]>();
	for (const d of summaries) {
		const list = coverage.get(d.sid) ?? [];
		list.push(d);
		coverage.set(d.sid, list);
	}
	const rows = available.filter((row) => {
		const list = coverage.get(row.sid);
		if (!list) return true;
		let lo = 0,
			hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1,
				d = list[mid]!;
			if (d.clock + d.count <= row.clock) lo = mid + 1;
			else hi = mid;
		}
		return !list[lo] || list[lo]!.clock > row.clock;
	});
	for (let i = 0; i < rows.length; ) {
		const first = rows[i]!,
			column = columnOf(first, meta);
		let count = 1;
		if (column && first.span === 1) {
			while (i + count < rows.length) {
				const row = rows[i + count]!;
				if (!matches(row, column, count)) break;
				count++;
			}
		}
		if (
			column &&
			count >= STATE_THRESHOLD &&
			first.clock + count <= (applied.get(first.sid) ?? 1)
		) {
			const data = valueOf(rows[i + count - 1]!, meta);
			if (runOperationSize(column, count - 1, data.length) > MAX_PATCH_BYTES)
				throw new PulseError(
					"LIMIT_EXCEEDED",
					"State winner exceeds patch limit",
				);
			const delta: StateDelta = {
				...column,
				docId: log.docId,
				count,
				data,
				bytes:
					data.length +
					column.external.length * 16 +
					column.schema.length * 2 +
					column.target.length * 2 +
					log.docId.length * 2 +
					128,
			};
			blocks.push({
				rows: [],
				delta,
				sid: first.sid,
				clock: first.clock,
				count,
				deps: column.external,
			});
			i += count;
		} else {
			blocks.push({
				rows: [first],
				sid: first.sid,
				clock: first.clock,
				count: first.span,
				deps: first.dependencies,
			});
			i++;
		}
	}
	// State frames require a causal base. Exact rows can be buffered, but emitting
	// them in dependency order also makes mixed creation/state exchanges immediate.
	const ordered: Block[] = [];
	const pending = new Set(blocks);
	while (pending.size) {
		let progress = false;
		for (const block of pending) {
			if (
				block.clock > (known.get(block.sid) ?? 1) ||
				!block.deps.every(([sid, c]) => (known.get(sid) ?? 0) >= c)
			)
				continue;
			pending.delete(block);
			ordered.push(block);
			known.set(
				block.sid,
				Math.max(block.clock + block.count, known.get(block.sid) ?? 0),
			);
			progress = true;
		}
		if (!progress) {
			for (const block of pending) {
				if (block.delta)
					throw new PulseError(
						"HISTORY_UNAVAILABLE",
						"State delta requires unavailable causal history",
					);
				ordered.push(block);
			}
			break;
		}
	}
	const parts: { rows: PulsePatchRow[]; delta?: StateDelta }[] = [];
	let buffer: PulsePatchRow[] = [];
	const flush = () => {
		if (buffer.length) {
			for (const chunk of chunkRows(buffer)) parts.push({ rows: chunk });
			buffer = [];
		}
	};
	for (const block of ordered) {
		if (block.delta) {
			flush();
			parts.push({ rows: [], delta: block.delta });
		} else buffer.push(...block.rows);
	}
	flush();
	if (!parts.length) parts.push({ rows: [] });
	return parts.map((part, i) => {
		const m = {
			...message,
			rows: part.rows,
			...(message.kind === 2
				? { complete: i === parts.length - 1 }
				: { requestId: message.requestId ? message.requestId + i : 0 }),
		} as Update;
		return part.delta
			? encodeStateMessage(m, part.delta)
			: encodeMessage(m, { peerVersion: 2 });
	});
}
