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
	type Command,
} from "prosemirror-state";
import { Mapping } from "prosemirror-transform";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import {
	joinPresence,
	RichTextSelection,
	type Presence,
	type Pulse,
	type RichText,
} from "pulsify-core";
import {
	richTextContext,
	createPulsifyHistory,
	connectEditorHistory,
	heldSelections,
	type PulsifyHistory,
	type PulsifyHistoryOptions,
} from "pulsify-core/bindings";
import {
	anchorOfPosition,
	matchTokens,
	positionOfAnchor,
	readDocument,
	writeDocument,
	type DocumentView,
	type Token,
} from "./document.js";

export {
	createPulsifyHistory,
	type PulsifyHistory,
	type PulsifyHistoryOptions,
} from "pulsify-core/bindings";

const historyKey = new PluginKey<PulsifyHistory>("pulsifyHistory");
/** Pulsify history commands for ProseMirror keymaps and toolbar buttons. */
export const undo: Command = (state, dispatch) => {
	const history = historyKey.getState(state);
	return !!history && (dispatch ? history.undo() : history.canUndo);
};
export const redo: Command = (state, dispatch) => {
	const history = historyKey.getState(state);
	return !!history && (dispatch ? history.redo() : history.canRedo);
};

export interface ProseMirrorBindingOptions extends PulsifyHistoryOptions {
	/** A history plugin created by either editor package. Defaults to a fresh plugin. */
	history?: PulsifyHistory;
	/** Receive asynchronous synchronization errors. The binding disconnects on error. */
	onError?: (error: unknown) => void;
	/**
	 * Share my selection through presence and draw the caret and selected range of
	 * every other peer in this field. `true` shares without a name.
	 * `draw: false` shares mine and draws nothing. Mine is shared while the
	 * editor has the focus. A peer without a color gets one from its peer number.
	 */
	selection?: boolean | { name?: string; color?: string; draw?: boolean };
}
export interface ProseMirrorBinding {
	readonly history: PulsifyHistory;
	undo(): boolean;
	redo(): boolean;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	/** Disconnect without destroying the editor or the pulse. */
	destroy(): void;
	/**
	 * A document position as a string that follows it through every local and
	 * remote edit. It names the entry before the position, so text another peer
	 * inserts exactly there lands after it, and it is interchangeable with the
	 * anchors of `field.anchorAt`. A position between two blocks gives the anchor
	 * of the end of the block before it. Throws a RangeError for a position
	 * outside the document, and a TypeError once the binding or its editor is
	 * destroyed.
	 */
	anchorAt(position: number): string;
	/**
	 * Where an anchor is now; where its character was once it is deleted.
	 * Undefined for an anchor of another field or of an entry not received yet,
	 * and for any anchor once the binding or its editor is destroyed.
	 */
	positionOf(anchor: string): number | undefined;
}
/** The state of the `RichTextSelection` channel. */
type SharedSelection = {
	anchor: string;
	head: string;
	name: string;
	color: string;
};
const bindings = new WeakMap<EditorView, ProseMirrorBinding>();
/** The binding that last shared a selection on each pulse, by its token. */
const publishers = new WeakMap<object, object>();

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
	const history = options.history ?? createPulsifyHistory(options);
	const schema = view.state.schema;
	const sharing =
		options.selection === true ? {} : options.selection || undefined;
	for (const value of [sharing?.name, sharing?.color])
		if (value !== undefined && typeof value !== "string")
			throw new TypeError("A selection name and color must be strings");
	const draws = !!sharing && sharing.draw !== false;
	let rendered = readDocument(context, schema);
	let syncing = false,
		disposed = false;
	let unsubscribe: (() => void) | undefined;
	let pending = new Mapping();
	let capture = true,
		push = false,
		merge = false;
	const key = new PluginKey<DecorationSet>("pulsify");
	const release = () => {
		unsubscribe?.();
		unsubscribe = undefined;
	};
	let presence: Presence<SharedSelection> | undefined;
	let held:
		| ReturnType<typeof heldSelections<SharedSelection, [number, number]>>
		| undefined;
	let stopDrawing: (() => void) | undefined;
	let focused = false;
	const owner = {};
	// Presence only: sharing a selection never writes to the document.
	const publish = () => {
		if (!presence || !sharing || disposed || !focused) return;
		const { anchor, head } = view.state.selection;
		const size = rendered.doc.content.size;
		presence.set({
			anchor: anchorOfPosition(context, rendered, Math.min(anchor, size)),
			head: anchorOfPosition(context, rendered, Math.min(head, size)),
			name: sharing.name ?? "",
			color: sharing.color ?? "",
		});
		publishers.set(context.pulse as object, owner);
	};
	// A pulse has one selection per peer: another binding of the same pulse
	// may have shared its own since, and that one must stay.
	const withdraw = () => {
		if (publishers.get(context.pulse as object) !== owner) return;
		publishers.delete(context.pulse as object);
		presence?.set(undefined);
	};
	const decorate = (doc: ProseMirrorNode): DecorationSet => {
		if (!presence || disposed) return DecorationSet.empty;
		const size = doc.content.size;
		const decorations: Decoration[] = [];
		// A peer whose characters have not arrived yet keeps its last selection.
		for (const {
			peer,
			state,
			resolved: [anchor, head],
		} of held!.resolve(presence.others))
			decorations.push(
				...peerDecorations(
					doc,
					peer,
					state,
					Math.min(anchor, size),
					Math.min(head, size),
				),
			);
		return DecorationSet.create(doc, decorations);
	};
	// Redraw through a transaction that changes neither the document, the
	// selection, the scroll position nor the undo history.
	const redraw = () => {
		if (!draws || disposed || view.isDestroyed) return;
		const drawn = key.getState(view.state);
		if (!drawn || signature(drawn) === signature(decorate(view.state.doc)))
			return;
		view.dispatch(
			view.state.tr.setMeta(key, "selection").setMeta("addToHistory", false),
		);
	};
	// Set while this binding renders its own undo or redo.
	let replaying = false;
	const pull = () => {
		if (syncing || disposed || view.isDestroyed) return;
		try {
			richTextContext(field);
			history.stopCapturing();
			const next = readDocument(context, schema);
			const previous = rendered;
			rendered = next;
			if (view.state.doc.eq(next.doc)) {
				redraw();
				return;
			}
			syncing = true;
			const tr = replaceDocument(view.state, next.doc, previous, next);
			tr.setMeta(key, true).setMeta("addToHistory", false);
			tr.setSelection(
				mapSelection(
					view.state,
					previous,
					{ ...next, doc: tr.doc },
					tr.mapping,
					replaying,
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
	const historyConnection = connectEditorHistory(history, context, {
		flush() {
			if (view.isDestroyed) binding.destroy();
		},
		replay(action) {
			syncing = true;
			try {
				richTextContext(field);
				action();
			} finally {
				syncing = false;
			}
			replaying = true;
			try {
				pull();
			} finally {
				replaying = false;
			}
		},
	});
	const historyPlugin = new Plugin<PulsifyHistory>({
		key: historyKey,
		state: { init: () => history, apply: (_tr, value) => value },
	});
	const plugin = new Plugin<DecorationSet>({
		key,
		...(draws && {
			state: {
				init: (_config, state) =>
					state.doc.eq(rendered.doc)
						? decorate(state.doc)
						: DecorationSet.empty,
				apply(tr, drawn) {
					// A transaction of this binding, remote change or redraw: the
					// rendered document is current, so resolve every anchor again.
					if (tr.getMeta(key)) return decorate(tr.doc);
					// A local change moves what is drawn; update() below corrects it
					// once the field has the change.
					return tr.docChanged ? drawn.map(tr.mapping, tr.doc) : drawn;
				},
			},
		}),
		props: {
			...(draws && { decorations: (state) => key.getState(state) }),
			...(sharing && {
				handleDOMEvents: {
					focus() {
						focused = true;
						publish();
						return false;
					},
					blur() {
						focused = false;
						withdraw();
						return false;
					},
				},
			}),
		},
		appendTransaction(transactions) {
			if (!syncing)
				for (const tr of transactions)
					if (!tr.getMeta(key)) {
						if (tr.docChanged) {
							pending.appendMapping(tr.mapping);
							capture &&= tr.getMeta("addToHistory") !== false;
							push ||= tr.getMeta("pulsifyHistory") === "push";
							merge ||= tr.getMeta("pulsifyHistory") === "merge";
						} else if (tr.selectionSet) history.stopCapturing();
					}
			return null;
		},
		view() {
			if (!disposed) {
				unsubscribe = context.subscribe(pull);
				bindings.set(view, binding);
			}
			return {
				update(current, previousState) {
					const mapping = pending,
						record = { capture, push, merge };
					pending = new Mapping();
					capture = true;
					push = merge = false;
					if (disposed) return;
					if (!syncing && !current.state.doc.eq(previousState.doc))
						try {
							richTextContext(field);
							syncing = true;
							const change = writeDocument(
								context,
								current.state.doc,
								rendered,
								mapping,
								true,
							);
							rendered = readDocument(context, schema);
							historyConnection.record(change, record);
						} catch (error) {
							// Native quota/validation failures must not leave an editor
							// showing an edit which the field rejected atomically.
							current.updateState(previousState);
							throw error;
						} finally {
							syncing = false;
						}
					publish();
					redraw();
				},
				destroy() {
					release();
					if (bindings.get(view) === binding) bindings.delete(view);
					// Reconfiguring plugins also ends this plugin view; only the end
					// of the editor ends the binding and withdraws its selection.
					queueMicrotask(() => {
						if (view.isDestroyed) binding.destroy();
					});
				},
			};
		},
	});
	const binding: ProseMirrorBinding = {
		history,
		undo: () => history.undo(),
		redo: () => history.redo(),
		get canUndo() {
			return history.canUndo;
		},
		get canRedo() {
			return history.canRedo;
		},
		destroy() {
			if (disposed) return;
			disposed = true;
			historyConnection.destroy();
			release();
			stopDrawing?.();
			withdraw();
			held?.destroy();
			presence?.leave();
			presence = undefined;
			if (bindings.get(view) === binding) bindings.delete(view);
			if (!view.isDestroyed && view.state.plugins.includes(plugin))
				view.updateState(
					view.state.reconfigure({
						plugins: view.state.plugins.filter(
							(candidate) =>
								candidate !== plugin && candidate !== historyPlugin,
						),
					}),
				);
		},
		anchorAt(position) {
			if (disposed || view.isDestroyed)
				throw new TypeError("This ProseMirror binding has been destroyed");
			return anchorOfPosition(context, rendered, position);
		},
		positionOf(anchor) {
			if (disposed || view.isDestroyed) return undefined;
			return positionOfAnchor(context, rendered, anchor);
		},
	};
	try {
		// Establish stable anchors once, after the history plugin has connected.
		writeDocument(context, rendered.doc, rendered);
		rendered = readDocument(context, schema);
		if (sharing) {
			presence = joinPresence(context.pulse as Pulse<any>, RichTextSelection);
			held = heldSelections(
				context.pulse as Pulse<any>,
				(state: SharedSelection) => {
					const anchor = positionOfAnchor(context, rendered, state.anchor);
					const head = positionOfAnchor(context, rendered, state.head);
					// Another field, or a character that has not arrived yet.
					return anchor === undefined || head === undefined
						? undefined
						: ([anchor, head] as [number, number]);
				},
				() => redraw(),
			);
		}
		// Initialize outside plugin.view: dispatching during construction would
		// re-enter ProseMirror's plugin-view setup.
		view.updateState(
			view.state.reconfigure({
				plugins: [...view.state.plugins, historyPlugin, plugin],
			}),
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
		if (presence) {
			focused = view.hasFocus();
			publish();
			if (draws) stopDrawing = presence.subscribe(redraw);
		}
		return binding;
	} catch (error) {
		binding.destroy();
		throw error;
	}
}

/** A stable color for a peer that shares none: a hue from its number. */
const peerColor = (peer: number): string =>
	`hsl(${(peer * 137) % 360}, 70%, 45%)`;
// A color comes from another peer and goes into a style: it must not be able
// to end its declaration.
const safeColor = /^[#\w .,%()/-]{1,64}$/;

/** The caret of one peer at its head, and its selected range when it has one. */
function peerDecorations(
	doc: ProseMirrorNode,
	peer: number,
	state: SharedSelection,
	anchor: number,
	head: number,
): Decoration[] {
	const color = safeColor.test(state.color) ? state.color : peerColor(peer);
	const id = [peer, color, state.name];
	const decorations: Decoration[] = [];
	const from = Math.min(anchor, head),
		to = Math.max(anchor, head);
	if (from < to)
		decorations.push(
			Decoration.inline(
				from,
				to,
				{
					style: `background-color: color-mix(in srgb, ${color} 25%, transparent)`,
					"data-peer-selection": String(peer),
				},
				// An anchor follows the entry on its left, so text typed at the
				// start of the range is inside it and text typed at its end is not.
				{ inclusiveStart: true, id: ["range", ...id] },
			),
		);
	// A caret needs inline content: the start of the field and the position
	// after a leaf block are drawn in the nearest text block.
	let position = head;
	const $head = doc.resolve(head);
	if (!$head.parent.inlineContent) {
		const near =
			Selection.findFrom($head, 1, true) ?? Selection.findFrom($head, -1, true);
		if (near) position = near.head;
	}
	decorations.push(
		Decoration.widget(
			position,
			(view) => {
				const caret = view.dom.ownerDocument.createElement("span");
				caret.setAttribute("data-peer", String(peer));
				caret.style.cssText = `position: relative; margin: 0 -1px; border-left: 2px solid ${color}; word-break: normal; pointer-events: none;`;
				if (state.name) {
					const label = caret.appendChild(
						view.dom.ownerDocument.createElement("span"),
					);
					label.textContent = state.name;
					label.style.cssText = `position: absolute; bottom: 100%; left: -2px; padding: 0 4px; border-radius: 3px 3px 3px 0; background-color: ${color}; color: #fff; font: 600 11px/1.4 system-ui, sans-serif; white-space: nowrap; user-select: none;`;
				}
				return caret;
			},
			// On the left of text typed at its position, as its anchor is.
			{
				side: -1,
				key: `pulsify-caret/${id.join("/")}`,
				ignoreSelection: true,
				id: ["caret", ...id],
			},
		),
	);
	return decorations;
}
/** What a set draws, to redraw only when it changes. */
function signature(set: DecorationSet): string {
	return JSON.stringify(
		set
			.find()
			.map((decoration) => [decoration.from, decoration.to, decoration.spec.id])
			.sort(),
	);
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
	/** An undo or redo of this editor: what it restores at the cursor goes before it. */
	restoring = false,
): Selection {
	const byId = new Map(
		after.tokens
			.filter((token) => token.entry)
			.map((token) => [token.entry!.id, token]),
	);
	const kept = new Set(before.tokens.map((token) => token.entry?.id));
	const restored = new Map(
		after.tokens
			.filter((token) => token.entry && !kept.has(token.entry.id))
			.map((token) => [token.pos, token]),
	);
	const position = (pos: number): number => {
		let at = surviving(pos);
		if (restoring)
			for (let token; (token = restored.get(at));)
				at = token.pos + (token.size || 1);
		return at;
	};
	const surviving = (pos: number): number => {
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
