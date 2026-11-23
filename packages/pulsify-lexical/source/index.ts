import {
	$getRoot,
	$getNodeByKey,
	$isElementNode,
	$isTextNode,
	$parseSerializedNode,
	$createRangeSelection,
	$createNodeSelection,
	$setSelection,
	getRegisteredNode,
	BLUR_COMMAND,
	FOCUS_COMMAND,
	COMMAND_PRIORITY_LOW,
	COLLABORATION_TAG,
	SKIP_SCROLL_INTO_VIEW_TAG,
	HISTORY_PUSH_TAG,
	HISTORY_MERGE_TAG,
	UNDO_COMMAND,
	REDO_COMMAND,
	CLEAR_HISTORY_COMMAND,
	CAN_UNDO_COMMAND,
	CAN_REDO_COMMAND,
	COMMAND_PRIORITY_HIGH,
	type LexicalEditor,
	type LexicalNode,
	type SerializedEditorState,
} from "lexical";
import {
	joinPresence,
	RichTextSelection,
	type Pulse,
	type RichText,
} from "pulsify-core";
import {
	RT_NODE,
	RT_PARENT,
	directNodeRevision,
	insertBlockEntry,
	richTextContext,
	richTextRedirects,
	richTextRemovedNodes,
	reconcileEditorTokens,
	createPulsifyHistory,
	connectEditorHistory,
	textChangesSince,
	type CoreEntry,
	type PulsifyHistory,
	type RichTextContext,
} from "pulsify-core/bindings";
import {
	anchorOfPoint,
	buildTextChildrenFromEntries,
	captureDocument,
	captureSubtree,
	ensureTokens,
	ensureTreeIndex,
	matchDocument,
	ownJSONEqual,
	pointOfAnchor,
	readDocument,
	readSelection,
	reconcileDirtySubtrees,
	redirectOperations,
	replaceSubtreeInView,
	sameJSON,
	type DocumentView,
	type JSONNode,
	type Tree,
	type Point,
	type Token,
} from "./document.js";
import { drawSelections } from "./cursors.js";

export {
	createPulsifyHistory,
	type PulsifyHistory,
	type PulsifyHistoryOptions,
} from "pulsify-core/bindings";

const REMOTE_TAG = "pulsify:remote";
const bindings = new WeakMap<LexicalEditor, LexicalBinding>();
/** The binding that last shared a selection on each pulse, by its token. */
const publishers = new WeakMap<object, object>();
export interface LexicalBindingOptions {
	/** A history plugin created by either editor package. Defaults to a fresh plugin. */
	history?: PulsifyHistory;
	/** Bump this when changing the meaning of custom nodes. All peers must agree. */
	schemaId?: string;
	onError?: (error: unknown) => void;
	/** Collaborative undo grouping interval, in milliseconds. Default: 300. */
	undoDelay?: number;
	/** Maximum local undo groups retained. Default: 100. */
	maxUndo?: number;
	/**
	 * Share my selection through presence and draw the caret and selected range
	 * of every other peer in this field. `true` shares without a name.
	 * `draw: false` shares mine and draws nothing. `container` is where the
	 * overlay elements go (default: the parent of the editor's root element).
	 */
	selection?:
		| boolean
		| {
				name?: string;
				color?: string;
				draw?: boolean;
				container?: HTMLElement;
		  };
}
export interface LexicalBinding {
	readonly history: PulsifyHistory;
	destroy(): void;
	undo(): boolean;
	redo(): boolean;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	/**
	 * A Lexical point (`{ key, offset, type }`, e.g. `selection.anchor`) as a
	 * string that follows it through every edit.
	 */
	anchorAt(point: {
		key: string;
		offset: number;
		type?: "text" | "element";
	}): string;
	/**
	 * Where an anchor is now; `undefined` for an anchor of another field or of
	 * an entry not received yet.
	 */
	pointOf(
		anchor: string,
	): { key: string; offset: number; type: "text" | "element" } | undefined;
}

/** Nodes and formatting as Lexical JSON. Plain snapshots remain a text projection. */
export function lexicalDocument(field: RichText): SerializedEditorState {
	return {
		root: readDocument(richTextContext(field)).tree.json,
	} as unknown as SerializedEditorState;
}

/** Bind a vanilla, React-mounted, or headless Lexical editor to an attached field. */
export function bindLexical(
	editor: LexicalEditor,
	field: RichText,
	options: LexicalBindingOptions = {},
): LexicalBinding {
	if (bindings.has(editor))
		throw new TypeError("This Lexical editor is already bound");
	const schemaId = options.schemaId ?? "lexical:1",
		undoDelay = options.undoDelay ?? 300,
		maxUndo = options.maxUndo ?? 100,
		sharing = options.selection === true ? {} : options.selection || undefined;
	if (
		!schemaId ||
		(sharing &&
			(typeof sharing !== "object" ||
				(sharing.name !== undefined && typeof sharing.name !== "string") ||
				(sharing.color !== undefined && typeof sharing.color !== "string"))) ||
		!Number.isFinite(undoDelay) ||
		undoDelay < 0 ||
		!Number.isSafeInteger(maxUndo) ||
		maxUndo < 0
	)
		throw new TypeError("Invalid Lexical binding options");
	const context = richTextContext(field);
	let native = readDocument(context, schemaId),
		rendered: DocumentView,
		renderedRev = -1;
	let writing = false,
		disposed = false;
	const history = options.history ?? createPulsifyHistory(options);
	const cleanup: (() => void)[] = [];
	const fail = (error: unknown) => {
		binding.destroy();
		if (options.onError) options.onError(error);
		else throw error;
	};
	const notifyHistory = () => {
		editor.dispatchCommand(CAN_UNDO_COMMAND, history.canUndo);
		editor.dispatchCommand(CAN_REDO_COMMAND, history.canRedo);
	};
	// `pull(false)` renders an undo or redo of this editor.
	const pull = (flush = true) => {
		if (disposed || writing) return;
		try {
			// Flush batched local typing before applying a remote change.
			if (flush) editor.read(() => {});
			richTextContext(field);
			const currentRev = directNodeRevision(context.node);
			if (rendered && renderedRev === currentRev) return;
			if (
				rendered &&
				applyIncrementalRemote(editor, context, rendered, renderedRev, !flush)
			) {
				renderedRev = currentRev;
				native = rendered;
				history.stopCapturing();
				return;
			}
			native = readDocument(context, schemaId);
			applyDocument(
				editor,
				native,
				rendered,
				(snapshot) => {
					rendered = snapshot;
				},
				context,
				schemaId,
				!flush,
			);
			renderedRev = currentRev;
			history.stopCapturing();
		} catch (error) {
			fail(error);
		}
	};
	const historyConnection = connectEditorHistory(history, context, {
		flush: () => {
			if (!editor._updating) editor.read(() => {});
		},
		replay(action) {
			writing = true;
			try {
				richTextContext(field);
				action();
			} finally {
				writing = false;
			}
			pull(false);
		},
	});
	cleanup.push(
		() => historyConnection.destroy(),
		history.subscribe(notifyHistory),
	);
	const binding: LexicalBinding = {
		history,
		get canUndo() {
			return history.canUndo;
		},
		get canRedo() {
			return history.canRedo;
		},
		undo: () => history.undo(),
		redo: () => history.redo(),
		destroy() {
			if (disposed) return;
			disposed = true;
			for (const unregister of cleanup.splice(0)) unregister();
			if (bindings.get(editor) === binding) bindings.delete(editor);
		},
		anchorAt(point) {
			if (
				!point ||
				typeof point !== "object" ||
				typeof point.key !== "string" ||
				!Number.isSafeInteger(point.offset) ||
				(point.type !== undefined &&
					point.type !== "text" &&
					point.type !== "element")
			)
				throw new TypeError("Invalid Lexical point");
			if (disposed)
				throw new TypeError("This Lexical binding has been destroyed");
			richTextContext(field);
			const anchor = anchorOfPoint(context, native, rendered, point);
			if (anchor === undefined)
				throw new RangeError("This Lexical point is not in the bound document");
			return anchor;
		},
		pointOf(anchor) {
			if (typeof anchor !== "string")
				throw new TypeError("An anchor is a string");
			if (disposed) return undefined;
			richTextContext(field);
			return pointOfAnchor(context, rendered, anchor);
		},
	};
	try {
		bindings.set(editor, binding);
		applyDocument(
			editor,
			native,
			undefined,
			(snapshot) => {
				rendered = snapshot;
			},
			context,
			schemaId,
		);
		writing = true;
		reconcileEditorTokens(
			context,
			ensureTokens(rendered!),
			matchDocument(native, rendered!),
		);
		writing = false;
		native = readDocument(context, schemaId);
		matchDocument(native, rendered!);
		ensureTreeIndex(rendered!);
		renderedRev = directNodeRevision(context.node);
		cleanup.push(
			editor.registerUpdateListener(
				({
					editorState,
					prevEditorState,
					tags,
					dirtyElements,
					dirtyLeaves,
				}) => {
					if (disposed) return;
					if (tags.has(REMOTE_TAG)) return;
					if (!dirtyElements.size && !dirtyLeaves.size) {
						rendered.selection = editorState.read(readSelection);
						return;
					}
					try {
						richTextContext(field);
						writing = true;
						const currentRev = directNodeRevision(context.node);
						const rootKey = rendered.tree.key;
						// Fast incremental path: root's child list unchanged and no concurrent remote changes.
						if (
							currentRev === renderedRev &&
							rootKey !== undefined &&
							rendered.byKey &&
							rendered.parentOf
						) {
							const captured = editorState.read(() => {
								const root = $getRoot();
								if (root.getChildrenSize() !== rendered.tree.children.length)
									return undefined;
								if (
									!ownJSONEqual(
										root.exportJSON() as JSONNode,
										rendered.tree.json,
									)
								)
									return undefined;
								const dirtyBlockKeys = new Set<string>();
								const findTopBlock = (key: string): string | undefined => {
									if (key === rootKey) return undefined;
									let node = $getNodeByKey(key);
									if (node) {
										while (node) {
											const parent = node.getParent();
											if (!parent) return undefined;
											if (parent.getKey() === rootKey) return node.getKey();
											node = parent;
										}
										return undefined;
									}
									// Key was removed; find its enclosing top-level block in `rendered`.
									let tree = rendered.byKey!.get(key);
									while (tree) {
										const link = rendered.parentOf!.get(tree);
										if (!link) return undefined;
										if (link.parent === rendered.tree) return tree.key;
										tree = link.parent;
									}
									return undefined;
								};
								for (const key of dirtyLeaves) {
									const top = findTopBlock(key);
									if (!top) return undefined;
									dirtyBlockKeys.add(top);
								}
								for (const key of dirtyElements.keys()) {
									if (key === rootKey) continue;
									const top = findTopBlock(key);
									if (!top) return undefined;
									dirtyBlockKeys.add(top);
								}
								if (!dirtyBlockKeys.size) return undefined;
								const pairs: {
									index: number;
									oldBlock: Tree;
									newBlock: Tree;
								}[] = [];
								const serialBox = { value: 0 };
								const rootId = rendered.tree.id!;
								for (const blockKey of dirtyBlockKeys) {
									const oldBlock = rendered.byKey!.get(blockKey);
									if (!oldBlock) return undefined;
									const link = rendered.parentOf!.get(oldBlock);
									if (!link || link.parent !== rendered.tree) return undefined;
									const node = $getNodeByKey(blockKey);
									if (!node || node.getParent()?.getKey() !== rootKey)
										return undefined;
									// Verify this block was not reordered among root's children.
									const prevKey =
										rendered.tree.children[link.index - 1]?.key ?? null;
									const nextKey =
										rendered.tree.children[link.index + 1]?.key ?? null;
									if (
										(node.getPreviousSibling()?.getKey() ?? null) !== prevKey ||
										(node.getNextSibling()?.getKey() ?? null) !== nextKey
									)
										return undefined;
									const newBlock = captureSubtree(
										node,
										rootId,
										context,
										rendered.ids,
										schemaId,
										new Map(),
										[],
										serialBox,
									);
									pairs.push({ index: link.index, oldBlock, newBlock });
								}
								return { pairs, selection: readSelection() };
							});
							if (captured) {
								const change = reconcileDirtySubtrees(
									context,
									captured.pairs,
									rendered.selection,
									captured.selection,
								);
								if (change) {
									for (let i = 0; i < captured.pairs.length; i++) {
										const { index, oldBlock, newBlock } = captured.pairs[i]!;
										replaceSubtreeInView(
											rendered,
											rendered.tree,
											index,
											oldBlock,
											newBlock,
										);
									}
									rendered.selection = captured.selection;
									renderedRev = directNodeRevision(context.node);
									native = rendered;
									historyConnection.record(change, {
										push: tags.has(HISTORY_PUSH_TAG),
										merge: tags.has(HISTORY_MERGE_TAG),
									});
									return;
								}
							}
						}
						// Full-document fallback (structural root changes or concurrent batched flush).
						const current = editorState.read(() =>
							captureDocument(context, rendered.ids, schemaId),
						);
						const keys = matchDocument(rendered, current);
						const change = reconcileEditorTokens(
							context,
							ensureTokens(current),
							keys,
							redirectOperations(context, rendered, current),
							true,
							ensureTokens(rendered),
						);
						native = readDocument(context, schemaId);
						matchDocument(native, current);
						rendered = current;
						ensureTreeIndex(rendered);
						renderedRev = directNodeRevision(context.node);
						historyConnection.record(change, {
							push: tags.has(HISTORY_PUSH_TAG),
							merge: tags.has(HISTORY_MERGE_TAG),
						});
						if (!sameJSON(native.tree.json, current.tree.json))
							applyDocument(
								editor,
								native,
								current,
								(snapshot) => {
									rendered = snapshot;
								},
								context,
								schemaId,
							);
					} catch (error) {
						editor.setEditorState(prevEditorState, { tag: REMOTE_TAG });
						editor.update(() => {}, { discrete: true, tag: REMOTE_TAG });
						if (options.onError) options.onError(error);
						else throw error;
					} finally {
						writing = false;
					}
				},
			),
		);
		cleanup.push(context.subscribe(pull));
		if (sharing) {
			const presence = joinPresence(
				context.pulse as Pulse<any>,
				RichTextSelection,
			);
			const owner = {};
			/** Only what this binding shared: a pulse has one selection per peer. */
			const clear = (): boolean => {
				if (publishers.get(context.pulse as object) !== owner) return false;
				publishers.delete(context.pulse as object);
				presence.set(undefined);
				return true;
			};
			// Lexical keeps its selection when the editor loses focus: a cursor
			// nobody is using would stay on the other peers' screens.
			let blurred = false;
			const publish = () => {
				if (blurred) return;
				const selected = rendered.selection;
				const [anchor, head] =
					selected && "anchor" in selected
						? [selected.anchor, selected.focus].map((point) =>
								anchorOfPoint(context, native, rendered, point),
							)
						: [];
				if (anchor === undefined || head === undefined) {
					clear();
					return;
				}
				presence.set({
					anchor,
					head,
					name: sharing.name ?? "",
					color: sharing.color ?? "",
				});
				publishers.set(context.pulse as object, owner);
			};
			let overlay: ReturnType<typeof drawSelections> | undefined;
			cleanup.push(() => {
				overlay?.destroy();
				clear();
				presence.leave();
			});
			// A headless editor has no root element: it shares and draws nothing.
			if (sharing.draw !== false && !editor._headless)
				overlay = drawSelections(
					editor,
					context.pulse as Pulse<any>,
					presence,
					(anchor) =>
						disposed ? undefined : pointOfAnchor(context, rendered, anchor),
					sharing.container,
				);
			cleanup.push(
				// Registered after the listener above: `rendered` is up to date.
				editor.registerUpdateListener(() => {
					if (disposed) return;
					publish();
					overlay?.schedule();
				}),
				// A remote change that carries the character of a waiting anchor.
				context.subscribe(() => {
					if (!writing) overlay?.schedule();
				}),
				editor.registerCommand(
					BLUR_COMMAND,
					() => {
						blurred = true;
						clear();
						return false;
					},
					COMMAND_PRIORITY_LOW,
				),
				editor.registerCommand(
					FOCUS_COMMAND,
					() => {
						blurred = false;
						publish();
						return false;
					},
					COMMAND_PRIORITY_LOW,
				),
			);
			publish();
		}
		cleanup.push(
			editor.registerCommand(
				UNDO_COMMAND,
				() => binding.undo(),
				COMMAND_PRIORITY_HIGH,
			),
		);
		cleanup.push(
			editor.registerCommand(
				REDO_COMMAND,
				() => binding.redo(),
				COMMAND_PRIORITY_HIGH,
			),
		);
		cleanup.push(
			editor.registerCommand(
				CLEAR_HISTORY_COMMAND,
				() => {
					history.clear();
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
		);
		notifyHistory();
		return binding;
	} catch (error) {
		binding.destroy();
		throw error;
	}
}

function validateRegistered(editor: LexicalEditor, tree: Tree): void {
	if (!getRegisteredNode(editor, tree.json.type))
		throw new TypeError(`Lexical node ${tree.json.type} is not registered`);
	for (let i = 0; i < tree.children.length; i++)
		validateRegistered(editor, tree.children[i]!);
}

function validateRootJSON(editor: LexicalEditor, rootJson: JSONNode): void {
	let valid = false;
	editor.parseEditorState(
		{ root: rootJson } as unknown as SerializedEditorState,
		() => {
			valid = true;
		},
	);
	if (!valid) throw new TypeError("Lexical rejected this rich text document");
}

/**
 * Apply non-structural remote character edits to known textblocks in O(edited blocks).
 * Returns `false` if any structural or concurrent-sibling condition requires full sync.
 */
function applyIncrementalRemote(
	editor: LexicalEditor,
	context: RichTextContext,
	rendered: DocumentView,
	sinceRev: number,
	restoring: boolean,
): boolean {
	if (!rendered.byId || !rendered.byKey || !rendered.parentOf) return false;
	const changes = textChangesSince(context.node, sinceRev);
	if (!changes || !changes.length) return false;
	for (let i = 0; i < changes.length; i++) {
		if (changes[i]!.structural) return false;
	}
	const redirects = richTextRedirects(context.node);
	const removed = richTextRemovedNodes(context.node);
	const affectedBlocks = new Map<
		string,
		{
			oldBlock: Tree;
			index: number;
			parent: Tree;
			inserted: CoreEntry[];
			hasDeleted: boolean;
		}
	>();
	const touchBlock = (entry: CoreEntry) => {
		const parentId = entry.marks.get(RT_PARENT)?.value;
		if (typeof parentId !== "string") return undefined;
		let info = affectedBlocks.get(parentId);
		if (info) return info;
		if (redirects.has(parentId) || removed.has(parentId)) return undefined;
		const oldBlock = rendered.byId!.get(parentId);
		if (!oldBlock || oldBlock.key === undefined) return undefined;
		const link = rendered.parentOf!.get(oldBlock);
		if (!link || link.parent !== rendered.tree) return undefined;
		// Only simple textblocks (children are all text nodes).
		for (let i = 0; i < oldBlock.children.length; i++) {
			if (oldBlock.children[i]!.id !== undefined) return undefined;
		}
		info = {
			oldBlock,
			index: link.index,
			parent: link.parent,
			inserted: [],
			hasDeleted: false,
		};
		affectedBlocks.set(parentId, info);
		return info;
	};
	for (let i = 0; i < changes.length; i++) {
		const change = changes[i]!;
		for (let j = 0; j < change.deleted.length; j++) {
			const info = touchBlock(change.deleted[j]!);
			if (!info) return false;
			info.hasDeleted = true;
		}
		for (let j = 0; j < change.inserted.length; j++) {
			const entry = change.inserted[j]!;
			if (entry.deleted) continue;
			const info = touchBlock(entry);
			if (!info) return false;
			info.inserted.push(entry);
		}
		for (let j = 0; j < change.marked.length; j++) {
			const entry = change.marked[j]!;
			if (entry.deleted) continue;
			const info = touchBlock(entry);
			if (!info) return false;
		}
	}
	if (!affectedBlocks.size) return true;

	const updates: {
		parentId: string;
		index: number;
		parent: Tree;
		oldBlock: Tree;
		newBlock: Tree;
		keptEntries: Set<string>;
	}[] = [];

	for (const [parentId, info] of affectedBlocks) {
		const { oldBlock, index, parent, inserted } = info;
		const anchorEntry = oldBlock.tokens[0]?.entry;
		if (!anchorEntry || anchorEntry.deleted) return false;
		const entries: CoreEntry[] = [];
		const keptEntries = new Set<string>();
		for (let c = 0; c < oldBlock.children.length; c++) {
			const child = oldBlock.children[c]!;
			for (let t = 0; t < child.tokens.length; t++) {
				const e = child.tokens[t]!.entry;
				if (!e) return false;
				keptEntries.add(e.id);
				if (!e.deleted) entries.push(e);
			}
		}
		// Insert new entries in exact RGA order.
		const present = new Set<CoreEntry>(entries);
		for (let j = 0; j < inserted.length; j++) {
			if (
				!insertBlockEntry(entries, present, anchorEntry, inserted[j]!, parentId)
			)
				return false;
		}
		const newChildren = buildTextChildrenFromEntries(entries, parentId);
		const newBlock: Tree = {
			...(oldBlock.key !== undefined ? { key: oldBlock.key } : {}),
			...(oldBlock.id !== undefined ? { id: oldBlock.id } : {}),
			json: {
				...oldBlock.json,
				children: newChildren.map((child) => child.json),
			},
			children: newChildren,
			tokens: oldBlock.tokens,
		};
		validateRegistered(editor, newBlock);
		updates.push({ parentId, index, parent, oldBlock, newBlock, keptEntries });
	}
	// Validate only the changed block subtrees via Lexical's parser.
	validateRootJSON(editor, {
		...rendered.tree.json,
		children: updates.map((u) => u.newBlock.json),
	});

	const affectedKeys = new Set<string>();
	for (let i = 0; i < updates.length; i++) {
		const { oldBlock } = updates[i]!;
		if (oldBlock.key) affectedKeys.add(oldBlock.key);
		for (let c = 0; c < oldBlock.children.length; c++) {
			const ck = oldBlock.children[c]!.key;
			if (ck) affectedKeys.add(ck);
		}
	}
	const prevSel = rendered.selection;
	const selAffected =
		!!prevSel &&
		"anchor" in prevSel &&
		(affectedKeys.has(prevSel.anchor.key) ||
			affectedKeys.has(prevSel.focus.key));

	editor.update(
		() => {
			const runtime = new Map<string, { key: string; offset: number }>();
			const restored = new Map<string, number>();
			for (let u = 0; u < updates.length; u++) {
				const { oldBlock, newBlock, keptEntries } = updates[u]!;
				const blockNode = $getNodeByKey(oldBlock.key!);
				if (!blockNode || !$isElementNode(blockNode))
					throw new TypeError("Missing Lexical block node");
				const oldCharKey = new Map<string, string>();
				const oldChildByKey = new Map<string, Tree>();
				for (let c = 0; c < oldBlock.children.length; c++) {
					const child = oldBlock.children[c]!;
					if (child.key) oldChildByKey.set(child.key, child);
					for (let t = 0; t < child.tokens.length; t++) {
						const tok = child.tokens[t]!;
						if (tok.entry && tok.key) oldCharKey.set(tok.entry.id, tok.key);
					}
				}
				const used = new Set<string>();
				const nextNodes: LexicalNode[] = [];
				for (let c = 0; c < newBlock.children.length; c++) {
					const childTree = newBlock.children[c]!;
					let key: string | undefined;
					for (let t = 0; t < childTree.tokens.length; t++) {
						const e = childTree.tokens[t]!.entry;
						if (e) {
							const k = oldCharKey.get(e.id);
							if (k && !used.has(k)) {
								key = k;
								break;
							}
						}
					}
					let textNode = key ? $getNodeByKey(key) : null;
					const prevTree = key ? oldChildByKey.get(key) : undefined;
					if (!textNode || textNode.getType() !== childTree.json.type) {
						textNode = $parseSerializedNode(childTree.json);
					} else if (
						!prevTree ||
						!ownJSONEqual(childTree.json, prevTree.json)
					) {
						textNode.updateFromJSON(childTree.json);
					}
					const nodeKey = textNode.getKey();
					used.add(nodeKey);
					childTree.key = nodeKey;
					let offset = 0;
					for (let t = 0; t < childTree.tokens.length; t++) {
						const tok = childTree.tokens[t]!;
						tok.key = nodeKey;
						tok.offset = offset;
						if (selAffected && tok.entry) {
							runtime.set(tok.entry.id, { key: nodeKey, offset });
							if (!keptEntries.has(tok.entry.id))
								restored.set(`${nodeKey}:${offset}`, tok.value.length);
						}
						offset += tok.value.length;
					}
					nextNodes.push(textNode);
				}
				const oldChildren = blockNode.getChildren();
				if (
					oldChildren.length !== nextNodes.length ||
					oldChildren.some(
						(child, idx) => child.getKey() !== nextNodes[idx]!.getKey(),
					)
				)
					blockNode.splice(0, oldChildren.length, nextNodes);
			}
			if (selAffected && prevSel && "anchor" in prevSel) {
				const after = (key: string, offset: number) => {
					if (restoring)
						for (let size; (size = restored.get(`${key}:${offset}`));)
							offset += size;
					return offset;
				};
				const mapPoint = (old: Point): Point | undefined => {
					if (!affectedKeys.has(old.key)) return old;
					if (old.type === "text") {
						const oldTree = rendered.byKey!.get(old.key);
						const tokens = oldTree?.tokens ?? [];
						let left: Token | undefined, right: Token | undefined;
						for (let i = tokens.length - 1; i >= 0; i--) {
							const tok = tokens[i]!;
							if (tok.entry && tok.offset! + tok.value.length <= old.offset) {
								left = tok;
								break;
							}
						}
						for (let i = 0; i < tokens.length; i++) {
							const tok = tokens[i]!;
							if (tok.entry && tok.offset! >= old.offset) {
								right = tok;
								break;
							}
						}
						const a = left?.entry && runtime.get(left.entry.id);
						const b = right?.entry && runtime.get(right.entry.id);
						if (a)
							return {
								key: a.key,
								offset: after(a.key, a.offset + left!.value.length),
								type: "text",
							};
						if (b) return { key: b.key, offset: b.offset, type: "text" };
						// All text in block deleted: place caret in parent block element.
						const link = oldTree && rendered.parentOf!.get(oldTree);
						const pNode = link?.parent.key && $getNodeByKey(link.parent.key);
						if (pNode && $isElementNode(pNode))
							return {
								key: pNode.getKey(),
								offset: Math.min(old.offset, pNode.getChildrenSize()),
								type: "element",
							};
					}
					const node = $getNodeByKey(old.key);
					if (node && $isElementNode(node))
						return {
							key: node.getKey(),
							offset: Math.min(old.offset, node.getChildrenSize()),
							type: "element",
						};
					return undefined;
				};
				const anchor = mapPoint(prevSel.anchor),
					focus = mapPoint(prevSel.focus);
				if (anchor && focus) {
					const selected = $createRangeSelection();
					selected.anchor.set(anchor.key, anchor.offset, anchor.type);
					selected.focus.set(focus.key, focus.offset, focus.type);
					selected.format = prevSel.format;
					selected.style = prevSel.style;
					$setSelection(selected);
				} else $getRoot().selectEnd();
			}
			for (let u = 0; u < updates.length; u++) {
				const { parent, index, oldBlock, newBlock } = updates[u]!;
				replaceSubtreeInView(rendered, parent, index, oldBlock, newBlock);
			}
			rendered.selection = readSelection();
		},
		{
			discrete: true,
			skipTransforms: true,
			tag: [REMOTE_TAG, COLLABORATION_TAG, SKIP_SCROLL_INTO_VIEW_TAG],
		},
	);
	return true;
}

function applyDocument(
	editor: LexicalEditor,
	next: DocumentView,
	previous: DocumentView | undefined,
	adopt: (view: DocumentView) => void,
	context: RichTextContext,
	schemaId: string,
	/** An undo or redo of this editor: what it restores at the cursor goes before it. */
	restoring = false,
): void {
	if (previous && !previous.byId) ensureTreeIndex(previous);
	const oldById = previous?.byId;
	const oldNodes = new Map(
		previous ? [...previous.ids].map(([key, id]) => [id, key]) : [],
	);
	// Validate only new or changed subtrees when updating an existing editor state.
	if (!previous) {
		validateRegistered(editor, next.tree);
		validateRootJSON(editor, next.tree.json);
	} else {
		const rootChanged = !ownJSONEqual(next.tree.json, previous.tree.json);
		const changedChildren: JSONNode[] = [];
		const treeChanged = (tree: Tree): boolean => {
			if (tree.id !== undefined) {
				const old = oldById?.get(tree.id);
				if (!old || !ownJSONEqual(tree.json, old.json)) return true;
				if (tree.children.length !== old.children.length) return true;
				for (let i = 0; i < tree.children.length; i++) {
					if (treeChanged(tree.children[i]!)) return true;
				}
				return false;
			}
			// Text node: compare against old child at same parent position via parent check
			return true;
		};
		for (let i = 0; i < next.tree.children.length; i++) {
			const child = next.tree.children[i]!;
			const old = child.id !== undefined ? oldById?.get(child.id) : undefined;
			let dirty = !old || !ownJSONEqual(child.json, old.json);
			if (!dirty && old) {
				if (child.children.length !== old.children.length) {
					dirty = true;
				} else {
					for (let j = 0; j < child.children.length; j++) {
						const c = child.children[j]!;
						const oc = old.children[j]!;
						if (c.id !== oc.id || !ownJSONEqual(c.json, oc.json)) {
							dirty = true;
							break;
						}
						if (c.children.length && treeChanged(c)) {
							dirty = true;
							break;
						}
					}
				}
			}
			if (dirty) {
				validateRegistered(editor, child);
				changedChildren.push(child.json);
			}
		}
		if (rootChanged || changedChildren.length) {
			if (!getRegisteredNode(editor, next.tree.json.type))
				throw new TypeError(
					`Lexical node ${next.tree.json.type} is not registered`,
				);
			validateRootJSON(editor, {
				...next.tree.json,
				children: changedChildren,
			});
		}
	}
	const prevTokens = previous ? ensureTokens(previous) : [];
	const oldCharacters = new Map<string, string>();
	for (let i = 0; i < prevTokens.length; i++) {
		const token = prevTokens[i]!;
		if (token.entry && token.key) oldCharacters.set(token.entry.id, token.key);
	}
	const oldByKey = previous?.byKey;
	editor.update(
		() => {
			const ids = new Map<string, string>(),
				idToKey = new Map<string, string>(),
				used = new Set<string>(),
				runtime = new Map<string, { key: string; offset: number }>(),
				kept = new Set<string | undefined>(),
				// Characters new in this render, by `key:offset`: their length.
				restored = new Map<string, number>();
			for (let i = 0; i < prevTokens.length; i++)
				kept.add(prevTokens[i]!.entry?.id);
			const build = (tree: Tree): LexicalNode => {
				let key: string | undefined;
				if (tree.id) {
					key = oldNodes.get(tree.id);
				} else {
					for (let i = 0; i < tree.tokens.length; i++) {
						const e = tree.tokens[i]!.entry;
						if (e) {
							const k = oldCharacters.get(e.id);
							if (k && !used.has(k)) {
								key = k;
								break;
							}
						}
					}
				}
				let node = key && !used.has(key) ? $getNodeByKey(key) : null;
				if (tree.json.type === "root") node = $getRoot();
				const prevTree =
					tree.json.type === "root"
						? previous?.tree
						: tree.id
							? oldById?.get(tree.id)
							: key
								? oldByKey?.get(key)
								: undefined;
				if (!node || node.getType() !== tree.json.type) {
					node = $parseSerializedNode({
						...tree.json,
						...(tree.json.children ? { children: [] } : {}),
					});
				} else if (!prevTree || !ownJSONEqual(tree.json, prevTree.json)) {
					node.updateFromJSON(tree.json);
				}
				const nodeKey = node.getKey();
				used.add(nodeKey);
				tree.key = nodeKey;
				if (tree.id) {
					ids.set(nodeKey, tree.id);
					idToKey.set(tree.id, nodeKey);
					if (tree.tokens[0]) tree.tokens[0].key = nodeKey;
				}
				if ($isElementNode(node)) {
					const children = tree.children.map(build);
					const old = node.getChildren();
					if (
						old.length !== children.length ||
						old.some(
							(child, index) => child.getKey() !== children[index]!.getKey(),
						)
					)
						node.splice(0, old.length, children);
				}
				if ($isTextNode(node)) {
					let offset = 0;
					for (let i = 0; i < tree.tokens.length; i++) {
						const token = tree.tokens[i]!;
						token.key = nodeKey;
						token.offset = offset;
						if (token.entry) {
							runtime.set(token.entry.id, { key: nodeKey, offset });
							if (!kept.has(token.entry.id))
								restored.set(`${nodeKey}:${offset}`, token.value.length);
						}
						offset += token.value.length;
					}
				}
				return node;
			};
			build(next.tree);
			// ponytail: skips restored text within one text node only; a restored
			// block or format change keeps the cursor before it.
			const after = (key: string, offset: number) => {
				if (restoring)
					for (let size; (size = restored.get(`${key}:${offset}`));)
						offset += size;
				return offset;
			};
			if (previous?.selection && "anchor" in previous.selection) {
				const point = (old: Point): Point | undefined => {
					if (old.type === "text") {
						const oldTree = oldByKey?.get(old.key);
						const tokens = oldTree
							? oldTree.tokens.filter(
									(token) => token.entry && !token.attributes[RT_NODE],
								)
							: prevTokens.filter(
									(token) =>
										token.key === old.key &&
										token.entry &&
										!token.attributes[RT_NODE],
								);
						const left = tokens.findLast(
								(token) => token.offset! + token.value.length <= old.offset,
							),
							right = tokens.find((token) => token.offset! >= old.offset);
						const a = left?.entry && runtime.get(left.entry.id),
							b = right?.entry && runtime.get(right.entry.id);
						if (a)
							return {
								key: a.key,
								offset: after(a.key, a.offset + left!.value.length),
								type: "text",
							};
						if (b) return { key: b.key, offset: b.offset, type: "text" };
					}
					const id = previous.ids.get(old.key),
						key = id ? idToKey.get(id) : undefined;
					const node = key && $getNodeByKey(key);
					if (node && $isElementNode(node))
						return {
							key: node.getKey(),
							offset: Math.min(old.offset, node.getChildrenSize()),
							type: "element",
						};
					return undefined;
				};
				const anchor = point(previous.selection.anchor),
					focus = point(previous.selection.focus);
				if (anchor && focus) {
					const selected = $createRangeSelection();
					selected.anchor.set(anchor.key, anchor.offset, anchor.type);
					selected.focus.set(focus.key, focus.offset, focus.type);
					selected.format = previous.selection.format;
					selected.style = previous.selection.style;
					$setSelection(selected);
				} else $getRoot().selectEnd();
			} else if (previous?.selection && "nodes" in previous.selection) {
				const selected = $createNodeSelection();
				for (const oldKey of previous.selection.nodes) {
					const id = previous.ids.get(oldKey),
						key = id ? idToKey.get(id) : undefined;
					if (key) selected.add(key);
				}
				$setSelection(selected);
			} else $setSelection(null);
			if (!previous) {
				const snapshot = captureDocument(context, ids, schemaId);
				matchDocument(next, snapshot);
				ensureTreeIndex(snapshot);
				adopt(snapshot);
			} else {
				next.ids = ids;
				next.selection = readSelection();
				ensureTreeIndex(next);
				adopt(next);
			}
		},
		{
			discrete: true,
			skipTransforms: true,
			tag: [REMOTE_TAG, COLLABORATION_TAG, SKIP_SCROLL_INTO_VIEW_TAG],
		},
	);
}
