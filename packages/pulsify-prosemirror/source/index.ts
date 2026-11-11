import {
	Fragment,
	Mark,
	type Node as ProseMirrorNode,
	type Schema,
} from "prosemirror-model";
import {
	Plugin,
	PluginKey,
	TextSelection,
	NodeSelection,
	Selection,
	type EditorState,
} from "prosemirror-state";
import { Mapping } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import { type RichText } from "pulsify-core";
import { richTextContext } from "pulsify-core/bindings";
import {
	matchTokens,
	readDocument,
	writeDocument,
	type DocumentView,
	type Token,
} from "./document.js";

export interface ProseMirrorBindingOptions {
	/** Receive asynchronous synchronization errors. The binding disconnects on error. */
	onError?: (error: unknown) => void;
}
export interface ProseMirrorBinding {
	/** Disconnect without destroying the editor or the pulse. */
	destroy(): void;
}
const bindings = new WeakMap<EditorView, ProseMirrorBinding>();

/** Read a field as a ProseMirror document, including nodes, attributes and marks. */
export function proseMirrorDocument(
	field: RichText,
	schema: Schema,
): ProseMirrorNode {
	return readDocument(richTextContext(field), schema).doc;
}

/**
 * Link an existing EditorView to an attached richText field. The field supplies
 * the initial document. Existing plugins and dispatchTransaction are preserved.
 * Call destroy() to detach, or view.destroy() to dispose of the editor.
 */
export function bindProseMirror(
	view: EditorView,
	field: RichText,
	options: ProseMirrorBindingOptions = {},
): ProseMirrorBinding {
	if (view.isDestroyed)
		throw new TypeError("Cannot bind a destroyed ProseMirror editor");
	if (bindings.has(view))
		throw new TypeError("This ProseMirror editor is already bound");
	const context = richTextContext(field);
	const schema = view.state.schema;
	let rendered = readDocument(context, schema);
	// Establish stable anchors once, including for an initially empty field.
	writeDocument(context, rendered.doc, rendered);
	rendered = readDocument(context, schema);
	let syncing = false,
		disposed = false;
	let unsubscribe: (() => void) | undefined;
	let pending = new Mapping();
	const key = new PluginKey("pulsify");
	const release = () => {
		unsubscribe?.();
		unsubscribe = undefined;
	};
	const pull = () => {
		if (syncing || disposed || view.isDestroyed) return;
		try {
			richTextContext(field);
			const next = readDocument(context, schema);
			const previous = rendered;
			rendered = next;
			if (view.state.doc.eq(next.doc)) return;
			syncing = true;
			const tr = replaceDocument(view.state, next.doc, previous, next);
			tr.setMeta(key, true).setMeta("addToHistory", false);
			tr.setSelection(
				mapSelection(
					view.state,
					previous,
					{ ...next, doc: tr.doc },
					tr.mapping,
				),
			);
			view.dispatch(tr);
			if (!view.state.doc.eq(next.doc))
				throw new Error(
					"ProseMirror dispatchTransaction must synchronously apply Pulsify transactions without changing their document",
				);
		} catch (error) {
			binding.destroy();
			if (options.onError) options.onError(error);
			else throw error;
		} finally {
			syncing = false;
		}
	};
	const plugin = new Plugin({
		key,
		appendTransaction(transactions) {
			if (!syncing)
				for (const tr of transactions)
					if (tr.docChanged && !tr.getMeta(key))
						pending.appendMapping(tr.mapping);
			return null;
		},
		view() {
			if (!disposed) {
				unsubscribe = context.subscribe(pull);
				bindings.set(view, binding);
			}
			return {
				update(current, previousState) {
					const mapping = pending;
					pending = new Mapping();
					if (syncing || disposed || current.state.doc.eq(previousState.doc))
						return;
					try {
						richTextContext(field);
						syncing = true;
						writeDocument(context, current.state.doc, rendered, mapping);
						rendered = readDocument(context, schema);
					} catch (error) {
						// Native quota/validation failures must not leave an editor
						// showing an edit which the field rejected atomically.
						current.updateState(previousState);
						throw error;
					} finally {
						syncing = false;
					}
				},
				destroy() {
					release();
					if (bindings.get(view) === binding) bindings.delete(view);
				},
			};
		},
	});
	const binding: ProseMirrorBinding = {
		destroy() {
			if (disposed) return;
			disposed = true;
			release();
			if (bindings.get(view) === binding) bindings.delete(view);
			if (!view.isDestroyed && view.state.plugins.includes(plugin))
				view.updateState(
					view.state.reconfigure({
						plugins: view.state.plugins.filter(
							(candidate) => candidate !== plugin,
						),
					}),
				);
		},
	};
	try {
		// Initialize outside plugin.view: dispatching during construction would
		// re-enter ProseMirror's plugin-view setup.
		view.updateState(
			view.state.reconfigure({ plugins: [...view.state.plugins, plugin] }),
		);
		bindings.set(view, binding);
		if (!view.state.doc.eq(rendered.doc)) {
			syncing = true;
			view.dispatch(
				replaceDocument(view.state, rendered.doc)
					.setMeta(key, true)
					.setMeta("addToHistory", false),
			);
			if (!view.state.doc.eq(rendered.doc))
				throw new Error(
					"ProseMirror dispatchTransaction must synchronously apply Pulsify transactions without changing their document",
				);
			syncing = false;
		}
		return binding;
	} catch (error) {
		binding.destroy();
		throw error;
	}
}

function replaceDocument(
	state: EditorState,
	doc: ProseMirrorNode,
	previous?: DocumentView,
	next?: DocumentView,
) {
	const tr = state.tr;
	// Diff content independently of marks/attributes. Replacing unchanged text
	// merely to add a mark would discard history maps for local insertions.
	const attributes = new Map<string, ProseMirrorNode["attrs"]>();
	for (const root of [state.doc, doc]) {
		if (!attributes.has(root.type.name))
			attributes.set(root.type.name, root.attrs);
		root.descendants((node) => {
			if (!attributes.has(node.type.name))
				attributes.set(node.type.name, node.attrs);
		});
	}
	const contentOnly = (node: ProseMirrorNode): ProseMirrorNode => {
		if (node.isText) return node.mark(Mark.none);
		const children: ProseMirrorNode[] = [];
		node.forEach((child) => children.push(contentOnly(child)));
		return node.type.create(
			attributes.get(node.type.name),
			Fragment.fromArray(children),
		);
	};
	const before = contentOnly(state.doc),
		after = contentOnly(doc);
	const sameStructure =
		previous &&
		next &&
		previous.nodes.length === next.nodes.length &&
		previous.nodes.every(
			(span, index) =>
				span.id === next.nodes[index]!.id &&
				span.node.type === next.nodes[index]!.node.type,
		);
	if (sameStructure) {
		const edits: { from: number; to: number; start: number; end: number }[] =
			[];
		const groupTokens = (rendered: DocumentView) => {
			const blocks = rendered.nodes.filter((span) => span.node.isTextblock);
			const groups = new Map<string, Token[]>();
			let index = 0;
			for (const token of rendered.tokens) {
				if (!token.entry || token.size <= 0) continue;
				while (
					blocks[index] &&
					token.pos >= blocks[index]!.pos + blocks[index]!.node.nodeSize - 1
				)
					index++;
				const block = blocks[index];
				if (!block || token.pos <= block.pos) continue;
				const group = groups.get(block.id);
				if (group) group.push(token);
				else groups.set(block.id, [token]);
			}
			return groups;
		};
		const beforeGroups = groupTokens(previous),
			afterGroups = groupTokens(next);
		for (let index = 0; index < previous.nodes.length; index++) {
			const oldBlock = previous.nodes[index]!,
				newBlock = next.nodes[index]!;
			if (!oldBlock.node.isTextblock) continue;
			const oldTokens = beforeGroups.get(oldBlock.id) ?? [];
			const newTokens = afterGroups.get(newBlock.id) ?? [];
			const matches = [
				...matchTokens(
					oldTokens.map((token) => token.entry!.id),
					newTokens.map((token) => token.entry!.id),
				),
			].sort(([a], [b]) => a - b);
			let from = oldBlock.pos + 1,
				start = newBlock.pos + 1;
			for (const [newIndex, oldIndex] of [
				...matches,
				[newTokens.length, oldTokens.length],
			]) {
				const oldToken = oldTokens[oldIndex!],
					newToken = newTokens[newIndex!];
				const to = oldToken?.pos ?? oldBlock.pos + oldBlock.node.nodeSize - 1;
				const end = newToken?.pos ?? newBlock.pos + newBlock.node.nodeSize - 1;
				if (!before.slice(from, to).eq(after.slice(start, end)))
					edits.push({ from, to, start, end });
				from = to + (oldToken?.size ?? 0);
				start = end + (newToken?.size ?? 0);
			}
		}
		for (const edit of edits.sort((a, b) => b.from - a.from))
			tr.replace(edit.from, edit.to, doc.slice(edit.start, edit.end));
	} else {
		const start = before.content.findDiffStart(after.content);
		if (start !== null) {
			const end = before.content.findDiffEnd(after.content)!;
			const overlap = start - Math.min(end.a, end.b);
			tr.replace(
				start,
				end.a + Math.max(0, overlap),
				doc.slice(start, end.b + Math.max(0, overlap)),
			);
		}
	}
	doc.descendants((node, pos) => {
		if (node.isText) {
			let equal = true;
			tr.doc.nodesBetween(pos, pos + node.nodeSize, (current) => {
				if (current.isText && !Mark.sameSet(current.marks, node.marks))
					equal = false;
			});
			if (!equal) {
				tr.removeMark(pos, pos + node.nodeSize);
				for (const mark of node.marks)
					tr.addMark(pos, pos + node.nodeSize, mark);
			}
		} else {
			const current = tr.doc.nodeAt(pos)!;
			if (
				JSON.stringify(current.attrs) !== JSON.stringify(node.attrs) ||
				!Mark.sameSet(current.marks, node.marks)
			)
				tr.setNodeMarkup(pos, undefined, node.attrs, node.marks);
		}
	});
	for (const [name, value] of Object.entries(doc.attrs))
		if (JSON.stringify(state.doc.attrs[name]) !== JSON.stringify(value))
			tr.setDocAttribute(name, value);
	return tr;
}

// Native entries count code points; ProseMirror positions count UTF-16 units.
// Anchor selections to surviving entries before falling back to step mapping.
function mapSelection(
	state: EditorState,
	before: DocumentView,
	after: DocumentView,
	mapping: Mapping,
): Selection {
	const byId = new Map(
		after.tokens
			.filter((token) => token.entry)
			.map((token) => [token.entry!.id, token]),
	);
	const position = (pos: number): number => {
		const block = before.nodes.find(
			(span) =>
				span.node.isTextblock &&
				span.pos < pos &&
				span.pos + span.node.nodeSize - 1 >= pos,
		);
		const inBlock = (token: Token) =>
			!block ||
			(token.pos > block.pos &&
				token.pos < block.pos + block.node.nodeSize - 1);
		const left = before.tokens.findLast(
			(token) =>
				token.entry &&
				token.size > 0 &&
				token.pos + token.size <= pos &&
				inBlock(token),
		);
		const right = before.tokens.find(
			(token) =>
				token.entry && token.size > 0 && token.pos >= pos && inBlock(token),
		);
		const survivingLeft = left?.entry && byId.get(left.entry.id);
		const survivingRight = right?.entry && byId.get(right.entry.id);
		if (survivingLeft) return survivingLeft.pos + survivingLeft.size;
		if (survivingRight) return survivingRight.pos;
		const nextBlock = block && after.nodes.find((span) => span.id === block.id);
		if (nextBlock)
			return (
				nextBlock.pos +
				1 +
				Math.min(pos - block!.pos - 1, nextBlock.node.content.size)
			);
		return Math.max(0, Math.min(after.doc.content.size, mapping.map(pos)));
	};
	if (state.selection instanceof NodeSelection) {
		const oldNode = before.nodes.find(
			(span) => span.pos === state.selection.from,
		);
		const next = oldNode && after.nodes.find((span) => span.id === oldNode.id);
		if (next && NodeSelection.isSelectable(next.node))
			return NodeSelection.create(after.doc, next.pos);
	}
	if (state.selection instanceof TextSelection) {
		const anchor = after.doc.resolve(position(state.selection.anchor));
		const head = after.doc.resolve(position(state.selection.head));
		return TextSelection.between(anchor, head);
	}
	return state.selection.map(after.doc, mapping);
}
