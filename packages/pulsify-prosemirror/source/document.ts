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
	isRichTextNode,
	newerTextStamp,
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

type Attributes = Record<string, unknown>;
export type Token = {
	value: string;
	attributes: Attributes;
	entry?: CoreEntry;
	pos: number;
	size: number;
};
export type NodeSpan = { id: string; node: ProseMirrorNode; pos: number };
export type DocumentView = {
	doc: ProseMirrorNode;
	tokens: Token[];
	nodes: NodeSpan[];
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
	return Object.fromEntries(
		[...entry.marks]
			.filter(([, mark]) => mark.value != null)
			.map(([key, mark]) => [key, mark.value]),
	);
}
function unpack(input: Attributes, prefix: string): Attributes {
	return Object.fromEntries(
		Object.entries(input)
			.filter(([key, value]) => key.startsWith(prefix) && Array.isArray(value))
			.map(([key, value]) => [
				key.slice(prefix.length),
				(value as unknown[])[0],
			]),
	);
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
	return Mark.setFrom(
		Object.entries(unpack(attributes, RT_MARK)).map(([name, value]) => {
			const type = schema.marks[name];
			if (!type)
				throw new RangeError(
					`ProseMirror schema does not declare mark ${name}`,
				);
			return type.create(value as Attributes);
		}),
	);
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
	for (let index = 0; index < node.visible.length; index++) {
		const entry = node.visible[index]!;
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
	for (const { entry, index } of characters) {
		const parent = resolve(
			String(entry.marks.get(RT_PARENT)?.value ?? `${node.id}/plain`),
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
		let text = "",
			marks: readonly Mark[] = Mark.none,
			markKey = "";
		const flush = () => {
			if (text) content.push(schema.text(text, marks));
			text = "";
		};
		for (const child of (children.get(id) ?? []).sort(
			(a, b) => a.index - b.index,
		)) {
			if (child.id) {
				flush();
				content.push(build(child.id));
			} else {
				const entry = child.entry!;
				const attributes = attrs(entry);
				const nextKey = JSON.stringify(unpack(attributes, RT_MARK));
				if (!text || nextKey !== markKey) {
					flush();
					marks = readMarks(schema, attributes);
					markKey = nextKey;
				}
				text += entry.value as string;
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
		nodes: NodeSpan[] = [];
	const visit = (
		current: ProseMirrorNode,
		pos: number,
		parent: string,
		ordinal: string,
	) => {
		let id = ids.get(current);
		if (!id) {
			const base = `${node.id}/repair/${ordinal}`;
			id = base;
			for (let suffix = 1; removed.has(id); suffix++) id = `${base}/${suffix}`;
		}
		nodes.push({ id, node: current, pos });
		const anchor = records.get(id)?.entries[0];
		tokens.push({
			value: "\uFFFC",
			attributes: nodeAttrs(current, id, parent, schema),
			...(anchor ? { entry: anchor } : {}),
			pos,
			size: current.isLeaf ? current.nodeSize : 0,
		});
		const textEntries = (children.get(id) ?? [])
			.filter((child) => child.entry)
			.map((child) => child.entry!);
		let offset = 0;
		current.forEach((child, childOffset, index) => {
			const childPos = pos + 1 + childOffset;
			if (!child.isText) {
				visit(child, childPos, id, `${ordinal}/${index}`);
				return;
			}
			let charPos = childPos;
			for (const char of child.text!) {
				const entry = textEntries[offset++];
				tokens.push({
					value: char,
					attributes: entry ? attrs(entry) : { [RT_PARENT]: id },
					...(entry ? { entry } : {}),
					pos: charPos,
					size: char.length,
				});
				charPos += char.length;
			}
		});
	};
	visit(doc, -1, "", "root");
	return { doc, tokens, nodes };
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
		nodes: NodeSpan[] = [];
	let charIndex = 0,
		nodeIndex = 0;
	const visit = (current: ProseMirrorNode, pos: number, parent: string) => {
		const id =
			nodeIndex++ === 0
				? `${context.node.id}/root`
				: `${context.node.id}/plain${nodeIndex === 2 ? "" : `/${nodeIndex}`}`;
		nodes.push({ id, node: current, pos });
		tokens.push({
			value: "\uFFFC",
			attributes: nodeAttrs(current, id, parent, schema),
			pos,
			size: current.isLeaf ? current.nodeSize : 0,
		});
		current.forEach((child, offset) => {
			if (!child.isText) {
				visit(child, pos + 1 + offset, id);
				return;
			}
			let charPos = pos + 1 + offset;
			for (const char of child.text!) {
				const entry = context.node.visible[charIndex++];
				tokens.push({
					value: char,
					attributes: { [RT_PARENT]: id },
					...(entry ? { entry } : {}),
					pos: charPos,
					size: char.length,
				});
				charPos += char.length;
			}
		});
	};
	visit(doc, -1, "");
	return { doc, tokens, nodes };
}

/** Translate an editor transaction into granular native RGA/attribute operations. */
export function writeDocument(
	context: RichTextContext,
	doc: ProseMirrorNode,
	previous: DocumentView,
	mapping = new Mapping(),
	trackHistory = false,
): EditorChange {
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
