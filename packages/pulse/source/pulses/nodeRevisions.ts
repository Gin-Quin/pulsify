import type { CoreModel, CoreNode } from "../core/model.js";
import { ScalarPatch, type CorePatch } from "../core/operations.js";

const directRevisions = new WeakMap<CoreNode, number>();
const subtreeRevisions = new WeakMap<CoreNode, number>();
const proxyNodes = new WeakMap<object, CoreNode>();

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
	for (const op of patch.ops) {
		if (op.kind === 0 || op.kind === 10) continue;
		const node = model.index.get(op.target);
		if (node) bumpNodeRevision(node);
	}
}
