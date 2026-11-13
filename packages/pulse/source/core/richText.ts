import type { CoreOperation } from "./operations.js";
import type { CoreEntry, CoreModel, CoreNode } from "./model.js";
import { RichTextSymbol, prepareValue } from "./values.js";
import { richTextSchema, type RichTextSchema } from "./richTextSchema.js";
import {
	isRichTextNode,
	RT_NODE,
	RT_PARENT,
	RT_PREFIX,
	RT_TEXTBLOCK,
	richTextContent,
	richTextEntries,
	RichTextContextSymbol,
	resolveRichTextAnchor,
	type RichTextContext,
} from "./richTextBinding.js";

export type RichTextAttributes = Readonly<Record<string, unknown>>;
export type RichTextDelta = {
	insert: string;
	attributes?: Record<string, unknown>;
};

/** Rich text indices and lengths count Unicode code points, rather than UTF-16 units. */
export interface RichText extends Iterable<string> {
	readonly [RichTextSymbol]: true;
	readonly text: string;
	readonly length: number;
	insert(index: number, text: string, attributes?: RichTextAttributes): void;
	delete(index: number, count?: number): void;
	/** `null` or `undefined` removes an attribute from the selected characters. */
	format(index: number, count: number, attributes: RichTextAttributes): void;
	toString(): string;
	toJSON(): string;
	toDelta(): RichTextDelta[];
	/**
	 * The position before `index` as a string that follows its character
	 * through every local and remote edit. Plain data: publish it in presence
	 * or store it in a pulse.
	 */
	anchorAt(index: number): string;
	/**
	 * The index an anchor is at now; where its character was once it is
	 * deleted. `undefined` for an anchor of another field, or of a character
	 * this replica has not received yet.
	 */
	indexOf(anchor: string): number | undefined;
	[Symbol.toPrimitive](hint: string): string;
}

/** Declare a collaborative string field in a codec schema. */
export function richText(): RichTextSchema;
/** Create an initial value marker; attach it to a pulse before editing. */
export function richText(text: string): RichText;
export function richText(text?: string): RichTextSchema | RichText {
	if (arguments.length === 0) return richTextSchema;
	// An explicit undefined is invalid, rather than silently declaring a schema.
	assertText(text);
	const unattached = () => {
		throw new TypeError("Attach rich text to a pulse before editing it");
	};
	return Object.freeze({
		[RichTextSymbol]: true as const,
		text,
		length: Array.from(text).length,
		insert: unattached,
		delete: unattached,
		format: unattached,
		toString: () => text,
		toJSON: () => text,
		toDelta: () => (text ? [{ insert: text }] : []),
		anchorAt: unattached,
		indexOf: unattached,
		[Symbol.toPrimitive]: () => text,
		[Symbol.iterator]: () => text[Symbol.iterator](),
	});
}

/** A stable view of the text node; editing addresses character IDs in the RGA. */
export function createTextProxy(
	node: CoreNode,
	model: CoreModel,
	assertActive: () => void,
	binding: Pick<RichTextContext, "subscribe" | "pulse">,
): RichText {
	const attached = () => {
		assertActive();
		if (!model.isAttached(node))
			throw new TypeError("This pulse rich text has been replaced or removed");
	};
	const text = () => {
		attached();
		return richTextContent(node);
	};
	const visible = () => richTextEntries(node);
	const format = (index: number, count: number, input: RichTextAttributes) => {
		attached();
		assertIndex(index, visible().length);
		assertCount(count);
		const attributes = prepareAttributes(input);
		const entries = visible()
			.slice(index, index + count)
			.map((entry) => entry.id);
		if (entries.length && Object.keys(attributes).length)
			model.commit([{ kind: 5, target: node.id, entries, attributes }]);
	};
	const context: RichTextContext = {
		node,
		model,
		assertActive,
		subscribe: binding.subscribe,
		get pulse() {
			return binding.pulse;
		},
	};
	return Object.freeze({
		[RichTextContextSymbol]: context,
		[RichTextSymbol]: true as const,
		get text() {
			return text();
		},
		get length() {
			attached();
			return visible().length;
		},
		insert(index: number, value: string, attributes?: RichTextAttributes) {
			attached();
			const content = visible();
			assertIndex(index, content.length);
			assertText(value);
			// Validate attributes before inserting any text, so a rejected input
			// cannot leave a partial edit or advance the document clock.
			const prepared =
				attributes === undefined ? {} : prepareAttributes(attributes);
			const neighbor = content[index - 1] ?? content[index];
			const parent =
				neighbor?.marks.get(RT_PARENT)?.value ??
				node.visible
					.findLast((entry) => entry.marks.get(RT_TEXTBLOCK)?.value === true)
					?.marks.get(RT_NODE)?.value;
			if (parent !== undefined) prepared[RT_PARENT] = parent;
			else if (value.length && node.visible.some(isRichTextNode))
				throw new TypeError(
					"Create a text block with an editor transaction before inserting into this field",
				);
			const chars = Array.from(value);
			if (!chars.length) return;
			const clock = model.nextClock;
			const operations: CoreOperation[] = [
				{
					kind: 3,
					target: node.id,
					after: index
						? content[index - 1]!.id
						: neighbor
							? (node.visible[node.visible.indexOf(neighbor) - 1]?.id ?? "")
							: (node.visible.at(-1)?.id ?? ""),
					deletes: [],
					values: chars.map((char) => ({
						value: char,
						constants: [],
						texts: [],
					})),
				},
			];
			if (prepared && Object.keys(prepared).length) {
				// Both operations form one transaction, including quota checks.
				const entries = chars.map(
					(_char, offset) => `${model.sid}:${clock}:${offset}`,
				);
				operations.push({
					kind: 5,
					target: node.id,
					entries,
					attributes: prepared,
				});
			}
			model.commit(operations, content === node.visible ? index : undefined);
		},
		delete(index: number, count = 1) {
			attached();
			assertIndex(index, visible().length);
			assertCount(count);
			const deletes = visible()
				.slice(index, index + count)
				.map((entry) => entry.id);
			if (deletes.length)
				model.commit([
					{ kind: 3, target: node.id, after: "", deletes, values: [] },
				]);
		},
		format,
		toString: text,
		toJSON: text,
		toDelta() {
			attached();
			return entriesToDelta(visible());
		},
		anchorAt(index: number) {
			attached();
			const content = visible();
			assertIndex(index, content.length);
			return index ? content[index - 1]!.id : node.id;
		},
		indexOf(anchor: string) {
			attached();
			const entry = resolveRichTextAnchor(node, anchor);
			if (!entry) return entry === null ? 0 : undefined;
			// The characters up to the entry; structural entries hold no text.
			const content = new Set(visible());
			let index = 0;
			for (const candidate of node.order) {
				if (content.has(candidate)) index++;
				if (candidate === entry) break;
			}
			return index;
		},
		[Symbol.toPrimitive]: text,
		[Symbol.iterator]() {
			return text()[Symbol.iterator]();
		},
	});
}

function assertText(text: unknown): asserts text is string {
	if (typeof text !== "string" || !text.isWellFormed())
		throw new TypeError("Rich text must be a well-formed Unicode string");
}

function assertIndex(index: number, length: number): void {
	if (!Number.isSafeInteger(index) || index < 0 || index > length)
		throw new RangeError("Rich text index is out of bounds");
}

function assertCount(count: number): void {
	if (!Number.isSafeInteger(count) || count < 0)
		throw new RangeError("Rich text count must be a non-negative integer");
}

function prepareAttributes(input: RichTextAttributes): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input))
		throw new TypeError("Rich text attributes must be an object");
	if (Object.keys(input).some((key) => key.startsWith(RT_PREFIX)))
		throw new TypeError(
			"The $pulsify:pm: attribute prefix is reserved for editor bindings",
		);
	return prepareValue(input).value as Record<string, unknown>;
}

function entriesToDelta(entries: readonly CoreEntry[]): RichTextDelta[] {
	const result: RichTextDelta[] = [];
	let previousAttributes: Record<string, unknown> | undefined;
	for (const entry of entries) {
		if (isRichTextNode(entry)) continue;
		const attributes: Record<string, unknown> = {};
		for (const key of [...entry.marks.keys()].sort()) {
			if (key.startsWith(RT_PREFIX)) continue;
			const value = entry.marks.get(key)!.value;
			if (value !== null && value !== undefined)
				attributes[key] = structuredClone(value);
		}
		const previous = result[result.length - 1];
		if (previous && sameAttributes(attributes, previousAttributes))
			previous.insert += entry.value as string;
		else
			result.push(
				Object.keys(attributes).length
					? { insert: entry.value as string, attributes }
					: { insert: entry.value as string },
			);
		previousAttributes = attributes;
	}
	return result;
}

function sameAttributes(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	if (a instanceof Uint8Array || b instanceof Uint8Array)
		return (
			a instanceof Uint8Array &&
			b instanceof Uint8Array &&
			a.length === b.length &&
			a.every((value, i) => value === b[i])
		);
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every(
			(key) =>
				Object.hasOwn(b, key) &&
				sameAttributes(
					(a as Record<string, unknown>)[key],
					(b as Record<string, unknown>)[key],
				),
		)
	);
}
