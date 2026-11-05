import type { CoreEntry, Stamp } from "./model.js";
import type { CoreOperation } from "./operations.js";
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
	}[];
};

/** Capture only touched entries, so history costs scale with the edit. */
export function commitEditorOperations(
	context: RichTextContext,
	operations: CoreOperation[],
): EditorChange {
	const { node, model } = context;
	const change: EditorChange = { inserted: [], deleted: [], attributes: [] };
	if (!operations.length) return change;
	const updates = new Map<
		string,
		{
			entry: string;
			key: string;
			before: unknown;
			after: unknown;
			stamp: Stamp;
		}
	>();
	let serial = 0;
	for (const op of operations) {
		if (op.kind === 3) {
			for (const id of op.deletes)
				if (!node.entries.get(id)?.deleted) change.deleted.push(id);
			for (const _ of op.values)
				change.inserted.push(`${model.sid}:${model.nextClock}:${serial++}`);
		} else if (op.kind === 5) {
			for (const id of op.entries) {
				const entry = node.entries.get(id);
				if (!entry) continue; // Attributes of a new entry travel with its undo/redo.
				for (const [key, after] of Object.entries(op.attributes)) {
					const identity = JSON.stringify([id, key]);
					const previous = updates.get(identity);
					updates.set(identity, {
						entry: id,
						key,
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
	const { node, model } = context;
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
	if (deletes.length)
		operations.push({
			kind: 3,
			target: node.id,
			after: "",
			deletes,
			values: [],
		});
	for (const id of deletes)
		if (isRichTextNode(node.entries.get(id)!)) {
			let attributes = updates.get(id);
			if (!attributes) updates.set(id, (attributes = {}));
			attributes[RT_REMOVED] = true;
		}
	let serial = 0;
	for (const id of change.deleted) {
		const entry = node.entries.get(id);
		if (!entry?.deleted) continue;
		const restored = `${model.sid}:${model.nextClock}:${serial++}`;
		const attributes = { ...editorAttributes(entry), ...updates.get(id) };
		// Insert at the original tombstone so unseen children retain their order.
		operations.push({
			kind: 3,
			target: node.id,
			after: id,
			deletes: [],
			values: [{ value: entry.value, constants: [], texts: [] }],
		});
		if (isRichTextNode(entry)) attributes[RT_REMOVED] = null;
		operations.push({
			kind: 5,
			target: node.id,
			entries: [restored],
			attributes: prepareValue(attributes).value as Attributes,
		});
	}
	for (const [entry, attributes] of updates)
		operations.push({
			kind: 5,
			target: node.id,
			entries: [entry],
			attributes: prepareValue(attributes).value as Attributes,
		});
	return commitEditorOperations(context, operations);
}
export function editorAttributes(entry: CoreEntry): Attributes {
	return Object.fromEntries(
		[...entry.marks]
			.filter(([, mark]) => mark.value != null)
			.map(([key, mark]) => [key, mark.value]),
	);
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
	if (deletes.length)
		operations.push({
			kind: 3,
			target: node.id,
			after: "",
			deletes,
			values: [],
		});
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
		operations.push({
			kind: 5,
			target: node.id,
			entries: removedAnchors.map((entry) => entry.id),
			attributes: { [RT_REMOVED]: true },
		});
	operations.push(...extraOperations);
	let after = "",
		entrySerial = 0;
	let insertion: Extract<CoreOperation, { kind: 3 }> | undefined;
	const formatting = new Map<
		string,
		{ entries: string[]; attributes: Attributes }
	>();
	for (let i = 0; i < desired.length; i++) {
		const token = desired[i]!,
			oldIndex = matches.get(i);
		const entry = oldIndex === undefined ? undefined : old[oldIndex];
		const entryId =
			entry?.id ?? `${model.sid}:${model.nextClock}:${entrySerial++}`;
		if (!entry) {
			if (!insertion)
				operations.push(
					(insertion = {
						kind: 3,
						target: node.id,
						after,
						deletes: [],
						values: [],
					}),
				);
			insertion.values.push({ value: token.value, constants: [], texts: [] });
		} else insertion = undefined;
		const before = entry ? editorAttributes(entry) : {};
		const original =
			baseline && entry
				? previous.get(
						token.attributes[RT_NODE]
							? `node:${token.attributes[RT_NODE]}`
							: `char:${entry.id}`,
					)
				: undefined;
		const updates: Attributes = {};
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
			if (JSON.stringify(before[attribute] ?? null) !== JSON.stringify(value))
				updates[attribute] = value;
		}
		if (Object.keys(updates).length) {
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
	for (const group of formatting.values())
		operations.push({ kind: 5, target: node.id, ...group });
	if (trackHistory) return commitEditorOperations(context, operations);
	if (operations.length) model.commit(operations);
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
