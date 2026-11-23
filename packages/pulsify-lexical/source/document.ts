import {
	$getRoot,
	$getSelection,
	$isRangeSelection,
	$isNodeSelection,
	$isElementNode,
	$isTextNode,
	type LexicalNode,
	type PointType,
	type SerializedLexicalNode,
} from "lexical";
import diff from "fast-diff";
import {
	RT_ATTR,
	RT_MARK,
	RT_NODE,
	RT_PARENT,
	RT_TYPE,
	RT_TEXTBLOCK,
	RT_FORMAT,
	RT_PREFIX,
	RT_REDIRECT,
	RT_REMOVED,
	commitEditorOperations,
	editorAttributes,
	isRichTextNode,
	matchTokens,
	newerTextStamp,
	pushAttributeOps,
	pushDeleteOps,
	resolveRichTextAnchor,
	richTextRedirects,
	richTextRemovedNodes,
	type EditorChange,
	type EditorToken,
	type CoreEntry,
	type Stamp,
	type RichTextContext,
	type CoreOperation,
} from "pulsify-core/bindings";

export type JSONNode = SerializedLexicalNode & {
	[key: string]: unknown;
	children?: JSONNode[];
	text?: string;
};
export type Tree = {
	/** The Lexical runtime key, for a tree captured from an editor. */
	key?: string;
	id?: string;
	json: JSONNode;
	children: Tree[];
	tokens: Token[];
};
export type Token = EditorToken & { key?: string; offset?: number };
export type Point = { key: string; offset: number; type: "text" | "element" };
export type Selection =
	| { anchor: Point; focus: Point; format: number; style: string }
	| { nodes: string[] }
	| null;
export type DocumentView = {
	tree: Tree;
	tokens: Token[];
	ids: Map<string, string>;
	selection: Selection;
	byId?: Map<string, Tree>;
	byKey?: Map<string, Tree>;
	parentOf?: Map<Tree, { parent: Tree; index: number }>;
	tokensDirty?: boolean;
};
const schemaKey = RT_PREFIX + "schema";
const elementKey = RT_PREFIX + "element";
type Attributes = Record<string, unknown>;

const TEXT_DEFAULTS: Record<string, unknown> = {
	type: "text",
	version: 1,
	detail: 0,
	mode: "normal",
	style: "",
};
const PLAIN_TEXT_JSON: Readonly<JSONNode> = Object.freeze({
	type: "text",
	version: 1,
	detail: 0,
	mode: "normal",
	style: "",
	format: 0,
});

function unpack(attributes: Attributes, prefix: string): Attributes {
	const entries: [string, unknown][] = [];
	for (const [key, value] of Object.entries(attributes)) {
		if (key.startsWith(prefix) && Array.isArray(value))
			entries.push([key.slice(prefix.length), value[0]]);
	}
	if (entries.length > 1) entries.sort(([a], [b]) => a.localeCompare(b));
	const result: Attributes = {};
	for (let i = 0; i < entries.length; i++)
		result[entries[i]![0]] = entries[i]![1];
	return result;
}
function textAttributes(json: JSONNode, parent: string): Attributes {
	const attributes: Attributes = { [RT_PARENT]: parent };
	for (const [key, value] of Object.entries(json)) {
		if (key === "text") continue;
		if (key === "format") {
			const bits = Number(value);
			if (bits)
				for (let bit = 0; bit < 32; bit++)
					if ((bits >>> bit) & 1) attributes[RT_MARK + "f" + bit] = [true];
		} else if (
			!(key in TEXT_DEFAULTS) ||
			!Object.is(value, TEXT_DEFAULTS[key])
		) {
			attributes[RT_MARK + key] = [value];
		}
	}
	return attributes;
}
function textJSON(attributes: Attributes): JSONNode {
	const properties = unpack(attributes, RT_MARK);
	let format = 0;
	for (let bit = 0; bit < 32; bit++) {
		if (properties["f" + bit]) format |= 1 << bit;
		delete properties["f" + bit];
	}
	return {
		type: "text",
		version: 1,
		detail: 0,
		mode: "normal",
		style: "",
		...properties,
		format,
	} as JSONNode;
}
function entryTextDescriptor(entry: CoreEntry): {
	json: JSONNode;
	sig: string;
	attributes: Attributes | undefined;
} {
	let hasMark = false;
	for (const [key, mark] of entry.marks) {
		if (mark.value != null && key.startsWith(RT_MARK)) {
			hasMark = true;
			break;
		}
	}
	if (!hasMark)
		return {
			json: PLAIN_TEXT_JSON as JSONNode,
			sig: "",
			attributes: undefined,
		};
	const attributes = editorAttributes(entry);
	const json = textJSON(attributes);
	return { json, sig: JSON.stringify(json), attributes };
}
function nodeAttributes(
	json: JSONNode,
	id: string,
	parent: string,
	textblock: boolean,
	schemaId: string,
): Attributes {
	const result: Attributes = {
		[RT_NODE]: id,
		[RT_PARENT]: parent,
		[RT_TYPE]: json.type,
		[RT_TEXTBLOCK]: textblock,
	};
	for (const [key, value] of Object.entries(json))
		if (key !== "children" && key !== "type") result[RT_ATTR + key] = [value];
	if (json.type === "root") {
		result[RT_FORMAT] = "lexical";
		result[schemaKey] = schemaId;
	}
	return result;
}

/** Read the current Lexical selection; must run in a read/update context. */
export function readSelection(): Selection {
	const selected = $getSelection();
	const point = (value: PointType): Point => ({
		key: value.key,
		offset: value.offset,
		type: value.type,
	});
	return $isRangeSelection(selected)
		? {
				anchor: point(selected.anchor),
				focus: point(selected.focus),
				format: selected.format,
				style: selected.style,
			}
		: $isNodeSelection(selected)
			? { nodes: selected.getNodes().map((node) => node.getKey()) }
			: null;
}

/** Capture a single Lexical subtree; must run in a Lexical read/update context. */
export function captureSubtree(
	node: LexicalNode,
	parentId: string,
	context: RichTextContext,
	known: Map<string, string>,
	schemaId: string,
	ids: Map<string, string>,
	tokens: Token[],
	serialBox: { value: number },
): Tree {
	const key = node.getKey(),
		json = { ...node.exportJSON() } as JSONNode;
	if ("$slots" in json)
		throw new TypeError(
			"Lexical slot nodes require a dedicated Pulsify adapter mapping",
		);
	if ($isTextNode(node)) {
		const attributes = textAttributes(json, parentId),
			own: Token[] = [];
		let offset = 0;
		for (const value of node.getTextContent()) {
			const token: Token = { value, attributes, key, offset };
			tokens.push(token);
			own.push(token);
			offset += value.length;
		}
		return { key, json, children: [], tokens: own };
	}
	const id =
		node.getType() === "root"
			? `${context.node.id}/root`
			: (known.get(key) ??
				`${context.model.sid}:${context.model.nextClock}/node/${serialBox.value++}`);
	ids.set(key, id);
	const textblock =
		$isElementNode(node) &&
		node.getType() !== "root" &&
		!node.isInline() &&
		node
			.getChildren()
			.every((child) => !$isElementNode(child) || child.isInline());
	const token: Token = {
		value: "\uFFFC",
		attributes: {
			...nodeAttributes(json, id, parentId, textblock, schemaId),
			[elementKey]: $isElementNode(node),
		},
		key,
	};
	tokens.push(token);
	const children = $isElementNode(node)
		? node
				.getChildren()
				.map((child) =>
					captureSubtree(
						child,
						id,
						context,
						known,
						schemaId,
						ids,
						tokens,
						serialBox,
					),
				)
		: [];
	if ($isElementNode(node)) json.children = children.map((child) => child.json);
	return { key, id, json, children, tokens: [token] };
}

/** Must run in a Lexical read/update context. Runtime keys never go on the wire. */
export function captureDocument(
	context: RichTextContext,
	known: Map<string, string>,
	schemaId: string,
): DocumentView {
	const ids = new Map<string, string>(),
		tokens: Token[] = [];
	const tree = captureSubtree(
		$getRoot(),
		"",
		context,
		known,
		schemaId,
		ids,
		tokens,
		{ value: 0 },
	);
	const view: DocumentView = { tree, tokens, ids, selection: readSelection() };
	ensureTreeIndex(view);
	return view;
}

/** Build/rebuild O(1) lookup tables (`byId`, `byKey`, `parentOf`) for `view`. */
export function ensureTreeIndex(view: DocumentView): void {
	const byId = new Map<string, Tree>();
	const byKey = new Map<string, Tree>();
	const parentOf = new Map<Tree, { parent: Tree; index: number }>();
	const visit = (tree: Tree) => {
		if (tree.id !== undefined) byId.set(tree.id, tree);
		if (tree.key !== undefined) byKey.set(tree.key, tree);
		for (let i = 0; i < tree.children.length; i++) {
			const child = tree.children[i]!;
			parentOf.set(child, { parent: tree, index: i });
			visit(child);
		}
	};
	visit(view.tree);
	view.byId = byId;
	view.byKey = byKey;
	view.parentOf = parentOf;
}

/** Replace one direct child of `parent` in `view`'s cached tree indexes. */
export function replaceSubtreeInView(
	view: DocumentView,
	parent: Tree,
	index: number,
	oldTree: Tree,
	newTree: Tree,
): void {
	const { byId, byKey, parentOf, ids } = view;
	const remove = (tree: Tree) => {
		if (tree.id !== undefined && byId?.get(tree.id) === tree)
			byId.delete(tree.id);
		if (tree.key !== undefined) {
			if (byKey?.get(tree.key) === tree) byKey.delete(tree.key);
			ids.delete(tree.key);
		}
		parentOf?.delete(tree);
		for (let i = 0; i < tree.children.length; i++) remove(tree.children[i]!);
	};
	const add = (tree: Tree, owner: Tree, idx: number) => {
		if (tree.id !== undefined) byId?.set(tree.id, tree);
		if (tree.key !== undefined) {
			byKey?.set(tree.key, tree);
			if (tree.id !== undefined) ids.set(tree.key, tree.id);
		}
		parentOf?.set(tree, { parent: owner, index: idx });
		for (let i = 0; i < tree.children.length; i++)
			add(tree.children[i]!, tree, i);
	};
	remove(oldTree);
	parent.children[index] = newTree;
	if (parent.json.children) parent.json.children[index] = newTree.json;
	add(newTree, parent, index);
	view.tokensDirty = true;
	indexes.delete(view);
	structures.delete(view);
}

/** Flatten all tokens in a subtree in pre-order. */
export function flattenSubtreeTokens(tree: Tree, out: Token[] = []): Token[] {
	for (let i = 0; i < tree.tokens.length; i++) out.push(tree.tokens[i]!);
	for (let i = 0; i < tree.children.length; i++)
		flattenSubtreeTokens(tree.children[i]!, out);
	return out;
}

/** Ensure `view.tokens` reflects any incremental edits to `view.tree`. */
export function ensureTokens(view: DocumentView): Token[] {
	if (view.tokensDirty) {
		view.tokens = flattenSubtreeTokens(view.tree);
		view.tokensDirty = false;
	}
	return view.tokens;
}

/** Build TextNode `Tree` children for a textblock from its ordered character entries. */
export function buildTextChildrenFromEntries(
	entries: readonly CoreEntry[],
	parentId: string,
): Tree[] {
	const children: Tree[] = [];
	const defaultAttrs = { [RT_PARENT]: parentId };
	let run: Tree | undefined,
		properties = "",
		chunks: string[] = [];
	const flush = () => {
		if (run) run.json.text = chunks.join("");
		chunks = [];
	};
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const desc = entryTextDescriptor(entry);
		if (!run || desc.sig !== properties) {
			flush();
			run = { json: { ...desc.json, text: "" }, children: [], tokens: [] };
			children.push(run);
			properties = desc.sig;
		}
		chunks.push(entry.value as string);
		run.tokens.push({
			value: entry.value as string,
			attributes: desc.attributes ?? defaultAttrs,
			entry,
		});
	}
	flush();
	return children;
}

/** Read the native tree; no Lexical editor or DOM is needed. */
export function readDocument(
	context: RichTextContext,
	schemaId?: string,
): DocumentView {
	const { node } = context;
	const rootId = `${node.id}/root`,
		records = new Map<
			string,
			{
				attributes: Attributes;
				stamps: Map<string, Stamp>;
				entry: CoreEntry;
				index: number;
			}
		>();
	const characters: { entry: CoreEntry; index: number }[] = [],
		removed = richTextRemovedNodes(node),
		redirects = richTextRedirects(node);
	let structured = false;
	const visible = node.visible;
	for (let index = 0; index < visible.length; index++) {
		const entry = visible[index]!;
		if (!isRichTextNode(entry)) {
			characters.push({ entry, index });
			continue;
		}
		structured = true;
		const id = String(entry.marks.get(RT_NODE)!.value);
		if (removed.has(id)) continue;
		let record = records.get(id);
		if (!record)
			records.set(
				id,
				(record = { attributes: {}, stamps: new Map(), entry, index }),
			);
		for (const [key, mark] of entry.marks) {
			const stamp = record.stamps.get(key);
			if (!stamp || newerTextStamp(mark.stamp, stamp)) {
				record.stamps.set(key, mark.stamp);
				record.attributes[key] = mark.value;
			}
		}
	}
	if (!structured) {
		const text = visible.map((entry) => entry.value as string).join("");
		const textNode: Tree = {
			json: {
				type: "text",
				version: 1,
				text,
				format: 0,
				style: "",
				mode: "normal",
				detail: 0,
			},
			children: [],
			tokens: [],
		};
		const paragraph: Tree = {
			id: `${node.id}/plain`,
			json: {
				type: "paragraph",
				version: 1,
				format: "",
				indent: 0,
				direction: null,
				children: text ? [textNode.json] : [],
			},
			children: text ? [textNode] : [],
			tokens: [],
		};
		const tree: Tree = {
			id: rootId,
			json: {
				type: "root",
				version: 1,
				format: "",
				indent: 0,
				direction: null,
				children: [paragraph.json],
			},
			children: [paragraph],
			tokens: [],
		};
		tree.tokens.push({
			value: "\uFFFC",
			attributes: nodeAttributes(
				tree.json,
				rootId,
				"",
				false,
				schemaId ?? "lexical:1",
			),
		});
		paragraph.tokens.push({
			value: "\uFFFC",
			attributes: nodeAttributes(
				paragraph.json,
				paragraph.id!,
				rootId,
				true,
				schemaId ?? "lexical:1",
			),
		});
		const attrs = textAttributes(textNode.json, paragraph.id!);
		for (let i = 0; i < visible.length; i++) {
			const entry = visible[i]!;
			textNode.tokens.push({
				value: entry.value as string,
				attributes: attrs,
				entry,
			});
		}
		return {
			tree,
			tokens: [...tree.tokens, ...paragraph.tokens, ...textNode.tokens],
			ids: new Map(),
			selection: null,
		};
	}
	const root = records.get(rootId);
	if (!root || root.attributes[RT_FORMAT] !== "lexical")
		throw new TypeError(
			"This richText field uses a different editor format; expected Lexical",
		);
	if (schemaId !== undefined && root.attributes[schemaKey] !== schemaId)
		throw new TypeError(
			"Incompatible Lexical schemaId for this richText field",
		);
	const resolve = (id: string) => {
		if (!redirects.size) return id;
		const seen = new Set<string>();
		while (redirects.has(id) && !seen.has(id)) {
			seen.add(id);
			id = redirects.get(id)!;
		}
		return id;
	};
	type Child = { index: number; id?: string; entry?: CoreEntry };
	const children = new Map<string, Child[]>();
	const add = (parent: string, child: Child) => {
		const list = children.get(parent);
		if (list) list.push(child);
		else children.set(parent, [child]);
	};
	for (const [id, record] of records)
		if (id !== rootId)
			add(resolve(String(record.attributes[RT_PARENT])), {
				index: record.index,
				id,
			});
	const plainParent = `${node.id}/plain`;
	for (let i = 0; i < characters.length; i++) {
		const { entry, index } = characters[i]!;
		add(resolve(String(entry.marks.get(RT_PARENT)?.value ?? plainParent)), {
			index,
			entry,
		});
	}
	const tokens: Token[] = [],
		stack = new Set<string>();
	const build = (id: string): Tree => {
		if (stack.has(id)) throw new TypeError("Cyclic rich text document");
		stack.add(id);
		const record = records.get(id)!;
		const json = {
			...unpack(record.attributes, RT_ATTR),
			type: String(record.attributes[RT_TYPE]),
		} as JSONNode;
		const token: Token = {
			value: "\uFFFC",
			attributes: record.attributes,
			entry: record.entry,
		};
		tokens.push(token);
		const tree: Tree = { id, json, children: [], tokens: [token] };
		const list = children.get(id);
		if (list) {
			// Check if already sorted (almost always true).
			let sorted = true;
			for (let i = 1; i < list.length; i++) {
				if (list[i]!.index < list[i - 1]!.index) {
					sorted = false;
					break;
				}
			}
			if (!sorted) list.sort((a, b) => a.index - b.index);
			const defaultAttrs = { [RT_PARENT]: id };
			let run: Tree | undefined,
				properties = "",
				chunks: string[] = [];
			const flushRun = () => {
				if (run) run.json.text = chunks.join("");
				chunks = [];
			};
			for (let i = 0; i < list.length; i++) {
				const child = list[i]!;
				if (child.id) {
					flushRun();
					tree.children.push(build(child.id));
					run = undefined;
					continue;
				}
				const entry = child.entry!;
				const desc = entryTextDescriptor(entry);
				if (!run || desc.sig !== properties) {
					flushRun();
					run = { json: { ...desc.json, text: "" }, children: [], tokens: [] };
					tree.children.push(run);
					properties = desc.sig;
				}
				chunks.push(entry.value as string);
				const textToken: Token = {
					value: entry.value as string,
					attributes: desc.attributes ?? defaultAttrs,
					entry,
				};
				run.tokens.push(textToken);
				tokens.push(textToken);
			}
			flushRun();
		}
		// An element's serialized children survive even when empty.
		if (
			tree.children.length ||
			record.attributes[elementKey] === true ||
			json.type === "root" ||
			record.attributes[RT_TEXTBLOCK] === true
		)
			json.children = tree.children.map((child) => child.json);
		stack.delete(id);
		return tree;
	};
	const tree = build(rootId);
	if (!tree.children.length) {
		let id = `${node.id}/empty`,
			suffix = 0;
		while (removed.has(id)) id = `${node.id}/empty/${++suffix}`;
		const json: JSONNode = {
			type: "paragraph",
			version: 1,
			children: [],
			format: "",
			indent: 0,
			direction: null,
		};
		const token: Token = {
			value: "\uFFFC",
			attributes: nodeAttributes(
				json,
				id,
				rootId,
				true,
				String(root.attributes[schemaKey]),
			),
		};
		const paragraph: Tree = { id, json, tokens: [token], children: [] };
		tree.children.push(paragraph);
		tree.json.children = [json];
		tokens.push(token);
	}
	return { tree, tokens, ids: new Map(), selection: null };
}

function matchTokenLists(
	beforeTokens: readonly Token[],
	afterTokens: readonly Token[],
	beforeSelection: Selection,
	afterSelection: Selection,
): string[] {
	const occupied = new Set<string>();
	for (let i = 0; i < beforeTokens.length; i++) {
		const token = beforeTokens[i]!;
		if (!token.attributes[RT_NODE]) occupied.add(token.value);
	}
	for (let i = 0; i < afterTokens.length; i++) {
		const token = afterTokens[i]!;
		if (!token.attributes[RT_NODE]) occupied.add(token.value);
	}
	const symbols = new Map<string, string>();
	let next = 0xe000;
	const symbol = (id: string): string => {
		let value = symbols.get(id);
		if (!value) {
			while (next <= 0xffff && occupied.has(String.fromCharCode(next))) next++;
			if (next > 0xffff)
				throw new RangeError(
					"Too many structural nodes in one rich text document",
				);
			symbols.set(id, (value = String.fromCharCode(next++)));
		}
		return value;
	};
	const encode = (list: readonly Token[]) => {
		const parts: string[] = new Array(list.length);
		for (let i = 0; i < list.length; i++) {
			const token = list[i]!;
			parts[i] = token.attributes[RT_NODE]
				? symbol(String(token.attributes[RT_NODE]))
				: token.value;
		}
		return parts.join("");
	};
	const oldText = encode(beforeTokens),
		newText = encode(afterTokens);
	const range = (
		list: readonly Token[],
		selection: Selection,
	): { index: number; length: number } | undefined => {
		if (!selection || !("anchor" in selection)) return undefined;
		const position = (point: Point) => {
			let index = 0;
			for (let i = 0; i < list.length; i++) {
				const token = list[i]!;
				if (
					token.key === point.key &&
					point.type === "text" &&
					token.offset! >= point.offset
				)
					return index;
				if (
					token.key === point.key &&
					token.attributes[RT_NODE] &&
					point.type === "element"
				)
					return index + 1;
				index += token.attributes[RT_NODE] ? 1 : token.value.length;
				if (
					token.key === point.key &&
					point.type === "text" &&
					token.offset! + token.value.length === point.offset
				)
					return index;
			}
			return index;
		};
		const anchor = position(selection.anchor),
			focus = position(selection.focus);
		return { index: Math.min(anchor, focus), length: Math.abs(anchor - focus) };
	};
	const oldRange = range(beforeTokens, beforeSelection),
		newRange = range(afterTokens, afterSelection);
	const changes = diff(
		oldText,
		newText,
		oldRange && newRange ? { oldRange, newRange } : undefined,
	);
	const oldAt = new Map<number, Token>(),
		newAt = new Map<number, number>();
	let pos = 0;
	for (let i = 0; i < beforeTokens.length; i++) {
		const token = beforeTokens[i]!;
		oldAt.set(pos, token);
		pos += token.attributes[RT_NODE] ? 1 : token.value.length;
	}
	pos = 0;
	const keys: string[] = new Array(afterTokens.length);
	for (let i = 0; i < afterTokens.length; i++) {
		const token = afterTokens[i]!;
		newAt.set(pos, i);
		pos += token.attributes[RT_NODE] ? 1 : token.value.length;
		keys[i] = token.attributes[RT_NODE]
			? `node:${token.attributes[RT_NODE]}`
			: `new:${i}`;
	}
	let oldPos = 0,
		newPos = 0;
	for (const [kind, value] of changes) {
		if (kind === 0)
			for (const char of value) {
				const old = oldAt.get(oldPos),
					index = newAt.get(newPos);
				if (old?.entry && index !== undefined) {
					const afterToken = afterTokens[index]!;
					if (!afterToken.attributes[RT_NODE]) {
						keys[index] = `char:${old.entry.id}`;
						afterToken.entry = old.entry;
					} else if (
						old.attributes[RT_NODE] === afterToken.attributes[RT_NODE]
					) {
						afterToken.entry = old.entry;
					}
				}
				oldPos += char.length;
				newPos += char.length;
			}
		else if (kind < 0) oldPos += value.length;
		else newPos += value.length;
	}
	return keys;
}

/** Character identities survive formatting, splits/joins and repeated typing. */
export function matchDocument(
	before: DocumentView,
	after: DocumentView,
): string[] {
	return matchTokenLists(
		ensureTokens(before),
		ensureTokens(after),
		before.selection,
		after.selection,
	);
}

/**
 * Reconcile a set of modified subtrees directly against the CRDT without
 * scanning untouched blocks. Returns `undefined` if any precondition fails.
 */
export function reconcileDirtySubtrees(
	context: RichTextContext,
	pairs: readonly { oldBlock: Tree; newBlock: Tree }[],
	prevSelection: Selection,
	nextSelection: Selection,
): EditorChange | undefined {
	const { node, model } = context;
	const operations: CoreOperation[] = [];
	const deletes: string[] = [];
	const removedAnchors: string[] = [];
	const formatting = new Map<
		string,
		{ entries: string[]; attributes: Attributes }
	>();
	const newTokenLinks: Token[] = [];
	const sid = model.sid;
	const clock = model.nextClock;
	const idPrefix = `${sid}:${clock}:`;
	let entrySerial = 0;

	for (let p = 0; p < pairs.length; p++) {
		const { oldBlock, newBlock } = pairs[p]!;
		const anchorEntry = oldBlock.tokens[0]?.entry;
		if (
			!anchorEntry ||
			anchorEntry.deleted ||
			!oldBlock.id ||
			oldBlock.id !== newBlock.id
		)
			return undefined;
		const oldTokens = flattenSubtreeTokens(oldBlock);
		const newTokens = flattenSubtreeTokens(newBlock);
		for (let i = 0; i < oldTokens.length; i++) {
			const e = oldTokens[i]!.entry;
			if (!e || e.deleted) return undefined;
		}
		const newKeys = matchTokenLists(
			oldTokens,
			newTokens,
			prevSelection,
			nextSelection,
		);
		const oldKeys = oldTokens.map((token) =>
			token.attributes[RT_NODE]
				? `node:${token.attributes[RT_NODE]}`
				: `char:${token.entry!.id}`,
		);
		const matches = matchTokens(oldKeys, newKeys);
		const retained = new Set(matches.values());
		const used = new Set<string>();
		for (let i = 0; i < newTokens.length; i++) {
			const nid = newTokens[i]!.attributes[RT_NODE];
			if (typeof nid === "string") used.add(nid);
		}
		// Redirects for removed inline nodes inside this block
		const moved = new Map<string, Set<string>>();
		const prevById = new Map<string, Token>();
		for (let i = 0; i < oldTokens.length; i++) {
			const t = oldTokens[i]!;
			if (t.entry) prevById.set(t.entry.id, t);
		}
		for (let i = 0; i < newTokens.length; i++) {
			const t = newTokens[i]!;
			if (!t.entry || t.attributes[RT_NODE]) continue;
			const old = prevById.get(t.entry.id);
			const oldParent = old?.attributes[RT_PARENT];
			const parent = t.attributes[RT_PARENT];
			if (
				typeof oldParent !== "string" ||
				typeof parent !== "string" ||
				used.has(oldParent) ||
				oldParent === parent
			)
				continue;
			let targets = moved.get(oldParent);
			if (!targets) moved.set(oldParent, (targets = new Set()));
			targets.add(parent);
		}
		for (const [removedId, targets] of moved) {
			if (targets.size !== 1) continue;
			const targetId = [...targets][0]!;
			const entries = oldTokens
				.filter((t) => t.attributes[RT_NODE] === removedId && t.entry)
				.map((t) => t.entry!.id);
			if (entries.length)
				operations.push({
					kind: 5,
					target: node.id,
					entries,
					attributes: { [RT_REDIRECT]: targetId },
				});
		}
		for (let i = 0; i < oldTokens.length; i++) {
			const token = oldTokens[i]!;
			if (!retained.has(i)) deletes.push(token.entry!.id);
			const nid = token.attributes[RT_NODE];
			if (typeof nid === "string" && !used.has(nid))
				removedAnchors.push(token.entry!.id);
		}
		let after = anchorEntry.id;
		let insertion:
			| {
					op: Extract<CoreOperation, { kind: 12 }>;
					key: string;
					raw: Attributes;
					chunks: string[];
			  }
			| undefined;
		const flushInsertion = () => {
			if (!insertion) return;
			if (insertion.chunks.length > 1)
				insertion.op.text = insertion.chunks.join("");
			else if (insertion.chunks.length === 1)
				insertion.op.text = insertion.chunks[0]!;
			insertion = undefined;
		};
		for (let i = 0; i < newTokens.length; i++) {
			const token = newTokens[i]!;
			const oldIndex = matches.get(i);
			const entry =
				oldIndex === undefined ? undefined : oldTokens[oldIndex]!.entry;
			if (!entry) {
				const entryId = idPrefix + entrySerial++;
				newTokenLinks.push(token);
				if (insertion && insertion.raw === token.attributes) {
					insertion.chunks.push(token.value);
				} else {
					const filtered: Attributes = {};
					let hasAny = false;
					for (const [k, v] of Object.entries(token.attributes)) {
						if (!k.startsWith(RT_PREFIX) || v === undefined || v === null)
							continue;
						filtered[k] = v;
						hasAny = true;
					}
					const key = hasAny ? JSON.stringify(filtered) : "";
					if (insertion && insertion.key === key) {
						insertion.chunks.push(token.value);
						insertion.raw = token.attributes;
					} else {
						flushInsertion();
						const op: Extract<CoreOperation, { kind: 12 }> = {
							kind: 12,
							target: node.id,
							after,
							text: token.value,
							...(hasAny ? { attributes: filtered } : {}),
						};
						operations.push(op);
						insertion = {
							op,
							key,
							raw: token.attributes,
							chunks: [token.value],
						};
					}
				}
				after = entryId;
				continue;
			}
			flushInsertion();
			token.entry = entry;
			const oldToken = oldTokens[oldIndex!]!;
			if (oldToken.attributes !== token.attributes) {
				const before = editorAttributes(entry);
				const updates: Attributes = {};
				let hasUpdate = false;
				for (const attribute of new Set([
					...Object.keys(before),
					...Object.keys(token.attributes),
				])) {
					if (!attribute.startsWith(RT_PREFIX)) continue;
					const value = token.attributes[attribute] ?? null;
					if (
						JSON.stringify(before[attribute] ?? null) !== JSON.stringify(value)
					) {
						updates[attribute] = value;
						hasUpdate = true;
					}
				}
				if (hasUpdate) {
					const group = JSON.stringify(updates);
					const existing = formatting.get(group);
					if (existing) existing.entries.push(entry.id);
					else
						formatting.set(group, {
							entries: [entry.id],
							attributes: updates,
						});
				}
			}
			after = entry.id;
		}
		flushInsertion();
	}
	const finalOps: CoreOperation[] = [];
	pushDeleteOps(finalOps, node.id, deletes);
	if (removedAnchors.length)
		pushAttributeOps(finalOps, node.id, removedAnchors, { [RT_REMOVED]: true });
	for (let i = 0; i < operations.length; i++) finalOps.push(operations[i]!);
	for (const group of formatting.values())
		pushAttributeOps(finalOps, node.id, group.entries, group.attributes);
	const change = commitEditorOperations(context, finalOps);
	for (let i = 0; i < newTokenLinks.length; i++) {
		newTokenLinks[i]!.entry = node.entries.get(change.inserted[i]!)!;
	}
	return change;
}

type Place = {
	tree: Tree;
	parent: Tree | undefined;
	/** Its index in the parent. */
	index: number;
	/** The tokens of the subtree are `tokens[start]` to `tokens[end - 1]`. */
	start: number;
	end: number;
};
type ViewIndex = {
	places: Map<Tree, Place>;
	keys: Map<string, Place>;
	nodes: Map<string, Place>;
	characters: Map<string, Token>;
};
const indexes = new WeakMap<DocumentView, ViewIndex>();
/** Built once per rendered view: a view is replaced, never edited, after a change. */
function indexView(view: DocumentView): ViewIndex {
	const tokens = ensureTokens(view);
	let index = indexes.get(view);
	if (index) return index;
	index = {
		places: new Map(),
		keys: new Map(),
		nodes: new Map(),
		characters: new Map(),
	};
	const { places, keys, nodes, characters } = index;
	let count = 0;
	const visit = (tree: Tree, parent: Tree | undefined, at: number) => {
		const place: Place = { tree, parent, index: at, start: count, end: 0 };
		count += tree.tokens.length;
		tree.children.forEach((child, position) => visit(child, tree, position));
		place.end = count;
		places.set(tree, place);
		if (tree.key !== undefined) keys.set(tree.key, place);
		if (tree.id !== undefined) nodes.set(tree.id, place);
	};
	visit(view.tree, undefined, 0);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.entry && !token.attributes[RT_NODE])
			characters.set(token.entry.id, token);
	}
	indexes.set(view, index);
	return index;
}
const structures = new WeakMap<DocumentView, Map<string, string>>();
/** The sequence entry of each structural node, by node ID. */
function structuralEntries(native: DocumentView): Map<string, string> {
	const tokens = ensureTokens(native);
	let entries = structures.get(native);
	if (!entries) {
		entries = new Map();
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!;
			if (token.entry && token.attributes[RT_NODE])
				entries.set(String(token.attributes[RT_NODE]), token.entry.id);
		}
		structures.set(native, entries);
	}
	return entries;
}
const isText = (tree: Tree | undefined): tree is Tree & { key: string } =>
	!!tree && tree.id === undefined && tree.key !== undefined;
const isElement = (tree: Tree): boolean =>
	tree.tokens[0]?.attributes[elementKey] === true;

/** Last token entry inside a subtree, walking backwards in O(depth). */
function lastEntryInSubtree(tree: Tree): string | undefined {
	for (let i = tree.children.length - 1; i >= 0; i--) {
		const found = lastEntryInSubtree(tree.children[i]!);
		if (found) return found;
	}
	for (let i = tree.tokens.length - 1; i >= 0; i--) {
		const id = tree.tokens[i]!.entry?.id;
		if (id) return id;
	}
	return undefined;
}

/**
 * The anchor of a point of the rendered view: the ID of the sequence entry
 * just before it, character or structural, as `field.anchorAt` gives for a
 * text index. `undefined` for a point that is not in the view.
 */
export function anchorOfPoint(
	context: RichTextContext,
	native: DocumentView,
	view: DocumentView,
	point: { key: string; offset: number; type?: "text" | "element" },
): string | undefined {
	if (view.byKey && view.parentOf) {
		const tree = view.byKey.get(point.key);
		if (!tree || point.offset < 0) return undefined;
		const asText = point.type ? point.type === "text" : tree.id === undefined;
		if (asText) {
			if (tree.id !== undefined) return undefined;
			let length = 0;
			let beforeCount = 0;
			for (let i = 0; i < tree.tokens.length; i++) {
				length += tree.tokens[i]!.value.length;
				if (length <= point.offset) beforeCount++;
			}
			if (point.offset > length) return undefined;
			for (let i = beforeCount - 1; i >= 0; i--) {
				const id = tree.tokens[i]!.entry?.id;
				if (id) return id;
			}
		} else {
			if (tree.id === undefined || point.offset > tree.children.length)
				return undefined;
			for (let i = point.offset - 1; i >= 0; i--) {
				const id = lastEntryInSubtree(tree.children[i]!);
				if (id) return id;
			}
			for (let i = tree.tokens.length - 1; i >= 0; i--) {
				const id = tree.tokens[i]!.entry?.id;
				if (id) return id;
			}
		}
		// Walk backward through previous siblings and ancestors in O(depth).
		let current: Tree = tree;
		while (true) {
			const link = view.parentOf.get(current);
			if (!link) break;
			const { parent, index } = link;
			for (let i = index - 1; i >= 0; i--) {
				const id = lastEntryInSubtree(parent.children[i]!);
				if (id) return id;
			}
			for (let i = parent.tokens.length - 1; i >= 0; i--) {
				const id = parent.tokens[i]!.entry?.id;
				if (id) return id;
			}
			current = parent;
		}
		return context.node.id;
	}
	const index = indexView(view),
		place = index.keys.get(point.key);
	if (!place || point.offset < 0) return undefined;
	const { tree } = place;
	let before = place.start;
	if (point.type ? point.type === "text" : tree.id === undefined) {
		if (tree.id !== undefined) return undefined;
		let length = 0;
		// A point inside a surrogate pair counts as before the pair.
		for (const token of tree.tokens) {
			length += token.value.length;
			if (length <= point.offset) before++;
		}
		if (point.offset > length) return undefined;
	} else {
		if (tree.id === undefined || point.offset > tree.children.length)
			return undefined;
		before = point.offset
			? index.places.get(tree.children[point.offset - 1]!)!.end
			: place.start + tree.tokens.length;
	}
	const entries = structuralEntries(native);
	const tokens = ensureTokens(view);
	for (let position = before - 1; position >= 0; position--) {
		const token = tokens[position]!,
			node = token.attributes[RT_NODE];
		const id = node ? entries.get(String(node)) : token.entry?.id;
		if (id) return id;
	}
	return context.node.id;
}

/**
 * Where an anchor is in the rendered view: just after the entry it names, or
 * after the nearest rendered entry before it once that one is gone.
 * `undefined` for an anchor of another field or of an entry not received yet.
 */
export function pointOfAnchor(
	context: RichTextContext,
	view: DocumentView,
	anchor: string,
): Point | undefined {
	const { node } = context;
	const resolved = resolveRichTextAnchor(node, anchor);
	if (resolved === undefined) return undefined;
	const text = (tree: Tree & { key: string }): Point => ({
		key: tree.key,
		offset: 0,
		type: "text",
	});
	// Fast O(block) lookup via `byId` when `resolved` is a character inside a known block.
	if (resolved && !isRichTextNode(resolved) && view.byId) {
		const parentId = resolved.marks.get(RT_PARENT)?.value;
		const block =
			typeof parentId === "string" ? view.byId.get(parentId) : undefined;
		if (block) {
			for (let c = 0; c < block.children.length; c++) {
				const child = block.children[c]!;
				if (child.id !== undefined) continue;
				for (let t = 0; t < child.tokens.length; t++) {
					const token = child.tokens[t]!;
					if (token.entry === resolved && token.key !== undefined) {
						return {
							key: token.key,
							offset: token.offset! + token.value.length,
							type: "text",
						};
					}
				}
			}
		}
	}
	const index = indexView(view);
	const after = (entry: CoreEntry): Point | undefined => {
		if (!isRichTextNode(entry)) {
			const token = index.characters.get(entry.id);
			return token?.key === undefined
				? undefined
				: {
						key: token.key,
						offset: token.offset! + token.value.length,
						type: "text",
					};
		}
		const place = index.nodes.get(String(entry.marks.get(RT_NODE)!.value));
		if (place?.tree.key === undefined) return undefined;
		// Inside an element, before its first child; after any other node.
		const inside = isElement(place.tree),
			parent = inside ? place.tree : place.parent,
			offset = inside ? 0 : place.index + 1,
			next = parent?.children[offset];
		if (isText(next)) return text(next);
		return parent?.key === undefined
			? undefined
			: { key: parent.key, offset, type: "element" };
	};
	if (resolved) {
		const point = after(resolved);
		if (point) return point;
		// The entry is not rendered (a removed block): the one before it.
		for (let at = node.order.indexOf(resolved) - 1; at >= 0; at--) {
			const entry = node.order[at]!,
				found = entry.deleted ? undefined : after(entry);
			if (found) return found;
		}
	}
	// The start of the field: the first place a caret can be.
	let tree = view.tree;
	while (true) {
		const first = tree.children[0];
		if (isText(first)) return text(first);
		if (!first || !isElement(first)) break;
		tree = first;
	}
	return tree.key === undefined
		? undefined
		: { key: tree.key, offset: 0, type: "element" };
}

export function redirectOperations(
	context: RichTextContext,
	before: DocumentView,
	after: DocumentView,
): CoreOperation[] {
	const beforeTokens = ensureTokens(before);
	const afterTokens = ensureTokens(after);
	const present = new Set(
		afterTokens.map((token) => token.attributes[RT_NODE]).filter(Boolean),
	);
	const moved = new Map<string, Set<string>>();
	const previous = new Map(
		beforeTokens
			.filter((token) => token.entry)
			.map((token) => [token.entry!.id, token]),
	);
	for (const token of afterTokens) {
		if (!token.entry || token.attributes[RT_NODE]) continue;
		const old = previous.get(token.entry.id),
			oldParent = old?.attributes[RT_PARENT],
			parent = token.attributes[RT_PARENT];
		if (
			typeof oldParent !== "string" ||
			typeof parent !== "string" ||
			present.has(oldParent) ||
			oldParent === parent
		)
			continue;
		let targets = moved.get(oldParent);
		if (!targets) moved.set(oldParent, (targets = new Set()));
		targets.add(parent);
	}
	const operations: CoreOperation[] = [];
	for (const [id, targets] of moved) {
		if (targets.size !== 1) continue;
		const entries = context.node.visible
			.filter((entry) => entry.marks.get(RT_NODE)?.value === id)
			.map((entry) => entry.id);
		if (entries.length)
			operations.push({
				kind: 5,
				target: context.node.id,
				entries,
				attributes: { [RT_REDIRECT]: [...targets][0] },
			});
	}
	return operations;
}

/** Compare two node JSON objects ignoring `children`. */
export function ownJSONEqual(a: JSONNode, b: JSONNode): boolean {
	if (a === b) return true;
	let countA = 0;
	for (const key in a) {
		if (key === "children" || a[key] === undefined) continue;
		countA++;
		if (!sameJSON(a[key], b[key])) return false;
	}
	let countB = 0;
	for (const key in b) {
		if (key === "children" || b[key] === undefined) continue;
		countB++;
	}
	return countA === countB;
}

export function sameJSON(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (
		!a ||
		!b ||
		typeof a !== "object" ||
		typeof b !== "object" ||
		Array.isArray(a) !== Array.isArray(b)
	)
		return false;
	const left = a as Record<string, unknown>,
		right = b as Record<string, unknown>;
	const keys = Object.keys(left).filter((key) => left[key] !== undefined);
	return (
		keys.length ===
			Object.keys(right).filter((key) => right[key] !== undefined).length &&
		keys.every((key) => sameJSON(left[key], right[key]))
	);
}
