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
	editorAttributes,
	isRichTextNode,
	newerTextStamp,
	richTextRedirects,
	richTextRemovedNodes,
	type EditorToken,
	type CoreEntry,
	type Stamp,
	type RichTextContext,
	type CoreOperation,
} from "@pulsify/core/bindings";

export type JSONNode = SerializedLexicalNode & {
	[key: string]: unknown;
	children?: JSONNode[];
	text?: string;
};
export type Tree = {
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
};
const schemaKey = RT_PREFIX + "schema";
const elementKey = RT_PREFIX + "element";
type Attributes = Record<string, unknown>;

function unpack(attributes: Attributes, prefix: string): Attributes {
	return Object.fromEntries(
		Object.entries(attributes)
			.filter(([key, value]) => key.startsWith(prefix) && Array.isArray(value))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [
				key.slice(prefix.length),
				(value as unknown[])[0],
			]),
	);
}
function textAttributes(json: JSONNode, parent: string): Attributes {
	const attributes: Attributes = { [RT_PARENT]: parent };
	for (const [key, value] of Object.entries(json)) {
		if (key === "text") continue;
		if (key === "format") {
			for (let bit = 0; bit < 32; bit++)
				if ((Number(value) >>> bit) & 1)
					attributes[RT_MARK + "f" + bit] = [true];
		} else attributes[RT_MARK + key] = [value];
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

/** Must run in a Lexical read/update context. Runtime keys never go on the wire. */
export function captureDocument(
	context: RichTextContext,
	known: Map<string, string>,
	schemaId: string,
): DocumentView {
	const ids = new Map<string, string>(),
		tokens: Token[] = [];
	let serial = 0;
	const visit = (node: LexicalNode, parent: string): Tree => {
		const key = node.getKey(),
			json = { ...node.exportJSON() } as JSONNode;
		if ("$slots" in json)
			throw new TypeError(
				"Lexical slot nodes require a dedicated Pulsify adapter mapping",
			);
		if ($isTextNode(node)) {
			const attributes = textAttributes(json, parent),
				own: Token[] = [];
			let offset = 0;
			for (const value of node.getTextContent()) {
				const token = { value, attributes, key, offset };
				tokens.push(token);
				own.push(token);
				offset += value.length;
			}
			return { json, children: [], tokens: own };
		}
		const id =
			node.getType() === "root"
				? `${context.node.id}/root`
				: (known.get(key) ??
					`${context.model.sid}:${context.model.nextClock}/node/${serial++}`);
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
				...nodeAttributes(json, id, parent, textblock, schemaId),
				[elementKey]: $isElementNode(node),
			},
			key,
		};
		tokens.push(token);
		const children = $isElementNode(node)
			? node.getChildren().map((child) => visit(child, id))
			: [];
		if ($isElementNode(node))
			json.children = children.map((child) => child.json);
		return { id, json, children, tokens: [token] };
	};
	const tree = visit($getRoot(), "");
	const selected = $getSelection();
	const point = (value: PointType): Point => ({
		key: value.key,
		offset: value.offset,
		type: value.type,
	});
	const selection: Selection = $isRangeSelection(selected)
		? {
				anchor: point(selected.anchor),
				focus: point(selected.focus),
				format: selected.format,
				style: selected.style,
			}
		: $isNodeSelection(selected)
			? { nodes: selected.getNodes().map((node) => node.getKey()) }
			: null;
	return { tree, tokens, ids, selection };
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
	for (let index = 0; index < node.visible.length; index++) {
		const entry = node.visible[index]!;
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
		const text = node.visible.map((entry) => entry.value as string).join("");
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
		for (const entry of node.visible)
			textNode.tokens.push({
				value: entry.value as string,
				attributes: textAttributes(textNode.json, paragraph.id!),
				entry,
			});
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
	for (const { entry, index } of characters)
		add(
			resolve(String(entry.marks.get(RT_PARENT)?.value ?? `${node.id}/plain`)),
			{ index, entry },
		);
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
		let run: Tree | undefined,
			properties = "";
		for (const child of (children.get(id) ?? []).sort(
			(a, b) => a.index - b.index,
		)) {
			if (child.id) {
				tree.children.push(build(child.id));
				run = undefined;
				continue;
			}
			const entry = child.entry!,
				attributes = editorAttributes(entry),
				serialized = textJSON(attributes),
				signature = JSON.stringify(serialized);
			if (!run || signature !== properties) {
				run = { json: { ...serialized, text: "" }, children: [], tokens: [] };
				tree.children.push(run);
				properties = signature;
			}
			run.json.text = (run.json.text ?? "") + (entry.value as string);
			const textToken: Token = {
				value: entry.value as string,
				attributes,
				entry,
			};
			run.tokens.push(textToken);
			tokens.push(textToken);
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

/** Character identities survive formatting, splits/joins and repeated typing. */
export function matchDocument(
	before: DocumentView,
	after: DocumentView,
): string[] {
	const occupied = new Set(
		[...before.tokens, ...after.tokens]
			.filter((token) => !token.attributes[RT_NODE])
			.map((token) => token.value),
	);
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
	const encode = (view: DocumentView) =>
		view.tokens
			.map((token) =>
				token.attributes[RT_NODE]
					? symbol(String(token.attributes[RT_NODE]))
					: token.value,
			)
			.join("");
	const oldText = encode(before),
		newText = encode(after);
	const range = (
		view: DocumentView,
	): { index: number; length: number } | undefined => {
		if (!view.selection || !("anchor" in view.selection)) return undefined;
		const position = (point: Point) => {
			let index = 0;
			for (const token of view.tokens) {
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
		const anchor = position(view.selection.anchor),
			focus = position(view.selection.focus);
		return { index: Math.min(anchor, focus), length: Math.abs(anchor - focus) };
	};
	const oldRange = range(before),
		newRange = range(after);
	const changes = diff(
		oldText,
		newText,
		oldRange && newRange ? { oldRange, newRange } : undefined,
	);
	const oldAt = new Map<number, Token>(),
		newAt = new Map<number, number>();
	let pos = 0;
	for (const token of before.tokens) {
		oldAt.set(pos, token);
		pos += token.attributes[RT_NODE] ? 1 : token.value.length;
	}
	pos = 0;
	const keys = after.tokens.map((token, index) => {
		newAt.set(pos, index);
		pos += token.attributes[RT_NODE] ? 1 : token.value.length;
		return token.attributes[RT_NODE]
			? `node:${token.attributes[RT_NODE]}`
			: `new:${index}`;
	});
	let oldPos = 0,
		newPos = 0;
	for (const [kind, value] of changes) {
		if (kind === 0)
			for (const char of value) {
				const old = oldAt.get(oldPos),
					index = newAt.get(newPos);
				if (
					old?.entry &&
					index !== undefined &&
					!after.tokens[index]!.attributes[RT_NODE]
				) {
					keys[index] = `char:${old.entry.id}`;
					after.tokens[index]!.entry = old.entry;
				}
				oldPos += char.length;
				newPos += char.length;
			}
		else if (kind < 0) oldPos += value.length;
		else newPos += value.length;
	}
	return keys;
}

export function redirectOperations(
	context: RichTextContext,
	before: DocumentView,
	after: DocumentView,
): CoreOperation[] {
	const present = new Set(
		after.tokens.map((token) => token.attributes[RT_NODE]).filter(Boolean),
	);
	const moved = new Map<string, Set<string>>();
	const previous = new Map(
		before.tokens
			.filter((token) => token.entry)
			.map((token) => [token.entry!.id, token]),
	);
	for (const token of after.tokens) {
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
