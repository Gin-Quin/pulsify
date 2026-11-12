import type { CoreEntry, CoreModel, CoreNode, Stamp } from "./model.js";
import type { RichText } from "./richText.js";

// The optional editor adapter uses ordinary character/attribute operations. These
// reserved attributes keep its structural anchors out of the plain text API.
// Preserve the original wire namespace for existing documents. Both adapters
// use these editor-independent anchors; RT_FORMAT identifies the document model.
export const RT_FORMAT = "$pulsify:pm:format";
export const RT_PREFIX = "$pulsify:pm:";
export const RT_NODE: string = `${RT_PREFIX}node`;
export const RT_PARENT: string = `${RT_PREFIX}parent`;
export const RT_TYPE: string = `${RT_PREFIX}type`;
export const RT_REDIRECT: string = `${RT_PREFIX}redirect`;
export const RT_REMOVED: string = `${RT_PREFIX}removed`;
export const RT_ATTR: string = `${RT_PREFIX}attr:`;
export const RT_MARK: string = `${RT_PREFIX}mark:`;
export const RT_TEXTBLOCK: string = `${RT_PREFIX}textblock`;

export type RichTextContext = {
	node: CoreNode;
	model: CoreModel;
	assertActive(): void;
	subscribe(listener: () => void): () => void;
	/** The pulse that holds the field, for a binding that shares presence on it. */
	readonly pulse: unknown;
};
export const richTextContexts = new WeakMap<RichText, RichTextContext>();
const anchors = new WeakMap<CoreNode, Set<CoreEntry>>();
/** Called by native replay, so peers without an editor retain the text projection. */
export function trackRichTextAnchor(node: CoreNode, entry: CoreEntry): void {
	let entries = anchors.get(node);
	if (!entries) anchors.set(node, (entries = new Set()));
	if (isRichTextNode(entry)) entries.add(entry);
	else entries.delete(entry);
}
export function richTextContext(field: RichText): RichTextContext {
	const context = richTextContexts.get(field);
	if (!context) throw new TypeError("Bind an attached Pulsify richText field");
	context.assertActive();
	if (!context.model.isAttached(context.node))
		throw new TypeError("This pulse rich text has been replaced or removed");
	return context;
}
export function isRichTextNode(entry: CoreEntry): boolean {
	return typeof entry.marks.get(RT_NODE)?.value === "string";
}
export function newerTextStamp(a: Stamp, b: Stamp): boolean {
	return (
		a[0] > b[0] ||
		(a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))
	);
}
export function richTextRedirects(node: CoreNode): Map<string, string> {
	const result = new Map<string, string>(),
		stamps = new Map<string, Stamp>();
	for (const entry of anchors.get(node) ?? []) {
		const id = entry.marks.get(RT_NODE)?.value,
			redirect = entry.marks.get(RT_REDIRECT);
		if (typeof id === "string" && typeof redirect?.value === "string") {
			const previous = stamps.get(id);
			if (!previous || newerTextStamp(redirect.stamp, previous)) {
				result.set(id, redirect.value);
				stamps.set(id, redirect.stamp);
			}
		}
	}
	return result;
}
export function richTextRemovedNodes(node: CoreNode): Set<string> {
	const result = new Set<string>();
	for (const entry of anchors.get(node) ?? []) {
		const id = entry.marks.get(RT_NODE)?.value;
		if (typeof id === "string" && entry.marks.get(RT_REMOVED)?.value === true)
			result.add(id);
	}
	return result;
}
export function richTextEntries(node: CoreNode): CoreEntry[] {
	const structural = anchors.get(node);
	if (!structural) return node.visible;
	const parents = new Map<string, string>(),
		redirects = richTextRedirects(node),
		removed = richTextRemovedNodes(node),
		stamps = new Map<string, Stamp>();
	for (const entry of structural) {
		if (entry.deleted) continue;
		const id = entry.marks.get(RT_NODE)?.value;
		const parent = entry.marks.get(RT_PARENT);
		if (typeof id === "string" && parent && !removed.has(id)) {
			const previous = stamps.get(id);
			if (!previous || newerTextStamp(parent.stamp, previous)) {
				parents.set(id, String(parent.value));
				stamps.set(id, parent.stamp);
			}
		}
	}
	const live = new Map<string, boolean>();
	const attached = (id: string): boolean => {
		if (!id) return true;
		if (live.has(id)) return live.get(id)!;
		live.set(id, false); // Also breaks malformed parent cycles.
		const parent = redirects.get(id) ?? parents.get(id);
		const result = parent !== undefined && attached(parent);
		live.set(id, result);
		return result;
	};
	return node.visible.filter(
		(entry) =>
			!isRichTextNode(entry) &&
			attached(String(entry.marks.get(RT_PARENT)?.value ?? "")),
	);
}
/**
 * Where an anchor is now: the nearest surviving entry at or before the one it
 * names, character or structural; `null` at the start of the field;
 * `undefined` for an anchor of another field or of an entry not received yet.
 * An anchor is the ID of the entry before a position, or the field's own ID
 * for its start, so it follows that entry through every edit.
 */
// ponytail: O(length) per anchor; index the sequence if documents with many anchors need it.
export function resolveRichTextAnchor(
	node: CoreNode,
	anchor: string,
): CoreEntry | null | undefined {
	if (anchor === node.id) return null;
	const entry = node.entries.get(anchor);
	if (!entry) return undefined;
	if (!entry.deleted) return entry;
	for (let i = node.order.indexOf(entry) - 1; i >= 0; i--)
		if (!node.order[i]!.deleted) return node.order[i]!;
	return null;
}
export function richTextContent(node: CoreNode): string {
	if (!anchors.has(node)) return node.data.join("");
	return richTextEntries(node)
		.map((entry) => entry.value as string)
		.join("");
}
