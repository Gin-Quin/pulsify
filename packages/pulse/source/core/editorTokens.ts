import type { CoreEntry, CoreModel, Stamp } from "./model.js";
import {
	attributeEntries,
	CorePatch,
	encodeCorePatch,
	expandEntryRange,
	type CoreOperation,
} from "./operations.js";
import { MAX_PATCH_BYTES, MAX_RANGE_MARKS } from "../protocol/limits.js";
import { PulseError } from "../protocol/errors.js";
import { prepareValue } from "./values.js";
import {
	RT_NODE,
	RT_PREFIX,
	RT_REMOVED,
	isRichTextNode,
	richTextRemovedNodes,
	type RichTextContext,
} from "./richTextBinding.js";
export type EditorToken = {
	value: string;
	attributes: Record<string, unknown>;
	entry?: CoreEntry;
};
type Attributes = Record<string, unknown>;
export type EditorChange = {
	inserted: string[];
	deleted: string[];
	attributes: {
		entry: string;
		key: string;
		before: unknown;
		after: unknown;
		stamp: Stamp;
		beforeStamp?: Stamp | undefined;
	}[];
};

function roughValueSize(value: unknown): number {
	if (value === null || value === undefined) return 2;
	if (typeof value === "string") return value.length * 3 + 4;
	if (typeof value === "number" || typeof value === "boolean") return 10;
	if (value instanceof Uint8Array) return value.length + 4;
	if (Array.isArray(value)) {
		let size = 4;
		for (let i = 0; i < value.length; i++) size += roughValueSize(value[i]);
		return size;
	}
	if (typeof value === "object") {
		let size = 8;
		for (const [k, v] of Object.entries(value))
			size += k.length * 3 + 4 + roughValueSize(v);
		return size;
	}
	return 16;
}

/**
 * Verify a transaction fits within `MAX_PATCH_BYTES` and `MAX_RANGE_MARKS`
 * before mutating the model or journal, so oversized edits revert atomically.
 */
export function assertEditorPatchSize(
	model: CoreModel,
	operations: CoreOperation[],
): void {
	if (!operations.length) return;
	let estimate = 64 + model.schemaId.length;
	let ranged = 0;
	for (let i = 0; i < operations.length; i++) {
		const op = operations[i]!;
		estimate += 48;
		if (op.kind === 12) {
			if (!op.text.isWellFormed())
				throw new TypeError("Strings must be valid Unicode");
			estimate += op.text.length * 3 + roughValueSize(op.attributes);
			if (op.attributes)
				ranged +=
					op.text.length * Math.max(1, Object.keys(op.attributes).length);
		} else if (op.kind === 3) {
			estimate += op.deletes.length * 32 + op.values.length * 64;
		} else if (op.kind === 5) {
			estimate +=
				(op.count !== undefined ? 64 : op.entries.length * 32) +
				roughValueSize(op.attributes);
			if (op.count !== undefined)
				ranged += op.count * Math.max(1, Object.keys(op.attributes).length);
		} else if (op.kind === 13) {
			estimate += 64;
			ranged += op.count;
		}
	}
	if (ranged > MAX_RANGE_MARKS) {
		let exact = 0;
		for (let i = 0; i < operations.length; i++) {
			const op = operations[i]!;
			if (op.kind === 12 && op.attributes)
				exact +=
					Array.from(op.text).length *
					Math.max(1, Object.keys(op.attributes).length);
			else if (op.kind === 5 && op.count !== undefined)
				exact += op.count * Math.max(1, Object.keys(op.attributes).length);
			else if (op.kind === 13) exact += op.count;
		}
		if (exact > MAX_RANGE_MARKS)
			throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
	}
	if (estimate >= MAX_PATCH_BYTES / 2) {
		encodeCorePatch(
			new CorePatch(
				model.sid,
				model.nextClock,
				model.lamport + 1,
				model.schemaId,
				operations,
			),
			model.encoding,
		);
	}
}

function parseEntryId(id: string): { prefix: string; serial: number } | null {
	const at = id.lastIndexOf(":");
	if (at < 0) return null;
	const serial = Number(id.slice(at + 1));
	if (!Number.isSafeInteger(serial) || serial < 0) return null;
	return { prefix: id.slice(0, at + 1), serial };
}

/** Compress contiguous same-transaction entry IDs into ranges (count >= 2) plus loose IDs. */
function splitEntryRanges(ids: readonly string[]): {
	ranges: { first: string; count: number }[];
	loose: string[];
} {
	const ranges: { first: string; count: number }[] = [];
	const loose: string[] = [];
	let i = 0;
	while (i < ids.length) {
		const first = ids[i]!;
		const parsed = parseEntryId(first);
		if (!parsed) {
			loose.push(first);
			i++;
			continue;
		}
		let count = 1;
		while (i + count < ids.length) {
			const next = ids[i + count]!;
			if (next !== parsed.prefix + (parsed.serial + count)) break;
			count++;
		}
		if (count >= 2) ranges.push({ first, count });
		else loose.push(first);
		i += count;
	}
	return { ranges, loose };
}

/** Emit range delete ops (kind 13) and a loose kind 3 delete op when needed. */
export function pushDeleteOps(
	operations: CoreOperation[],
	target: string,
	deletes: readonly string[],
): void {
	if (!deletes.length) return;
	if (deletes.length === 1) {
		operations.push({
			kind: 3,
			target,
			after: "",
			deletes: [deletes[0]!],
			values: [],
		});
		return;
	}
	const { ranges, loose } = splitEntryRanges(deletes);
	if (loose.length)
		operations.push({
			kind: 3,
			target,
			after: "",
			deletes: loose,
			values: [],
		});
	for (const { first, count } of ranges)
		operations.push({ kind: 13, target, first, count });
}

/** Emit range attribute ops (wire kind 11) and a loose kind 5 op when needed. */
export function pushAttributeOps(
	operations: CoreOperation[],
	target: string,
	entries: readonly string[],
	attributes: Attributes,
): void {
	if (!entries.length) return;
	if (entries.length === 1) {
		operations.push({
			kind: 5,
			target,
			entries: [entries[0]!],
			attributes,
		});
		return;
	}
	const { ranges, loose } = splitEntryRanges(entries);
	if (loose.length)
		operations.push({ kind: 5, target, entries: loose, attributes });
	for (const { first, count } of ranges)
		operations.push({
			kind: 5,
			target,
			entries: [first],
			count,
			attributes,
		});
}

/** Capture only touched entries, so history costs scale with the edit. */
export function commitEditorOperations(
	context: RichTextContext,
	operations: CoreOperation[],
): EditorChange {
	const { node, model } = context;
	const change: EditorChange = { inserted: [], deleted: [], attributes: [] };
	if (!operations.length) return change;
	assertEditorPatchSize(model, operations);
	const updates = new Map<
		string,
		{
			entry: string;
			key: string;
			before: unknown;
			after: unknown;
			stamp: Stamp;
			beforeStamp?: Stamp | undefined;
		}
	>();
	let serial = 0;
	const sid = model.sid;
	const clock = model.nextClock;
	const prefix = `${sid}:${clock}:`;
	for (const op of operations) {
		if (op.kind === 3) {
			for (const id of op.deletes)
				if (!node.entries.get(id)?.deleted) change.deleted.push(id);
			for (let i = 0; i < op.values.length; i++)
				change.inserted.push(prefix + serial++);
		} else if (op.kind === 12) {
			for (const _ of op.text) change.inserted.push(prefix + serial++);
		} else if (op.kind === 13) {
			for (const id of expandEntryRange(op.first, op.count))
				if (!node.entries.get(id)?.deleted) change.deleted.push(id);
		} else if (op.kind === 5) {
			for (const id of attributeEntries(op)) {
				const entry = node.entries.get(id);
				if (!entry) continue; // Attributes of a new entry travel with its undo/redo.
				for (const [key, after] of Object.entries(op.attributes)) {
					const identity = `${id}\0${key}`;
					const previous = updates.get(identity);
					updates.set(identity, {
						entry: id,
						key,
						beforeStamp: previous
							? previous.beforeStamp
							: entry.marks.get(key)?.stamp,
						before: previous
							? previous.before
							: (entry.marks.get(key)?.value ?? null),
						after,
						stamp: entry.stamp,
					});
				}
			}
		} else
			throw new TypeError(
				"Editor adapters only accept text and attribute operations",
			);
	}
	model.commit(operations);
	for (const update of updates.values()) {
		update.stamp = node.entries.get(update.entry)!.marks.get(update.key)!.stamp;
		change.attributes.push(update);
	}
	return change;
}

/** Invert local intent against today's entries, retaining concurrent edits. */
export function invertEditorChange(
	context: RichTextContext,
	change: EditorChange,
): EditorChange {
	const { node } = context;
	const operations: CoreOperation[] = [];
	const updates = new Map<string, Attributes>();
	for (const update of change.attributes) {
		const current = node.entries.get(update.entry)?.marks.get(update.key);
		if (
			!current ||
			current.stamp.some((part, index) => part !== update.stamp[index])
		)
			continue;
		let attributes = updates.get(update.entry);
		if (!attributes) updates.set(update.entry, (attributes = {}));
		attributes[update.key] = update.before;
	}
	const deletes = change.inserted.filter(
		(id) => node.entries.has(id) && !node.entries.get(id)!.deleted,
	);
	pushDeleteOps(operations, node.id, deletes);
	for (const id of deletes)
		if (isRichTextNode(node.entries.get(id)!)) {
			let attributes = updates.get(id);
			if (!attributes) updates.set(id, (attributes = {}));
			attributes[RT_REMOVED] = true;
		}
	for (const id of change.deleted) {
		const entry = node.entries.get(id);
		if (!entry?.deleted) continue;
		const attributes = { ...editorAttributes(entry), ...updates.get(id) };
		if (isRichTextNode(entry)) attributes[RT_REMOVED] = null;
		const prepared = Object.keys(attributes).length
			? (prepareValue(attributes).value as Attributes)
			: undefined;
		// Insert at the original tombstone so unseen children retain their order.
		operations.push({
			kind: 12,
			target: node.id,
			after: id,
			text: entry.value as string,
			...(prepared ? { attributes: prepared } : {}),
		});
	}
	const groupedUpdates = new Map<
		string,
		{ entries: string[]; attributes: Attributes }
	>();
	for (const [entry, attributes] of updates) {
		const group = JSON.stringify(attributes);
		const existing = groupedUpdates.get(group);
		if (existing) existing.entries.push(entry);
		else
			groupedUpdates.set(group, {
				entries: [entry],
				attributes: prepareValue(attributes).value as Attributes,
			});
	}
	for (const group of groupedUpdates.values())
		pushAttributeOps(operations, node.id, group.entries, group.attributes);
	return commitEditorOperations(context, operations);
}
export function editorAttributes(entry: CoreEntry): Attributes {
	const result: Attributes = {};
	for (const [key, mark] of entry.marks)
		if (mark.value != null) result[key] = mark.value;
	return result;
}
function rtAttributesOf(input: Attributes): {
	key: string;
	prepared: Attributes | undefined;
} {
	const filtered: Attributes = {};
	let hasAny = false;
	for (const [k, v] of Object.entries(input)) {
		if (!k.startsWith(RT_PREFIX) || v === undefined || v === null) continue;
		filtered[k] = v;
		hasAny = true;
	}
	if (!hasAny) return { key: "", prepared: undefined };
	const prepared = prepareValue(filtered).value as Attributes;
	return { key: JSON.stringify(prepared), prepared };
}
export function reconcileEditorTokens(
	context: RichTextContext,
	desired: readonly EditorToken[],
	newKeys: string[],
	extraOperations: CoreOperation[] = [],
	trackHistory = false,
	baseline?: readonly EditorToken[],
): EditorChange {
	const { node, model } = context;
	const previous = new Map(
		baseline?.map((token) => [
			token.attributes[RT_NODE]
				? `node:${token.attributes[RT_NODE]}`
				: `char:${token.entry?.id}`,
			token.attributes,
		]),
	);
	const knownEntries =
		baseline &&
		new Set(baseline.flatMap((token) => (token.entry ? [token.entry.id] : [])));
	if (baseline) {
		const removed = richTextRemovedNodes(node),
			filtered: EditorToken[] = [],
			keys: string[] = [];
		for (let index = 0; index < desired.length; index++) {
			const token = desired[index]!;
			if (
				token.attributes[RT_NODE]
					? removed.has(String(token.attributes[RT_NODE]))
					: token.entry?.deleted
			)
				continue;
			filtered.push(token);
			keys.push(newKeys[index]!);
		}
		desired = filtered;
		newKeys = keys;
	}
	const old = node.visible;
	const used = new Set(
		desired
			.map((token) => token.attributes[RT_NODE])
			.filter((id): id is string => typeof id === "string"),
	);
	const oldKeys = old.map((entry) =>
		isRichTextNode(entry)
			? `node:${entry.marks.get(RT_NODE)!.value}`
			: `char:${entry.id}`,
	);
	const matches = matchTokens(oldKeys, newKeys);
	const retained = new Set(matches.values());
	const operations: CoreOperation[] = [];
	const deletes = old
		.filter(
			(entry, i) =>
				!retained.has(i) && (!knownEntries || knownEntries.has(entry.id)),
		)
		.map((entry) => entry.id);
	pushDeleteOps(operations, node.id, deletes);
	// A logical deletion also covers duplicate anchors created by concurrent
	// first bindings. Moving/reordering an existing node keeps its identity.
	const removedAnchors = old.filter((entry) => {
		const id = entry.marks.get(RT_NODE)?.value;
		return (
			typeof id === "string" &&
			!used.has(id) &&
			(!baseline || previous.has(`node:${id}`))
		);
	});
	if (removedAnchors.length)
		pushAttributeOps(
			operations,
			node.id,
			removedAnchors.map((entry) => entry.id),
			{ [RT_REMOVED]: true },
		);
	operations.push(...extraOperations);
	let after = "",
		entrySerial = 0;
	const idPrefix = `${model.sid}:${model.nextClock}:`;
	let insertion:
		| {
				op: Extract<CoreOperation, { kind: 12 }>;
				key: string;
				raw: Attributes;
				chunks: string[];
		  }
		| undefined;
	const flushInsertion = () => {
		if (!insertion) return;
		if (insertion.chunks.length > 1)
			insertion.op.text = insertion.chunks.join("");
		else if (insertion.chunks.length === 1)
			insertion.op.text = insertion.chunks[0]!;
		insertion = undefined;
	};
	const formatting = new Map<
		string,
		{ entries: string[]; attributes: Attributes }
	>();
	for (let i = 0; i < desired.length; i++) {
		const token = desired[i]!,
			oldIndex = matches.get(i);
		const entry = oldIndex === undefined ? undefined : old[oldIndex];
		const entryId = entry?.id ?? idPrefix + entrySerial++;
		if (!entry) {
			if (insertion && insertion.raw === token.attributes) {
				insertion.chunks.push(token.value);
			} else {
				const { key, prepared } = rtAttributesOf(token.attributes);
				if (insertion && insertion.key === key) {
					insertion.chunks.push(token.value);
					insertion.raw = token.attributes;
				} else {
					flushInsertion();
					const op: Extract<CoreOperation, { kind: 12 }> = {
						kind: 12,
						target: node.id,
						after,
						text: token.value,
						...(prepared ? { attributes: prepared } : {}),
					};
					operations.push(op);
					insertion = {
						op,
						key,
						raw: token.attributes,
						chunks: [token.value],
					};
				}
			}
			after = entryId;
			continue;
		}
		flushInsertion();
		const before = editorAttributes(entry);
		const original = baseline
			? previous.get(
					token.attributes[RT_NODE]
						? `node:${token.attributes[RT_NODE]}`
						: `char:${entry.id}`,
				)
			: undefined;
		const updates: Attributes = {};
		let hasUpdate = false;
		for (const attribute of new Set([
			...Object.keys(before),
			...Object.keys(token.attributes),
		])) {
			// Preserve attributes owned by other rich text consumers.
			if (!attribute.startsWith(RT_PREFIX)) continue;
			const value = token.attributes[attribute] ?? null;
			if (
				original &&
				JSON.stringify(original[attribute] ?? null) === JSON.stringify(value)
			)
				continue;
			if (JSON.stringify(before[attribute] ?? null) !== JSON.stringify(value)) {
				updates[attribute] = value;
				hasUpdate = true;
			}
		}
		if (hasUpdate) {
			const group = JSON.stringify(updates);
			const existing = formatting.get(group);
			if (existing) existing.entries.push(entryId);
			else
				formatting.set(group, {
					entries: [entryId],
					attributes: prepareValue(updates).value as Attributes,
				});
		}
		after = entryId;
	}
	flushInsertion();
	for (const group of formatting.values())
		pushAttributeOps(operations, node.id, group.entries, group.attributes);
	if (trackHistory) return commitEditorOperations(context, operations);
	if (operations.length) {
		assertEditorPatchSize(model, operations);
		model.commit(operations);
	}
	return { inserted: [], deleted: [], attributes: [] };
}
// Entries have unique identities. An increasing subsequence keeps unchanged
// entries in O(n log n), including large documents and multi-step transactions.
export function matchTokens(
	before: string[],
	after: string[],
): Map<number, number> {
	const result = new Map<number, number>();
	let start = 0,
		oldEnd = before.length,
		newEnd = after.length;
	while (start < oldEnd && start < newEnd && before[start] === after[start]) {
		result.set(start, start);
		start++;
	}
	while (
		oldEnd > start &&
		newEnd > start &&
		before[oldEnd - 1] === after[newEnd - 1]
	)
		result.set(--newEnd, --oldEnd);
	const positions = new Map<string, number>();
	for (let i = start; i < oldEnd; i++)
		if (!positions.has(before[i]!)) positions.set(before[i]!, i);
	const candidates: { old: number; next: number; previous: number }[] = [],
		tails: number[] = [];
	for (let next = start; next < newEnd; next++) {
		const old = positions.get(after[next]!);
		if (old === undefined) continue;
		let low = 0,
			high = tails.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (candidates[tails[mid]!]!.old < old) low = mid + 1;
			else high = mid;
		}
		candidates.push({ old, next, previous: low ? tails[low - 1]! : -1 });
		tails[low] = candidates.length - 1;
	}
	for (
		let index = tails.at(-1) ?? -1;
		index >= 0;
		index = candidates[index]!.previous
	) {
		const candidate = candidates[index]!;
		result.set(candidate.next, candidate.old);
	}
	return result;
}
