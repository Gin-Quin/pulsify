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
	richTextContext,
	reconcileEditorTokens,
	createPulsifyHistory,
	connectEditorHistory,
	type PulsifyHistory,
	type RichTextContext,
} from "pulsify-core/bindings";
import {
	anchorOfPoint,
	captureDocument,
	matchDocument,
	pointOfAnchor,
	readDocument,
	redirectOperations,
	sameJSON,
	type DocumentView,
	type Tree,
	type Point,
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
		rendered: DocumentView;
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
			rendered!.tokens,
			matchDocument(native, rendered!),
		);
		writing = false;
		native = readDocument(context, schemaId);
		matchDocument(native, rendered!);
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
					const current = editorState.read(() =>
						captureDocument(context, rendered.ids, schemaId),
					);
					if (tags.has(REMOTE_TAG)) {
						matchDocument(native, current);
						rendered = current;
						return;
					}
					if (!dirtyElements.size && !dirtyLeaves.size) {
						rendered.selection = current.selection;
						return;
					}
					try {
						richTextContext(field);
						writing = true;
						const keys = matchDocument(rendered, current);
						const change = reconcileEditorTokens(
							context,
							current.tokens,
							keys,
							redirectOperations(context, rendered, current),
							true,
							rendered.tokens,
						);
						native = readDocument(context, schemaId);
						matchDocument(native, current);
						rendered = current;
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
	// Validate custom node imports outside the live update, even if the app's
	// Lexical onError logs errors instead of throwing them.
	const validate = (tree: Tree) => {
		if (!getRegisteredNode(editor, tree.json.type))
			throw new TypeError(`Lexical node ${tree.json.type} is not registered`);
		for (const child of tree.children) validate(child);
	};
	validate(next.tree);
	let valid = false;
	editor.parseEditorState(
		{ root: next.tree.json } as unknown as SerializedEditorState,
		() => {
			valid = true;
		},
	);
	if (!valid) throw new TypeError("Lexical rejected this rich text document");
	const oldNodes = new Map(
		previous ? [...previous.ids].map(([key, id]) => [id, key]) : [],
	);
	const oldCharacters = new Map(
		previous?.tokens
			.filter((token) => token.entry && token.key)
			.map((token) => [token.entry!.id, token.key!]) ?? [],
	);
	editor.update(
		() => {
			const ids = new Map<string, string>(),
				used = new Set<string>(),
				runtime = new Map<string, { key: string; offset: number }>(),
				kept = new Set(previous?.tokens.map((token) => token.entry?.id)),
				// Characters new in this render, by `key:offset`: their length.
				restored = new Map<string, number>();
			const build = (tree: Tree): LexicalNode => {
				const key = tree.id
					? oldNodes.get(tree.id)
					: tree.tokens
							.map((token) => token.entry && oldCharacters.get(token.entry.id))
							.find(Boolean);
				let node = key && !used.has(key) ? $getNodeByKey(key) : null;
				if (tree.json.type === "root") node = $getRoot();
				if (!node || node.getType() !== tree.json.type)
					node = $parseSerializedNode({
						...tree.json,
						...(tree.json.children ? { children: [] } : {}),
					});
				else node.updateFromJSON(tree.json);
				used.add(node.getKey());
				if (tree.id) ids.set(node.getKey(), tree.id);
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
					for (const token of tree.tokens) {
						if (token.entry) {
							runtime.set(token.entry.id, { key: node.getKey(), offset });
							if (!kept.has(token.entry.id))
								restored.set(`${node.getKey()}:${offset}`, token.value.length);
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
						const tokens = previous.tokens.filter(
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
						key = id && [...ids].find(([, value]) => value === id)?.[0];
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
						key = [...ids].find(([, value]) => value === id)?.[0];
					if (key) selected.add(key);
				}
				$setSelection(selected);
			} else $setSelection(null);
			const snapshot = captureDocument(context, ids, schemaId);
			matchDocument(next, snapshot);
			adopt(snapshot);
		},
		{
			discrete: true,
			skipTransforms: true,
			tag: [REMOTE_TAG, COLLABORATION_TAG, SKIP_SCROLL_INTO_VIEW_TAG],
		},
	);
}
