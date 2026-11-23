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
	RT_PARENT,
	directNodeRevision,
	insertBlockEntry,
	richTextContext,
	richTextRedirects,
	richTextRemovedNodes,
	createPulsifyHistory,
	connectEditorHistory,
	heldSelections,
	textChangesSince,
	type CoreEntry,
	type PulsifyHistory,
	type PulsifyHistoryOptions,
} from "pulsify-core/bindings";
import {
	anchorOfPosition,
	buildSimpleBlockNode,
	ensureFullView,
	findBlockIndex,
	matchTokens,
	positionOfAnchor,
	readDocument,
	writeDocument,
	writeIncrementalLocal,
	type BlockInfo,
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
	let renderedRev = directNodeRevision(context.node);
	let syncing = false,
		disposed = false,
		redrawQueued = false;
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
	// Schedule redraw outside plugin view `update` to avoid re-entering `updateState`.
	const scheduleRedraw = () => {
		if (!draws || redrawQueued || disposed || view.isDestroyed) return;
		redrawQueued = true;
		queueMicrotask(() => {
			redrawQueued = false;
			redraw();
		});
	};
	// Set while this binding renders its own undo or redo.
	let replaying = false;
	const tryIncrementalRemote = (currentRev: number): boolean => {
		const changes = textChangesSince(context.node, renderedRev);
		if (!changes || !changes.length) return false;
		for (let i = 0; i < changes.length; i++) {
			if (changes[i]!.structural) return false;
		}
		const redirects = richTextRedirects(context.node);
		const removed = richTextRemovedNodes(context.node);
		const affected = new Map<
			number,
			{ block: BlockInfo; inserted: CoreEntry[] }
		>();
		const touch = (entry: CoreEntry) => {
			const parentId = entry.marks.get(RT_PARENT)?.value;
			if (typeof parentId !== "string") return undefined;
			if (redirects.has(parentId) || removed.has(parentId)) return undefined;
			const idx = rendered.byId.get(parentId);
			if (idx === undefined) return undefined;
			let info = affected.get(idx);
			if (info) return info;
			const block = rendered.blocks[idx]!;
			if (!block.simple || !block.anchor || block.anchor.deleted)
				return undefined;
			info = { block, inserted: [] };
			affected.set(idx, info);
			return info;
		};
		for (let i = 0; i < changes.length; i++) {
			const change = changes[i]!;
			for (let j = 0; j < change.deleted.length; j++) {
				if (!touch(change.deleted[j]!)) return false;
			}
			for (let j = 0; j < change.inserted.length; j++) {
				const entry = change.inserted[j]!;
				if (entry.deleted) continue;
				const info = touch(entry);
				if (!info) return false;
				info.inserted.push(entry);
			}
			for (let j = 0; j < change.marked.length; j++) {
				const entry = change.marked[j]!;
				if (entry.deleted) continue;
				if (!touch(entry)) return false;
			}
		}
		if (!affected.size) {
			renderedRev = currentRev;
			redraw();
			return true;
		}
		const ordered = [...affected.entries()].sort(([a], [b]) => a - b);
		const plans: {
			idx: number;
			block: BlockInfo;
			oldNode: ProseMirrorNode;
			oldPos: number;
			oldChars: CoreEntry[];
			newChars: CoreEntry[];
			newNode: ProseMirrorNode;
		}[] = [];
		for (let p = 0; p < ordered.length; p++) {
			const [idx, { block, inserted }] = ordered[p]!;
			const anchor = block.anchor!;
			const oldChars = block.chars;
			const newChars: CoreEntry[] = [];
			for (let i = 0; i < oldChars.length; i++) {
				const e = oldChars[i]!;
				if (!e.deleted) newChars.push(e);
			}
			const present = new Set<CoreEntry>(newChars);
			for (let j = 0; j < inserted.length; j++) {
				if (
					!insertBlockEntry(newChars, present, anchor, inserted[j]!, block.id)
				)
					return false;
			}
			const newNode = buildSimpleBlockNode(schema, block.node, newChars);
			plans.push({
				idx,
				block,
				oldNode: block.node,
				oldPos: block.pos,
				oldChars,
				newChars,
				newNode,
			});
		}

		// Build targeted ProseMirror transaction touching ONLY the affected blocks.
		const tr = view.state.tr;
		const edits: {
			from: number;
			to: number;
			newNode: ProseMirrorNode;
			start: number;
			end: number;
		}[] = [];
		for (let p = 0; p < plans.length; p++) {
			const { oldNode, oldPos, oldChars, newChars, newNode } = plans[p]!;
			if (oldNode.eq(newNode)) continue;
			const oldIds = oldChars.map((e) => e.id);
			const newIds = newChars.map((e) => e.id);
			const matches = [...matchTokens(oldIds, newIds)].sort(
				([a], [b]) => a - b,
			);
			// Precompute UTF-16 offsets inside oldNode and newNode.
			const oldOffsets = new Array<number>(oldChars.length + 1);
			let off = 0;
			for (let i = 0; i < oldChars.length; i++) {
				oldOffsets[i] = off;
				off += (oldChars[i]!.value as string).length;
			}
			oldOffsets[oldChars.length] = off;
			const newOffsets = new Array<number>(newChars.length + 1);
			off = 0;
			for (let i = 0; i < newChars.length; i++) {
				newOffsets[i] = off;
				off += (newChars[i]!.value as string).length;
			}
			newOffsets[newChars.length] = off;

			let from = 0,
				start = 0;
			for (const [newIndex, oldIndex] of [
				...matches,
				[newChars.length, oldChars.length],
			] as [number, number][]) {
				const to = oldOffsets[oldIndex]!;
				const end = newOffsets[newIndex]!;
				if (from !== to || start !== end) {
					edits.push({
						from: oldPos + 1 + from,
						to: oldPos + 1 + to,
						newNode,
						start,
						end,
					});
				}
				from = oldIndex < oldChars.length ? oldOffsets[oldIndex + 1]! : to;
				start = newIndex < newChars.length ? newOffsets[newIndex + 1]! : end;
			}
		}
		// Apply text replacements from back to front so earlier positions stay valid.
		for (let i = edits.length - 1; i >= 0; i--) {
			const edit = edits[i]!;
			tr.replace(edit.from, edit.to, edit.newNode.slice(edit.start, edit.end));
		}
		// Apply mark diffs ONLY inside the affected blocks.
		let runningDelta = 0;
		for (let p = 0; p < plans.length; p++) {
			const plan = plans[p]!;
			const blockStart = plan.oldPos + runningDelta + 1;
			runningDelta += plan.newNode.nodeSize - plan.oldNode.nodeSize;
			plan.newNode.forEach((child, offset) => {
				if (!child.isText) return;
				const from = blockStart + offset;
				const to = from + child.nodeSize;
				let equal = true;
				tr.doc.nodesBetween(from, to, (cur) => {
					if (cur.isText && !Mark.sameSet(cur.marks, child.marks))
						equal = false;
				});
				if (!equal) {
					tr.removeMark(from, to);
					for (const mark of child.marks) tr.addMark(from, to, mark);
				}
			});
		}

		// Update `rendered.blocks` positions and entries before mapping selection.
		const planByIdx = new Map(plans.map((pl) => [pl.idx, pl]));
		const oldSelection = view.state.selection;
		// Snapshot only the selection's old block(s) before mutating `rendered.blocks`.
		const selBlockOld = new Map<
			number,
			{ pos: number; chars: CoreEntry[]; node: ProseMirrorNode }
		>();
		if (oldSelection instanceof TextSelection) {
			for (const p of [oldSelection.anchor, oldSelection.head]) {
				const bi = findBlockIndex(rendered.blocks, p);
				if (bi >= 0 && !selBlockOld.has(bi)) {
					const b = rendered.blocks[bi]!;
					selBlockOld.set(bi, { pos: b.pos, chars: b.chars, node: b.node });
				}
			}
		}
		let shift = 0;
		const firstAffected = plans[0]!.idx;
		for (let idx = firstAffected; idx < rendered.blocks.length; idx++) {
			const block = rendered.blocks[idx]!;
			const pl = planByIdx.get(idx);
			if (pl) {
				block.pos += shift;
				shift += pl.newNode.nodeSize - block.node.nodeSize;
				block.node = pl.newNode;
				block.chars = pl.newChars;
			} else if (shift !== 0) {
				block.pos += shift;
			}
		}
		rendered.doc = tr.doc;
		rendered.tokensDirty = true;
		renderedRev = currentRev;

		if (!tr.docChanged) {
			redraw();
			return true;
		}
		syncing = true;
		try {
			tr.setMeta(key, true).setMeta("addToHistory", false);
			tr.setSelection(
				mapSelectionIncremental(
					view.state,
					rendered,
					selBlockOld,
					planByIdx,
					tr.mapping,
					replaying,
				),
			);
			view.dispatch(tr);
			if (!view.state.doc.eq(rendered.doc))
				throw new Error(
					"ProseMirror dispatchTransaction must synchronously apply Pulsify transactions without changing their document",
				);
		} finally {
			syncing = false;
		}
		return true;
	};
	const pull = () => {
		if (syncing || disposed || view.isDestroyed) return;
		try {
			richTextContext(field);
			const currentRev = directNodeRevision(context.node);
			if (renderedRev === currentRev) {
				redraw();
				return;
			}
			history.stopCapturing();
			if (tryIncrementalRemote(currentRev)) return;
			const next = readDocument(context, schema);
			const previous = rendered;
			rendered = next;
			renderedRev = currentRev;
			if (view.state.doc.eq(next.doc)) {
				redraw();
				return;
			}
			ensureFullView(previous, schema);
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
							const incremental =
								renderedRev === directNodeRevision(context.node)
									? writeIncrementalLocal(
											context,
											current.state.doc,
											rendered,
											mapping,
											true,
										)
									: undefined;
							if (incremental) {
								renderedRev = directNodeRevision(context.node);
								historyConnection.record(incremental, record);
							} else {
								const change = writeDocument(
									context,
									current.state.doc,
									rendered,
									mapping,
									true,
								);
								rendered = readDocument(context, schema);
								renderedRev = directNodeRevision(context.node);
								historyConnection.record(change, record);
							}
						} catch (error) {
							// Native quota/validation failures must not leave an editor
							// showing an edit which the field rejected atomically.
							current.updateState(previousState);
							throw error;
						} finally {
							syncing = false;
						}
					publish();
					scheduleRedraw();
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
		renderedRev = directNodeRevision(context.node);
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

/** O(blockSize) selection mapping for incremental remote updates. */
function mapSelectionIncremental(
	state: EditorState,
	rendered: DocumentView,
	selBlockOld: Map<
		number,
		{ pos: number; chars: CoreEntry[]; node: ProseMirrorNode }
	>,
	planByIdx: Map<number, { oldChars: CoreEntry[]; newChars: CoreEntry[] }>,
	mapping: Mapping,
	restoring: boolean,
): Selection {
	if (!(state.selection instanceof TextSelection))
		return state.selection.map(rendered.doc, mapping);
	const mapPos = (pos: number): number => {
		// Find which block `pos` was in before the update.
		for (const [bi, old] of selBlockOld) {
			if (pos > old.pos && pos <= old.pos + old.node.nodeSize - 1) {
				const nextBlock = rendered.blocks[bi]!;
				const plan = planByIdx.get(bi);
				if (!plan) {
					// Block was untouched; just shift by its new pos!
					return nextBlock.pos + (pos - old.pos);
				}
				const kept = new Set(old.chars.map((e) => e.id));
				const afterById = new Map<string, { pos: number; size: number }>();
				const restored = new Map<number, number>();
				let cur = nextBlock.pos + 1;
				for (let i = 0; i < nextBlock.chars.length; i++) {
					const e = nextBlock.chars[i]!;
					const len = (e.value as string).length;
					afterById.set(e.id, { pos: cur, size: len });
					if (!kept.has(e.id)) restored.set(cur, len);
					cur += len;
				}
				let left: CoreEntry | undefined, right: CoreEntry | undefined;
				let oldCur = old.pos + 1;
				for (let i = 0; i < old.chars.length; i++) {
					const e = old.chars[i]!;
					const len = (e.value as string).length;
					if (oldCur + len <= pos) left = e;
					if (!right && oldCur >= pos) right = e;
					oldCur += len;
				}
				let at: number;
				const sl = left && afterById.get(left.id);
				const sr = right && afterById.get(right.id);
				if (sl) at = sl.pos + sl.size;
				else if (sr) at = sr.pos;
				else
					at =
						nextBlock.pos +
						1 +
						Math.min(pos - old.pos - 1, nextBlock.node.content.size);
				if (restoring) {
					for (let len; (len = restored.get(at));) at += len;
				}
				return at;
			}
		}
		return Math.max(0, Math.min(rendered.doc.content.size, mapping.map(pos)));
	};
	const anchor = rendered.doc.resolve(mapPos(state.selection.anchor));
	const head = rendered.doc.resolve(mapPos(state.selection.head));
	return TextSelection.between(anchor, head);
}

function replaceDocument(
	state: EditorState,
	doc: ProseMirrorNode,
	previous?: DocumentView,
	next?: DocumentView,
) {
	const tr = state.tr;
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
		// Check which textblock indices actually changed before grouping tokens.
		const changedBlockIds = new Set<string>();
		for (let index = 0; index < previous.nodes.length; index++) {
			const oldBlock = previous.nodes[index]!,
				newBlock = next.nodes[index]!;
			if (oldBlock.node.isTextblock && !oldBlock.node.eq(newBlock.node))
				changedBlockIds.add(oldBlock.id);
		}
		if (changedBlockIds.size) {
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
					if (!changedBlockIds.has(block.id)) continue;
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
				if (!changedBlockIds.has(oldBlock.id)) continue;
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
					const end =
						newToken?.pos ?? newBlock.pos + newBlock.node.nodeSize - 1;
					if (from !== to || start !== end)
						edits.push({ from, to, start, end });
					from = to + (oldToken?.size ?? 0);
					start = end + (newToken?.size ?? 0);
				}
			}
			for (const edit of edits.sort((a, b) => b.from - a.from))
				tr.replace(edit.from, edit.to, doc.slice(edit.start, edit.end));
		}
	} else {
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
	// Skip unchanged subtrees when syncing marks and node attributes.
	const syncMarksAndAttrs = (
		target: ProseMirrorNode,
		current: ProseMirrorNode,
		pos: number,
	) => {
		if (target.eq(current)) return;
		if (target.isText) {
			if (!Mark.sameSet(current.marks, target.marks)) {
				tr.removeMark(pos, pos + target.nodeSize);
				for (const mark of target.marks)
					tr.addMark(pos, pos + target.nodeSize, mark);
			}
			return;
		}
		if (
			pos >= 0 &&
			(JSON.stringify(current.attrs) !== JSON.stringify(target.attrs) ||
				!Mark.sameSet(current.marks, target.marks))
		) {
			tr.setNodeMarkup(pos, undefined, target.attrs, target.marks);
		}
		let childOffset = 0;
		for (let i = 0; i < target.childCount; i++) {
			const child = target.child(i);
			const childPos = pos + 1 + childOffset;
			const curNode = tr.doc.nodeAt(childPos);
			if (
				curNode &&
				curNode.type === child.type &&
				curNode.nodeSize === child.nodeSize
			) {
				syncMarksAndAttrs(child, curNode, childPos);
			} else if (child.isText) {
				let equal = true;
				tr.doc.nodesBetween(childPos, childPos + child.nodeSize, (cur) => {
					if (cur.isText && !Mark.sameSet(cur.marks, child.marks))
						equal = false;
				});
				if (!equal) {
					tr.removeMark(childPos, childPos + child.nodeSize);
					for (const mark of child.marks)
						tr.addMark(childPos, childPos + child.nodeSize, mark);
				}
			} else {
				const live = tr.doc.nodeAt(childPos)!;
				syncMarksAndAttrs(child, live, childPos);
			}
			childOffset += child.nodeSize;
		}
	};
	syncMarksAndAttrs(doc, tr.doc, -1);
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
