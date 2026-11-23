import {
	Fragment,
	Mark,
	type Node as ProseMirrorNode,
	type Schema,
} from "prosemirror-model";
import { Mapping, StepMap } from "prosemirror-transform";
import {
	RT_ATTR,
	RT_MARK,
	RT_NODE,
	RT_PARENT,
	RT_PREFIX,
	RT_REDIRECT,
	RT_TEXTBLOCK,
	RT_TYPE,
	commitEditorOperations,
	isRichTextNode,
	newerTextStamp,
	pushAttributeOps,
	pushDeleteOps,
	richTextRedirects,
	richTextRemovedNodes,
	type RichTextContext,
	RT_FORMAT,
	reconcileEditorTokens,
	matchTokens,
	resolveRichTextAnchor,
	type CoreEntry,
	type Stamp,
	type CoreOperation,
	type EditorChange,
} from "pulsify-core/bindings";
import { fingerprintBytes } from "pulsify-core/bindings";
import { prepareValue } from "pulsify-core/bindings";

type Attributes = Record<string, unknown>;
export type Token = {
	value: string;
	attributes: Attributes;
	entry?: CoreEntry;
	pos: number;
	size: number;
};
export type NodeSpan = { id: string; node: ProseMirrorNode; pos: number };
export type BlockInfo = {
	id: string;
	node: ProseMirrorNode;
	pos: number;
	anchor: CoreEntry | undefined;
	/** True when this top-level child is a textblock with only text children. */
	simple: boolean;
	/** Ordered character entries when `simple === true`. */
	chars: CoreEntry[];
	/** Relative-position tokens/nodes retained for non-simple blocks when rebuilding full view. */
	subTokens?: Token[];
	subNodes?: NodeSpan[];
};
export type DocumentView = {
	doc: ProseMirrorNode;
	tokens: Token[];
	nodes: NodeSpan[];
	blocks: BlockInfo[];
	byId: Map<string, number>;
	rootId: string;
	rootAnchor: CoreEntry | undefined;
	tokensDirty?: boolean;
};
const schemaKey = `${RT_PREFIX}schema`;
const fingerprints = new WeakMap<Schema, string>();
function schemaFingerprint(schema: Schema): string {
	let result = fingerprints.get(schema);
	if (!result) {
		// Runtime functions (DOM rendering, parsing) do not affect document data.
		const specs = (types: Schema["nodes"] | Schema["marks"]) =>
			Object.values(types).map(({ name, spec }) => {
				const data: Attributes = { name };
				for (const key of [
					"content",
					"marks",
					"group",
					"inline",
					"atom",
					"attrs",
					"inclusive",
					"excludes",
					"code",
					"isolating",
					"defining",
				])
					if (spec[key] !== undefined) data[key] = spec[key];
				return data;
			});
		result = fingerprintBytes(
			new TextEncoder().encode(
				JSON.stringify([
					schema.topNodeType.name,
					specs(schema.nodes),
					specs(schema.marks),
				]),
			),
		);
		fingerprints.set(schema, result);
	}
	return result;
}
function attrs(entry: CoreEntry): Attributes {
	const result: Attributes = {};
	for (const [key, mark] of entry.marks)
		if (mark.value != null) result[key] = mark.value;
	return result;
}
function unpack(input: Attributes, prefix: string): Attributes {
	const result: Attributes = {};
	for (const [key, value] of Object.entries(input)) {
		if (key.startsWith(prefix) && Array.isArray(value))
			result[key.slice(prefix.length)] = value[0];
	}
	return result;
}
function nodeAttrs(
	node: ProseMirrorNode,
	id: string,
	parent: string,
	schema: Schema,
): Attributes {
	const result: Attributes = {
		[RT_NODE]: id,
		[RT_PARENT]: parent,
		[RT_TYPE]: node.type.name,
		[RT_TEXTBLOCK]: node.isTextblock,
	};
	for (const [key, value] of Object.entries(node.attrs))
		result[RT_ATTR + key] = [value];
	for (const mark of node.marks)
		result[RT_MARK + mark.type.name] = [mark.attrs];
	if (node.type === schema.topNodeType) {
		result[schemaKey] = schemaFingerprint(schema);
		result[RT_FORMAT] = "prosemirror";
	}
	return result;
}
function readMarks(schema: Schema, attributes: Attributes): readonly Mark[] {
	const entries = Object.entries(unpack(attributes, RT_MARK));
	if (!entries.length) return Mark.none;
	return Mark.setFrom(
		entries.map(([name, value]) => {
			const type = schema.marks[name];
			if (!type)
				throw new RangeError(
					`ProseMirror schema does not declare mark ${name}`,
				);
			return type.create(value as Attributes);
		}),
	);
}
function entryMarksFast(
	schema: Schema,
	entry: CoreEntry,
): { marks: readonly Mark[]; key: string } {
	let hasMark = false;
	for (const [k, m] of entry.marks) {
		if (m.value != null && k.startsWith(RT_MARK)) {
			hasMark = true;
			break;
		}
	}
	if (!hasMark) return { marks: Mark.none, key: "" };
	const unpacked: Attributes = {};
	for (const [k, m] of entry.marks) {
		if (m.value != null && k.startsWith(RT_MARK) && Array.isArray(m.value))
			unpacked[k.slice(RT_MARK.length)] = m.value[0];
	}
	const key = JSON.stringify(unpacked);
	const marks = Mark.setFrom(
		Object.entries(unpacked).map(([name, value]) => {
			const type = schema.marks[name];
			if (!type)
				throw new RangeError(
					`ProseMirror schema does not declare mark ${name}`,
				);
			return type.create(value as Attributes);
		}),
	);
	return { marks, key };
}

export function isSimpleTextblock(node: ProseMirrorNode): boolean {
	if (!node.isTextblock) return false;
	for (let i = 0; i < node.childCount; i++) {
		if (!node.child(i).isText) return false;
	}
	return true;
}

/** Build a simple textblock's ProseMirror node from its ordered character entries. */
export function buildSimpleBlockNode(
	schema: Schema,
	template: ProseMirrorNode,
	entries: readonly CoreEntry[],
): ProseMirrorNode {
	const content: ProseMirrorNode[] = [];
	let chunks: string[] = [],
		marks: readonly Mark[] = Mark.none,
		markKey = "";
	const flush = () => {
		if (chunks.length) {
			content.push(schema.text(chunks.join(""), marks));
			chunks = [];
		}
	};
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const desc = entryMarksFast(schema, entry);
		if (!chunks.length || desc.key !== markKey) {
			flush();
			marks = desc.marks;
			markKey = desc.key;
		}
		chunks.push(entry.value as string);
	}
	flush();
	return template.type.createChecked(
		template.attrs,
		Fragment.fromArray(content),
		template.marks,
	);
}

/** Rebuild `view.tokens` and `view.nodes` from `view.blocks` after incremental edits. */
export function ensureFullView(view: DocumentView, schema: Schema): void {
	if (!view.tokensDirty) return;
	const tokens: Token[] = [];
	const nodes: NodeSpan[] = [];
	nodes.push({ id: view.rootId, node: view.doc, pos: -1 });
	tokens.push({
		value: "\uFFFC",
		attributes: nodeAttrs(view.doc, view.rootId, "", schema),
		...(view.rootAnchor ? { entry: view.rootAnchor } : {}),
		pos: -1,
		size: view.doc.isLeaf ? view.doc.nodeSize : 0,
	});
	for (let b = 0; b < view.blocks.length; b++) {
		const block = view.blocks[b]!;
		if (block.simple) {
			nodes.push({ id: block.id, node: block.node, pos: block.pos });
			tokens.push({
				value: "\uFFFC",
				attributes: nodeAttrs(block.node, block.id, view.rootId, schema),
				...(block.anchor ? { entry: block.anchor } : {}),
				pos: block.pos,
				size: 0,
			});
			let charPos = block.pos + 1;
			for (let i = 0; i < block.chars.length; i++) {
				const entry = block.chars[i]!;
				const ch = entry.value as string;
				tokens.push({
					value: ch,
					attributes: attrs(entry),
					entry,
					pos: charPos,
					size: ch.length,
				});
				charPos += ch.length;
			}
		} else {
			const basePos = block.pos;
			if (block.subNodes) {
				for (let i = 0; i < block.subNodes.length; i++) {
					const s = block.subNodes[i]!;
					nodes.push({ id: s.id, node: s.node, pos: basePos + s.pos });
				}
			}
			if (block.subTokens) {
				for (let i = 0; i < block.subTokens.length; i++) {
					const t = block.subTokens[i]!;
					tokens.push({ ...t, pos: basePos + t.pos });
				}
			}
		}
	}
	view.tokens = tokens;
	view.nodes = nodes;
	view.tokensDirty = false;
	tokenIndexes.delete(view);
}

/** Reconstruct the editor tree without changing the collaborative document. */
export function readDocument(
	context: RichTextContext,
	schema: Schema,
): DocumentView {
	const { node } = context;
	const rootId = `${node.id}/root`;
	const records = new Map<
		string,
		{
			attributes: Attributes;
			stamps: Map<string, Stamp>;
			index: number;
			entries: CoreEntry[];
		}
	>();
	const redirects = richTextRedirects(node);
	const removed = richTextRemovedNodes(node);
	let hasAnchors = false;
	const characters: { entry: CoreEntry; index: number }[] = [];
	const visible = node.visible;
	for (let index = 0; index < visible.length; index++) {
		const entry = visible[index]!;
		if (!isRichTextNode(entry)) {
			characters.push({ entry, index });
			continue;
		}
		hasAnchors = true;
		const id = entry.marks.get(RT_NODE)!.value as string;
		if (removed.has(id)) continue;
		let record = records.get(id);
		if (!record)
			records.set(
				id,
				(record = { attributes: {}, stamps: new Map(), index, entries: [] }),
			);
		record.entries.push(entry);
		for (const [key, mark] of entry.marks) {
			const stamp = record.stamps.get(key);
			if (!stamp || newerTextStamp(mark.stamp, stamp)) {
				record.stamps.set(key, mark.stamp);
				record.attributes[key] = mark.value;
			}
		}
	}
	if (!hasAnchors) return readPlain(context, schema);
	const root = records.get(rootId);
	if (!root) throw new RangeError("ProseMirror document root is missing");
	if (
		root.attributes[RT_FORMAT] !== undefined &&
		root.attributes[RT_FORMAT] !== "prosemirror"
	)
		throw new TypeError("This richText field uses a different editor format");
	if (root.attributes[schemaKey] !== schemaFingerprint(schema))
		throw new RangeError(
			"Incompatible ProseMirror schema for this richText field",
		);
	const resolve = (id: string): string => {
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
	for (const [id, record] of records) {
		if (id === rootId) continue;
		const parent = resolve(String(record.attributes[RT_PARENT]));
		if (records.has(parent)) add(parent, { index: record.index, id });
	}
	const plainParent = `${node.id}/plain`;
	for (let i = 0; i < characters.length; i++) {
		const { entry, index } = characters[i]!;
		const parent = resolve(
			String(entry.marks.get(RT_PARENT)?.value ?? plainParent),
		);
		if (records.has(parent)) add(parent, { index, entry });
	}
	const ids = new WeakMap<ProseMirrorNode, string>();
	const stack = new Set<string>();
	const build = (id: string): ProseMirrorNode => {
		if (stack.has(id))
			throw new RangeError("Cyclic ProseMirror document structure");
		stack.add(id);
		const record = records.get(id)!;
		const type = schema.nodes[String(record.attributes[RT_TYPE])];
		if (!type || type.isText)
			throw new RangeError(
				`Unknown ProseMirror node ${String(record.attributes[RT_TYPE])}`,
			);
		const content: ProseMirrorNode[] = [];
		let chunks: string[] = [],
			marks: readonly Mark[] = Mark.none,
			markKey = "";
		const flush = () => {
			if (chunks.length) {
				content.push(schema.text(chunks.join(""), marks));
				chunks = [];
			}
		};
		const list = children.get(id);
		if (list) {
			let sorted = true;
			for (let i = 1; i < list.length; i++) {
				if (list[i]!.index < list[i - 1]!.index) {
					sorted = false;
					break;
				}
			}
			if (!sorted) list.sort((a, b) => a.index - b.index);
			for (let i = 0; i < list.length; i++) {
				const child = list[i]!;
				if (child.id) {
					flush();
					content.push(build(child.id));
				} else {
					const entry = child.entry!;
					const desc = entryMarksFast(schema, entry);
					if (!chunks.length || desc.key !== markKey) {
						flush();
						marks = desc.marks;
						markKey = desc.key;
					}
					chunks.push(entry.value as string);
				}
			}
		}
		flush();
		// Concurrent structural edits can leave a required child absent. Fill
		// required wrappers/default blocks with the schema's own content rules.
		let fragment = Fragment.fromArray(content);
		if (!type.validContent(fragment)) {
			let match = type.contentMatch;
			const repaired: ProseMirrorNode[] = [];
			for (const child of content) {
				let next = match.matchType(child.type);
				if (next) {
					repaired.push(child);
					match = next;
					continue;
				}
				const wrapping = match.findWrapping(child.type);
				if (wrapping) {
					let wrapped = child;
					for (const wrapper of [...wrapping].reverse())
						wrapped = wrapper.createAndFill(null, wrapped)!;
					next = match.matchType(wrapped.type);
					if (next) {
						repaired.push(wrapped);
						match = next;
						continue;
					}
				}
				throw new RangeError(
					`Cannot fit concurrent ${child.type.name} into ${type.name}`,
				);
			}
			const tail = match.fillBefore(Fragment.empty, true);
			if (!tail)
				throw new RangeError(`Cannot complete ProseMirror node ${type.name}`);
			fragment = Fragment.fromArray(repaired).append(tail);
		}
		const result = type.createChecked(
			unpack(record.attributes, RT_ATTR),
			fragment,
			readMarks(schema, record.attributes),
		);
		ids.set(result, id);
		stack.delete(id);
		return result;
	};
	const doc = build(rootId);
	// Fragment joins adjacent text nodes, so assign character IDs by each
	// parent's ordered entries rather than by the final text node identity.
	const tokens: Token[] = [],
		nodes: NodeSpan[] = [],
		blocks: BlockInfo[] = [],
		byId = new Map<string, number>();
	const visit = (
		current: ProseMirrorNode,
		pos: number,
		parent: string,
		ordinal: string,
		depth: number,
	) => {
		let id = ids.get(current);
		if (!id) {
			const base = `${node.id}/repair/${ordinal}`;
			id = base;
			for (let suffix = 1; removed.has(id); suffix++) id = `${base}/${suffix}`;
		}
		const tokenStart = tokens.length;
		const nodeStart = nodes.length;
		nodes.push({ id, node: current, pos });
		const anchor = records.get(id)?.entries[0];
		tokens.push({
			value: "\uFFFC",
			attributes: nodeAttrs(current, id, parent, schema),
			...(anchor ? { entry: anchor } : {}),
			pos,
			size: current.isLeaf ? current.nodeSize : 0,
		});
		const rawChildren = children.get(id);
		const textEntries: CoreEntry[] = [];
		if (rawChildren) {
			for (let i = 0; i < rawChildren.length; i++) {
				if (rawChildren[i]!.entry) textEntries.push(rawChildren[i]!.entry!);
			}
		}
		let offset = 0;
		const simpleChars: CoreEntry[] = [];
		const trackSimple = depth === 1 && isSimpleTextblock(current);
		let allMatchedEntries = trackSimple;
		current.forEach((child, childOffset, index) => {
			const childPos = pos + 1 + childOffset;
			if (!child.isText) {
				visit(child, childPos, id, `${ordinal}/${index}`, depth + 1);
				return;
			}
			const fallbackAttrs = { [RT_PARENT]: id };
			let charPos = childPos;
			for (const char of child.text!) {
				const entry = textEntries[offset++];
				if (trackSimple) {
					if (entry) simpleChars.push(entry);
					else allMatchedEntries = false;
				}
				tokens.push({
					value: char,
					attributes: entry ? attrs(entry) : fallbackAttrs,
					...(entry ? { entry } : {}),
					pos: charPos,
					size: char.length,
				});
				charPos += char.length;
			}
		});
		if (depth === 1) {
			const blockIdx = blocks.length;
			const simple = allMatchedEntries && !!anchor;
			const info: BlockInfo = {
				id,
				node: current,
				pos,
				anchor,
				simple,
				chars: simple ? simpleChars : [],
			};
			if (!simple) {
				info.subNodes = nodes
					.slice(nodeStart)
					.map((s) => ({ id: s.id, node: s.node, pos: s.pos - pos }));
				info.subTokens = tokens
					.slice(tokenStart)
					.map((t) => ({ ...t, pos: t.pos - pos }));
			}
			blocks.push(info);
			byId.set(id, blockIdx);
		}
	};
	visit(doc, -1, "", "root", 0);
	return {
		doc,
		tokens,
		nodes,
		blocks,
		byId,
		rootId,
		rootAnchor: records.get(rootId)?.entries[0],
	};
}

function readPlain(context: RichTextContext, schema: Schema): DocumentView {
	let doc = schema.topNodeType.createAndFill();
	if (!doc)
		throw new RangeError("ProseMirror schema must provide a default document");
	const text = context.node.visible
		.map((entry) => entry.value as string)
		.join("");
	if (text && doc.isTextblock)
		doc = doc.type.createChecked(doc.attrs, schema.text(text));
	else if (text) {
		let textblock: { node: ProseMirrorNode; pos: number } | undefined;
		doc.descendants((node, pos) => {
			if (!textblock && node.isTextblock) textblock = { node, pos };
		});
		if (!textblock)
			throw new RangeError(
				"ProseMirror schema needs a text block to import plain text",
			);
		// A Transform supplies the schema-aware replacement fitting rules.
		const { node, pos } = textblock;
		const replacement = node.type.createChecked(node.attrs, schema.text(text));
		const replace = (
			current: ProseMirrorNode,
			start: number,
		): ProseMirrorNode => {
			const content: ProseMirrorNode[] = [];
			current.forEach((child, offset) =>
				content.push(
					start + offset === pos
						? replacement
						: child.isLeaf
							? child
							: replace(child, start + offset + 1),
				),
			);
			return current.copy(Fragment.fromArray(content));
		};
		doc = replace(doc, 0);
	}
	const tokens: Token[] = [],
		nodes: NodeSpan[] = [],
		blocks: BlockInfo[] = [],
		byId = new Map<string, number>();
	let charIndex = 0,
		nodeIndex = 0;
	const rootId = `${context.node.id}/root`;
	const visit = (
		current: ProseMirrorNode,
		pos: number,
		parent: string,
		depth: number,
	) => {
		const id =
			nodeIndex++ === 0
				? rootId
				: `${context.node.id}/plain${nodeIndex === 2 ? "" : `/${nodeIndex}`}`;
		const tokenStart = tokens.length;
		const nodeStart = nodes.length;
		nodes.push({ id, node: current, pos });
		tokens.push({
			value: "\uFFFC",
			attributes: nodeAttrs(current, id, parent, schema),
			pos,
			size: current.isLeaf ? current.nodeSize : 0,
		});
		current.forEach((child, offset) => {
			if (!child.isText) {
				visit(child, pos + 1 + offset, id, depth + 1);
				return;
			}
			const fallbackAttrs = { [RT_PARENT]: id };
			let charPos = pos + 1 + offset;
			for (const char of child.text!) {
				const entry = context.node.visible[charIndex++];
				tokens.push({
					value: char,
					attributes: fallbackAttrs,
					...(entry ? { entry } : {}),
					pos: charPos,
					size: char.length,
				});
				charPos += char.length;
			}
		});
		if (depth === 1) {
			const blockIdx = blocks.length;
			blocks.push({
				id,
				node: current,
				pos,
				anchor: undefined,
				simple: false,
				chars: [],
				subNodes: nodes
					.slice(nodeStart)
					.map((s) => ({ id: s.id, node: s.node, pos: s.pos - pos })),
				subTokens: tokens
					.slice(tokenStart)
					.map((t) => ({ ...t, pos: t.pos - pos })),
			});
			byId.set(id, blockIdx);
		}
	};
	visit(doc, -1, "", 0);
	return {
		doc,
		tokens,
		nodes,
		blocks,
		byId,
		rootId,
		rootAnchor: undefined,
	};
}

function sameAttrs(a: Attributes, b: Attributes): boolean {
	if (a === b) return true;
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	for (let i = 0; i < keysA.length; i++) {
		const k = keysA[i]!;
		if (!Object.hasOwn(b, k) || JSON.stringify(a[k]) !== JSON.stringify(b[k]))
			return false;
	}
	return true;
}

/**
 * Fast O(changed blocks) local edit path for edits that keep top-level block
 * count and only touch simple textblocks. Returns `undefined` to fall back.
 */
export function writeIncrementalLocal(
	context: RichTextContext,
	doc: ProseMirrorNode,
	previous: DocumentView,
	mapping: Mapping,
	trackHistory: boolean,
): EditorChange | undefined {
	const oldDoc = previous.doc;
	if (oldDoc.childCount !== doc.childCount || !previous.blocks.length)
		return undefined;
	if (!sameAttrs(oldDoc.attrs, doc.attrs)) return undefined;
	const count = doc.childCount;
	let firstIdx = 0;
	while (firstIdx < count && oldDoc.child(firstIdx) === doc.child(firstIdx))
		firstIdx++;
	if (firstIdx === count) return undefined;
	let lastIdx = count - 1;
	while (lastIdx > firstIdx && oldDoc.child(lastIdx) === doc.child(lastIdx))
		lastIdx--;
	// Collect only changed blocks inside [firstIdx, lastIdx].
	const changedIndices: number[] = [];
	for (let i = firstIdx; i <= lastIdx; i++) {
		if (oldDoc.child(i) === doc.child(i)) continue;
		const oldBlock = previous.blocks[i]!;
		const newNode = doc.child(i);
		if (
			!oldBlock.simple ||
			!oldBlock.anchor ||
			oldBlock.anchor.deleted ||
			!isSimpleTextblock(newNode)
		)
			return undefined;
		changedIndices.push(i);
	}
	if (!changedIndices.length) return undefined;
	// Validate only the changed blocks.
	for (let i = 0; i < changedIndices.length; i++)
		doc.child(changedIndices[i]!).check();

	const { node, model } = context;
	const schema = doc.type.schema;
	const operations: CoreOperation[] = [];
	const deletes: string[] = [];
	const formatting = new Map<
		string,
		{ entries: string[]; attributes: Attributes }
	>();
	const sid = model.sid;
	const clock = model.nextClock;
	const idPrefix = `${sid}:${clock}:`;
	let entrySerial = 0;

	// Compute new absolute positions for changed blocks.
	let posOffset = 0;
	const blockResults: {
		idx: number;
		newNode: ProseMirrorNode;
		newPos: number;
		nextChars: (CoreEntry | undefined)[];
		newSlots: { posInChars: number; serial: number }[];
	}[] = [];

	// Precompute cumulative size delta before firstIdx (0) through lastIdx.
	for (let idx = firstIdx; idx <= lastIdx; idx++) {
		const oldBlock = previous.blocks[idx]!;
		const newNode = doc.child(idx);
		const newPos = oldBlock.pos + posOffset;
		const sizeDelta = newNode.nodeSize - oldBlock.node.nodeSize;
		posOffset += sizeDelta;
		if (oldBlock.node === newNode) continue;

		// Check if the block node itself changed type, attrs, or marks.
		if (
			oldBlock.node.type !== newNode.type ||
			!sameAttrs(oldBlock.node.attrs, newNode.attrs) ||
			!Mark.sameSet(oldBlock.node.marks, newNode.marks)
		) {
			const before = attrs(oldBlock.anchor!);
			const desiredNodeAttrs = nodeAttrs(
				newNode,
				oldBlock.id,
				previous.rootId,
				schema,
			);
			const updates: Attributes = {};
			let hasUpdate = false;
			for (const attr of new Set([
				...Object.keys(before),
				...Object.keys(desiredNodeAttrs),
			])) {
				if (!attr.startsWith(RT_PREFIX)) continue;
				const value = desiredNodeAttrs[attr] ?? null;
				if (JSON.stringify(before[attr] ?? null) !== JSON.stringify(value)) {
					updates[attr] = value;
					hasUpdate = true;
				}
			}
			if (hasUpdate) {
				const prepared = prepareValue(updates).value as Attributes;
				const group = JSON.stringify(prepared);
				const existing = formatting.get(group);
				if (existing) existing.entries.push(oldBlock.anchor!.id);
				else
					formatting.set(group, {
						entries: [oldBlock.anchor!.id],
						attributes: prepared,
					});
			}
		}

		// Map only this block's old characters through `mapping`.
		const charsByPos = new Map<number, CoreEntry>();
		let oldCharPos = oldBlock.pos + 1;
		for (let i = 0; i < oldBlock.chars.length; i++) {
			const entry = oldBlock.chars[i]!;
			const len = (entry.value as string).length;
			const start = mapping.mapResult(oldCharPos, 1);
			const end = mapping.mapResult(oldCharPos + len, -1);
			if (!start.deleted && !end.deleted && end.pos - start.pos === len)
				charsByPos.set(start.pos, entry);
			oldCharPos += len;
		}
		// Build desired characters for `newNode`.
		const desired: {
			value: string;
			attributes: Attributes;
			pos: number;
			marks: readonly Mark[];
		}[] = [];
		const baseAttrs: Attributes = { [RT_PARENT]: oldBlock.id };
		newNode.forEach((child, offset) => {
			let attributes: Attributes = baseAttrs;
			if (child.marks.length) {
				attributes = { [RT_PARENT]: oldBlock.id };
				for (let m = 0; m < child.marks.length; m++) {
					const mark = child.marks[m]!;
					attributes[RT_MARK + mark.type.name] = [mark.attrs];
				}
			}
			let charPos = newPos + 1 + offset;
			for (const char of child.text!) {
				desired.push({
					value: char,
					attributes,
					pos: charPos,
					marks: child.marks,
				});
				charPos += char.length;
			}
		});
		const oldKeys = oldBlock.chars.map((e) => e.id);
		const newKeys = desired.map((tok, i) => {
			const prev = charsByPos.get(tok.pos);
			return prev && prev.value === tok.value ? prev.id : `new:${i}`;
		});
		const matches = matchTokens(oldKeys, newKeys);
		const retained = new Set(matches.values());
		for (let i = 0; i < oldBlock.chars.length; i++) {
			if (!retained.has(i)) deletes.push(oldBlock.chars[i]!.id);
		}

		const nextChars: (CoreEntry | undefined)[] = new Array(desired.length);
		const newSlots: { posInChars: number; serial: number }[] = [];
		let after = oldBlock.anchor!.id;
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
		for (let i = 0; i < desired.length; i++) {
			const tok = desired[i]!;
			const oldIndex = matches.get(i);
			const entry =
				oldIndex === undefined ? undefined : oldBlock.chars[oldIndex];
			if (!entry) {
				const serial = entrySerial++;
				const entryId = idPrefix + serial;
				newSlots.push({ posInChars: i, serial });
				if (insertion && insertion.raw === tok.attributes) {
					insertion.chunks.push(tok.value);
				} else {
					const prepared = prepareValue(tok.attributes).value as Attributes;
					const key = JSON.stringify(prepared);
					if (insertion && insertion.key === key) {
						insertion.chunks.push(tok.value);
						insertion.raw = tok.attributes;
					} else {
						flushInsertion();
						const op: Extract<CoreOperation, { kind: 12 }> = {
							kind: 12,
							target: node.id,
							after,
							text: tok.value,
							attributes: prepared,
						};
						operations.push(op);
						insertion = {
							op,
							key,
							raw: tok.attributes,
							chunks: [tok.value],
						};
					}
				}
				after = entryId;
				continue;
			}
			flushInsertion();
			nextChars[i] = entry;
			// Fast check: if entry has only RT_PARENT matching block.id and desired has no marks, skip!
			let needsAttrCheck = tok.marks.length > 0 || entry.marks.size > 1;
			if (!needsAttrCheck) {
				const parentVal = entry.marks.get(RT_PARENT)?.value;
				if (parentVal !== oldBlock.id) needsAttrCheck = true;
			}
			if (needsAttrCheck) {
				const before = attrs(entry);
				const updates: Attributes = {};
				let hasUpdate = false;
				for (const attr of new Set([
					...Object.keys(before),
					...Object.keys(tok.attributes),
				])) {
					if (!attr.startsWith(RT_PREFIX)) continue;
					const value = tok.attributes[attr] ?? null;
					if (JSON.stringify(before[attr] ?? null) !== JSON.stringify(value)) {
						updates[attr] = value;
						hasUpdate = true;
					}
				}
				if (hasUpdate) {
					const prepared = prepareValue(updates).value as Attributes;
					const group = JSON.stringify(prepared);
					const existing = formatting.get(group);
					if (existing) existing.entries.push(entry.id);
					else
						formatting.set(group, {
							entries: [entry.id],
							attributes: prepared,
						});
				}
			}
			after = entry.id;
		}
		flushInsertion();
		blockResults.push({ idx, newNode, newPos, nextChars, newSlots });
	}

	const finalOps: CoreOperation[] = [];
	pushDeleteOps(finalOps, node.id, deletes);
	for (let i = 0; i < operations.length; i++) finalOps.push(operations[i]!);
	for (const group of formatting.values())
		pushAttributeOps(finalOps, node.id, group.entries, group.attributes);

	const change = trackHistory
		? commitEditorOperations(context, finalOps)
		: (() => {
				if (finalOps.length) commitEditorOperations(context, finalOps);
				return { inserted: [], deleted: [], attributes: [] };
			})();

	// Commit succeeded atomically; now update `previous` in-place!
	let resultPtr = 0;
	let runningDelta = 0;
	for (let idx = firstIdx; idx < count; idx++) {
		const block = previous.blocks[idx]!;
		if (
			resultPtr < blockResults.length &&
			blockResults[resultPtr]!.idx === idx
		) {
			const res = blockResults[resultPtr++]!;
			for (let s = 0; s < res.newSlots.length; s++) {
				const slot = res.newSlots[s]!;
				res.nextChars[slot.posInChars] = node.entries.get(
					idPrefix + slot.serial,
				)!;
			}
			runningDelta += res.newNode.nodeSize - block.node.nodeSize;
			block.pos = res.newPos;
			block.node = res.newNode;
			block.chars = res.nextChars as CoreEntry[];
		} else if (runningDelta !== 0) {
			block.pos += runningDelta;
		}
	}
	previous.doc = doc;
	previous.tokensDirty = true;
	tokenIndexes.delete(previous);
	return change;
}

/** Translate an editor transaction into granular native RGA/attribute operations. */
export function writeDocument(
	context: RichTextContext,
	doc: ProseMirrorNode,
	previous: DocumentView,
	mapping = new Mapping(),
	trackHistory = false,
): EditorChange {
	ensureFullView(previous, doc.type.schema);
	doc.check();
	if (!mapping.maps.length && !doc.eq(previous.doc)) {
		const start = previous.doc.content.findDiffStart(doc.content);
		const end = previous.doc.content.findDiffEnd(doc.content);
		if (start !== null && end) {
			const overlap = Math.max(0, start - Math.min(end.a, end.b));
			mapping = new Mapping([
				new StepMap([start, end.a + overlap - start, end.b + overlap - start]),
			]);
		}
	}
	const { node, model } = context;
	const byObject = new WeakMap(
		previous.nodes.map(({ node, id }) => [node, id]),
	);
	const byPosition = new Map(
		previous.nodes.map((span) => [
			span.pos < 0 ? -1 : mapping.map(span.pos, 1),
			span,
		]),
	);
	const used = new Set<string>();
	const desired: Token[] = [];
	const desiredNodes: NodeSpan[] = [];
	let serial = 0;
	const visit = (current: ProseMirrorNode, pos: number, parent: string) => {
		let id = byObject.get(current);
		const mapped = byPosition.get(pos);
		if (
			!id &&
			mapped &&
			mapped.node.isTextblock === current.isTextblock &&
			mapped.node.isLeaf === current.isLeaf
		)
			id = mapped.id;
		if (!id || used.has(id))
			id = `${model.sid}:${model.nextClock}/node/${serial++}`;
		used.add(id);
		desiredNodes.push({ id, node: current, pos });
		desired.push({
			value: "\uFFFC",
			attributes: nodeAttrs(current, id, parent, doc.type.schema),
			pos,
			size: current.isLeaf ? current.nodeSize : 0,
		});
		current.forEach((child, offset) => {
			if (!child.isText) {
				visit(child, pos + 1 + offset, id!);
				return;
			}
			const attributes: Attributes = { [RT_PARENT]: id };
			for (const mark of child.marks)
				attributes[RT_MARK + mark.type.name] = [mark.attrs];
			let charPos = pos + 1 + offset;
			for (const char of child.text!) {
				desired.push({
					value: char,
					attributes,
					pos: charPos,
					size: char.length,
				});
				charPos += char.length;
			}
		});
	};
	visit(doc, -1, "");
	const old = node.visible;
	const charactersByPosition = new Map<number, Token>();
	for (const token of previous.tokens) {
		if (!token.entry || token.attributes[RT_NODE]) continue;
		const start = mapping.mapResult(token.pos, 1),
			end = mapping.mapResult(token.pos + token.size, -1);
		if (!start.deleted && !end.deleted && end.pos - start.pos === token.size)
			charactersByPosition.set(start.pos, token);
	}
	const newKeys = desired.map((token, index) => {
		if (token.attributes[RT_NODE]) return `node:${token.attributes[RT_NODE]}`;
		const previous = charactersByPosition.get(token.pos);
		return previous?.value === token.value
			? `char:${previous.entry!.id}`
			: `new:${index}`;
	});
	const extraOperations: CoreOperation[] = [];
	// A joined block redirects unseen concurrent characters to its survivor.
	for (const oldSpan of previous.nodes) {
		if (!oldSpan.node.isTextblock || used.has(oldSpan.id)) continue;
		const mappedPos = mapping.map(oldSpan.pos + 1, -1);
		const target = desiredNodes.find(
			(span) =>
				span.node.isTextblock &&
				span.pos < mappedPos &&
				span.pos + span.node.nodeSize > mappedPos,
		);
		const entry = old.find(
			(entry) => entry.marks.get(RT_NODE)?.value === oldSpan.id,
		);
		if (entry && target)
			extraOperations.push({
				kind: 5,
				target: node.id,
				entries: [entry.id],
				attributes: { [RT_REDIRECT]: target.id },
			});
	}
	return reconcileEditorTokens(
		context,
		desired,
		newKeys,
		extraOperations,
		trackHistory,
	);
}

/** Where a token ends: after its character, its leaf, or the opening of its node. */
const tokenEnd = (token: Token): number => token.pos + (token.size || 1);

/** Find the index of the top-level block containing or immediately preceding `position`. */
export function findBlockIndex(
	blocks: readonly BlockInfo[],
	position: number,
): number {
	let low = 0,
		high = blocks.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (blocks[mid]!.pos <= position) low = mid + 1;
		else high = mid;
	}
	return low - 1;
}

/**
 * The anchor of a position: the ID of the entry before it, as the core's
 * `field.anchorAt` gives it, or the ID of the field when nothing precedes it.
 * The closing of a node is not an entry, so a position between two blocks
 * shares its anchor with the end of the block before it.
 */
export function anchorOfPosition(
	context: RichTextContext,
	view: DocumentView,
	position: number,
): string {
	if (
		!Number.isInteger(position) ||
		position < 0 ||
		position > view.doc.content.size
	)
		throw new RangeError(
			`Position ${position} is outside the ProseMirror document`,
		);
	// Fast O(log blocks + blockSize) lookup when blocks are available.
	if (view.blocks.length) {
		if (position === 0) return view.rootAnchor?.id ?? context.node.id;
		const idx = findBlockIndex(view.blocks, position);
		if (idx >= 0) {
			const block = view.blocks[idx]!;
			if (block.simple) {
				if (position === block.pos) {
					// Position at boundary before `block`: end of previous block!
					for (let prev = idx - 1; prev >= 0; prev--) {
						const pb = view.blocks[prev]!;
						if (pb.simple) {
							const lastChar = pb.chars.at(-1);
							if (lastChar) return lastChar.id;
							if (pb.anchor) return pb.anchor.id;
						} else break;
					}
					if (idx === 0) return view.rootAnchor?.id ?? context.node.id;
				} else {
					let charPos = block.pos + 1;
					let lastId: string | undefined = block.anchor?.id;
					for (let i = 0; i < block.chars.length; i++) {
						const entry = block.chars[i]!;
						const len = (entry.value as string).length;
						if (charPos + len <= position) {
							lastId = entry.id;
							charPos += len;
						} else break;
					}
					if (lastId) return lastId;
				}
			}
		}
	}
	ensureFullView(view, view.doc.type.schema);
	// Token ends strictly increase in document order.
	const { tokens } = view;
	let low = 0,
		high = tokens.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (tokenEnd(tokens[middle]!) <= position) low = middle + 1;
		else high = middle;
	}
	// A node the schema had to fill in has no entry: use the one before it.
	for (let index = low - 1; index >= 0; index--) {
		const entry = tokens[index]!.entry;
		if (entry) return entry.id;
	}
	return context.node.id;
}

type TokenIndex = { characters: Map<string, Token>; nodes: Map<string, Token> };
const tokenIndexes = new WeakMap<DocumentView, TokenIndex>();

/**
 * Where an anchor is in a rendered document: after the entry it names, or
 * after the nearest rendered entry before it once that one is gone. 0 for the
 * start of the field; undefined for an anchor of another field or of an entry
 * not received yet.
 */
export function positionOfAnchor(
	context: RichTextContext,
	view: DocumentView,
	anchor: string,
): number | undefined {
	const { node } = context;
	const entry = resolveRichTextAnchor(node, anchor);
	if (!entry) return entry === null ? 0 : undefined;
	// Fast O(blockSize) path via `view.byId` for simple top-level blocks!
	const nodeId = entry.marks.get(RT_NODE)?.value;
	if (typeof nodeId === "string") {
		if (nodeId === view.rootId) return 0;
		const idx = view.byId.get(nodeId);
		if (idx !== undefined) {
			const block = view.blocks[idx]!;
			return block.pos + (block.node.isLeaf ? block.node.nodeSize : 1);
		}
	} else {
		const parentId = entry.marks.get(RT_PARENT)?.value;
		const idx =
			typeof parentId === "string" ? view.byId.get(parentId) : undefined;
		if (idx !== undefined) {
			const block = view.blocks[idx]!;
			if (block.simple) {
				let charPos = block.pos + 1;
				for (let i = 0; i < block.chars.length; i++) {
					const ch = block.chars[i]!;
					charPos += (ch.value as string).length;
					if (ch === entry) return charPos;
				}
			}
		}
	}
	ensureFullView(view, view.doc.type.schema);
	let index = tokenIndexes.get(view);
	if (!index) {
		index = { characters: new Map(), nodes: new Map() };
		for (const token of view.tokens) {
			const id = token.attributes[RT_NODE];
			if (typeof id === "string") index.nodes.set(id, token);
			else if (token.entry) index.characters.set(token.entry.id, token);
		}
		tokenIndexes.set(view, index);
	}
	// Concurrent first bindings give one node several entries: all name it.
	const find = (candidate: CoreEntry): Token | undefined => {
		const id = candidate.marks.get(RT_NODE)?.value;
		return typeof id === "string"
			? index.nodes.get(id)
			: index.characters.get(candidate.id);
	};
	let token = find(entry);
	// An entry can survive without being rendered, in a removed block for one.
	for (let i = node.order.indexOf(entry) - 1; !token && i >= 0; i--)
		if (!node.order[i]!.deleted) token = find(node.order[i]!);
	return token ? tokenEnd(token) : 0;
}

export { matchTokens };
