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
import { type RichText } from "@pulsify/core";
import {
	RT_NODE,
	RT_PARENT,
	richTextContext,
	reconcileEditorTokens,
	invertEditorChange,
	type EditorChange,
	type RichTextContext,
} from "@pulsify/core/bindings";
import {
	captureDocument,
	matchDocument,
	readDocument,
	redirectOperations,
	sameJSON,
	type DocumentView,
	type Tree,
	type Point,
} from "./document.js";

const REMOTE_TAG = "pulsify:remote";
const bindings = new WeakMap<LexicalEditor, LexicalBinding>();
export interface LexicalBindingOptions {
	/** Bump this when changing the meaning of custom nodes. All peers must agree. */
	schemaId?: string;
	onError?: (error: unknown) => void;
	/** Collaborative undo grouping interval, in milliseconds. Default: 300. */
	undoDelay?: number;
	/** Maximum local undo groups retained. Default: 100. */
	maxUndo?: number;
}
export interface LexicalBinding {
	destroy(): void;
	undo(): boolean;
	redo(): boolean;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
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
		maxUndo = options.maxUndo ?? 100;
	if (
		!schemaId ||
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
		disposed = false,
		lastTime = 0,
		lastTyping = "";
	const undo: EditorChange[][] = [],
		redo: EditorChange[][] = [],
		cleanup: (() => void)[] = [];
	const fail = (error: unknown) => {
		binding.destroy();
		if (options.onError) options.onError(error);
		else throw error;
	};
	const notifyHistory = () => {
		editor.dispatchCommand(CAN_UNDO_COMMAND, undo.length > 0);
		editor.dispatchCommand(CAN_REDO_COMMAND, redo.length > 0);
	};
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
			);
			lastTime = 0;
		} catch (error) {
			fail(error);
		}
	};
	const replay = (from: EditorChange[][], to: EditorChange[][]): boolean => {
		if (disposed || !from.length) return false;
		const group = from.at(-1)!,
			inverted: EditorChange[] = [];
		writing = true;
		try {
			richTextContext(field);
			for (const change of [...group].reverse())
				inverted.push(invertEditorChange(context, change));
			from.pop();
			to.push(inverted);
			lastTime = 0;
		} finally {
			writing = false;
		}
		pull(false);
		notifyHistory();
		return true;
	};
	const binding: LexicalBinding = {
		get canUndo() {
			return undo.length > 0;
		},
		get canRedo() {
			return redo.length > 0;
		},
		undo: () => replay(undo, redo),
		redo: () => replay(redo, undo),
		destroy() {
			if (disposed) return;
			disposed = true;
			for (const unregister of cleanup.splice(0)) unregister();
			if (bindings.get(editor) === binding) bindings.delete(editor);
			undo.length = 0;
			redo.length = 0;
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
						if (
							change.inserted.length ||
							change.deleted.length ||
							change.attributes.length
						) {
							const entries = [...change.inserted, ...change.deleted].map(
								(id) => context.node.entries.get(id)!,
							);
							const typing =
								entries.length === 1 &&
								!entries[0]!.marks.has(RT_NODE) &&
								!change.attributes.length
									? `${change.inserted.length ? "insert" : "delete"}:${entries[0]!.marks.get(RT_PARENT)?.value}`
									: "";
							const now = Date.now();
							if (
								undo.length &&
								!tags.has(HISTORY_PUSH_TAG) &&
								(tags.has(HISTORY_MERGE_TAG) ||
									(typing &&
										typing === lastTyping &&
										now - lastTime < undoDelay))
							)
								undo.at(-1)!.push(change);
							else undo.push([change]);
							while (undo.length > maxUndo) undo.shift();
							redo.length = 0;
							lastTime = now;
							lastTyping = typing;
						}
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
					undo.length = 0;
					redo.length = 0;
					lastTime = 0;
					notifyHistory();
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
		);
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
				runtime = new Map<string, { key: string; offset: number }>();
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
						if (token.entry)
							runtime.set(token.entry.id, { key: node.getKey(), offset });
						offset += token.value.length;
					}
				}
				return node;
			};
			build(next.tree);
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
								offset: a.offset + left!.value.length,
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
