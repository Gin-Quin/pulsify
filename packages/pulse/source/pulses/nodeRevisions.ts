import type { CoreEntry, CoreModel, CoreNode } from "../core/model.js";
import { ScalarPatch, type CorePatch } from "../core/operations.js";

const directRevisions = new WeakMap<CoreNode, number>();
const subtreeRevisions = new WeakMap<CoreNode, number>();
const proxyNodes = new WeakMap<object, CoreNode>();

export type TextChange = {
	readonly rev: number;
	readonly structural: boolean;
	readonly inserted: readonly CoreEntry[];
	readonly deleted: readonly CoreEntry[];
	readonly marked: readonly CoreEntry[];
};

type PendingTextChange = {
	structural: boolean;
	inserted: CoreEntry[];
	deleted: CoreEntry[];
	marked: CoreEntry[];
};

const MAX_TEXT_HISTORY = 64;
const MAX_TRACKED_ENTRIES = 256;
const pendingTextChanges = new WeakMap<CoreNode, PendingTextChange>();
const textHistory = new WeakMap<CoreNode, TextChange[]>();

/** Record entries touched on a text node during `model.apply`, before revision bump. */
export function recordTextChange(
	node: CoreNode,
	structural: boolean,
	inserted: readonly CoreEntry[],
	deleted: readonly CoreEntry[],
	marked: readonly CoreEntry[],
): void {
	let pending = pendingTextChanges.get(node);
	if (!pending) {
		pending = { structural: false, inserted: [], deleted: [], marked: [] };
		pendingTextChanges.set(node, pending);
	}
	if (structural) {
		pending.structural = true;
		pending.inserted.length = 0;
		pending.deleted.length = 0;
		pending.marked.length = 0;
		return;
	}
	if (pending.structural) return;
	if (
		pending.inserted.length +
			pending.deleted.length +
			pending.marked.length +
			inserted.length +
			deleted.length +
			marked.length >
		MAX_TRACKED_ENTRIES
	) {
		pending.structural = true;
		pending.inserted.length = 0;
		pending.deleted.length = 0;
		pending.marked.length = 0;
		return;
	}
	for (let i = 0; i < inserted.length; i++) pending.inserted.push(inserted[i]!);
	for (let i = 0; i < deleted.length; i++) pending.deleted.push(deleted[i]!);
	for (let i = 0; i < marked.length; i++) pending.marked.push(marked[i]!);
}

/**
 * Changes to a text node after `sinceRev` up to its current revision.
 * Returns `undefined` if history was truncated or revision is out of range.
 */
export function textChangesSince(
	node: CoreNode,
	sinceRev: number,
): readonly TextChange[] | undefined {
	const current = directRevisions.get(node) ?? 0;
	if (sinceRev === current) return [];
	if (sinceRev > current) return undefined;
	const log = textHistory.get(node);
	if (!log || !log.length) return undefined;
	const first = log[0]!;
	if (first.rev > sinceRev + 1) return undefined;
	const last = log[log.length - 1]!;
	if (last.rev !== current) return undefined;
	// Find first entry with rev > sinceRev.
	let start = 0;
	while (start < log.length && log[start]!.rev <= sinceRev) start++;
	return start === 0 ? log : log.slice(start);
}

/** Associate a collaborative proxy with its underlying model node. */
export function registerNodeProxy(proxy: object, node: CoreNode): void {
	proxyNodes.set(proxy, node);
}

/** Direct mutation counter for one node (ignores mutations to descendants). */
export function directNodeRevision(node: CoreNode): number {
	return directRevisions.get(node) ?? 0;
}

/** Subtree mutation counter for a proxy's node, or undefined if unattached. */
export function nodeRevision(proxy: object): number | undefined {
	const node = proxyNodes.get(proxy);
	return node ? (subtreeRevisions.get(node) ?? 0) : undefined;
}

/** Record a mutation to `node` and propagate to its ancestors. */
export function bumpNodeRevision(node: CoreNode): void {
	directRevisions.set(node, (directRevisions.get(node) ?? 0) + 1);
	for (
		let current: CoreNode | undefined = node;
		current;
		current = current.parent
	)
		subtreeRevisions.set(current, (subtreeRevisions.get(current) ?? 0) + 1);
}

/** Record mutations applied by `patch` for every targeted node. */
export function bumpPatchRevisions(model: CoreModel, patch: CorePatch): void {
	if (patch instanceof ScalarPatch) {
		const node = model.index.get(patch.target);
		if (node) bumpNodeRevision(node);
		return;
	}
	let touchedText: CoreNode | undefined;
	let touchedTexts: Set<CoreNode> | undefined;
	for (const op of patch.ops) {
		if (op.kind === 0 || op.kind === 10) continue;
		const node = model.index.get(op.target);
		if (!node) continue;
		if (node.kind === "text") {
			if (touchedTexts) touchedTexts.add(node);
			else if (!touchedText) touchedText = node;
			else if (touchedText !== node)
				touchedTexts = new Set([touchedText, node]);
		} else {
			bumpNodeRevision(node);
		}
	}
	const finalizeText = (node: CoreNode) => {
		bumpNodeRevision(node);
		const rev = directRevisions.get(node)!;
		const pending = pendingTextChanges.get(node);
		pendingTextChanges.delete(node);
		let log = textHistory.get(node);
		if (!log) textHistory.set(node, (log = []));
		log.push(
			pending
				? {
						rev,
						structural: pending.structural,
						inserted: pending.inserted,
						deleted: pending.deleted,
						marked: pending.marked,
					}
				: {
						rev,
						structural: true,
						inserted: [],
						deleted: [],
						marked: [],
					},
		);
		if (log.length > MAX_TEXT_HISTORY)
			log.splice(0, log.length - MAX_TEXT_HISTORY);
	};
	if (touchedTexts) {
		for (const node of touchedTexts) finalizeText(node);
	} else if (touchedText) {
		finalizeText(touchedText);
	}
}
