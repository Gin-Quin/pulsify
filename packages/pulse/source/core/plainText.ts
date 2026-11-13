import type { CoreModel, CoreNode } from "./model.js";
import { PlainTextSymbol, RichTextSymbol } from "./values.js";
import { plainTextSchema, type PlainTextSchema } from "./richTextSchema.js";
import {
	resolveRichTextAnchor,
	type RichTextContext,
} from "./richTextBinding.js";

/**
 * A collaborative string: concurrent insertions and deletions merge instead
 * of one side replacing the other. Indices and lengths count UTF-16 code
 * units, like `String`; an index inside a surrogate pair is rejected.
 */
export interface PlainText extends Iterable<string> {
	readonly [PlainTextSymbol]: true;
	readonly [RichTextSymbol]: true;
	readonly text: string;
	readonly length: number;
	insert(index: number, text: string): void;
	delete(index: number, count?: number): void;
	/** Delete `count` code units at `index` and insert `text` there, as one edit. */
	replace(index: number, count: number, text: string): void;
	toString(): string;
	toJSON(): string;
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

/** Declare a collaborative string field without formatting in a codec schema. */
export function plainText(): PlainTextSchema;
/**
 * A value to assign to a declared field: `note.body = plainText(input.value)`
 * edits only what changed. Elsewhere it is an ordinary string.
 */
export function plainText(text: string): PlainText;
export function plainText(text?: string): PlainTextSchema | PlainText {
	if (arguments.length === 0) return plainTextSchema;
	assertText(text);
	const unattached = () => {
		throw new TypeError("Attach plain text to a pulse before editing it");
	};
	return Object.freeze({
		[PlainTextSymbol]: true as const,
		[RichTextSymbol]: true as const,
		text,
		length: text.length,
		insert: unattached,
		delete: unattached,
		replace: unattached,
		toString: () => text,
		toJSON: () => text,
		anchorAt: unattached,
		indexOf: unattached,
		[Symbol.toPrimitive]: () => text,
		[Symbol.iterator]: () => text[Symbol.iterator](),
	});
}

function assertText(text: unknown): asserts text is string {
	if (typeof text !== "string" || !text.isWellFormed())
		throw new TypeError("Plain text must be a well-formed Unicode string");
}

export type PlainTextContext = Pick<RichTextContext, "subscribe" | "pulse">;
// A property of the field, not a WeakMap: a framework's view reaches it too.
const Context = Symbol("PlainTextContext");
/** What an editor binding needs from a field: its changes and its pulse. */
export function plainTextContext(field: PlainText): PlainTextContext {
	const context: PlainTextContext | undefined = Reflect.get(field, Context);
	if (!context) throw new TypeError("Bind an attached Pulsify plainText field");
	return context;
}

/**
 * The entry index of a UTF-16 offset: one entry holds one code point.
 */
// ponytail: O(offset) per call, like the text join after every edit; keep a unit index per node if large texts need it.
function entryAt(chars: readonly string[], offset: number): number {
	if (!Number.isSafeInteger(offset) || offset < 0)
		throw new RangeError("Plain text index is out of bounds");
	let units = 0,
		index = 0;
	while (units < offset && index < chars.length)
		units += chars[index++]!.length;
	if (units !== offset)
		throw new RangeError(
			units < offset
				? "Plain text index is out of bounds"
				: "Plain text index splits a surrogate pair",
		);
	return index;
}

/** A stable view of the text node; editing addresses character IDs in the RGA. */
export function createPlainTextProxy(
	node: CoreNode,
	model: CoreModel,
	assertActive: () => void,
	context: PlainTextContext,
): PlainText {
	const chars = (): readonly string[] => {
		assertActive();
		if (!model.isAttached(node))
			throw new TypeError("This pulse plain text has been replaced or removed");
		return node.data;
	};
	const text = () => chars().join("");
	const replace = (index: number, count: number, value: string) => {
		const content = chars();
		const start = entryAt(content, index);
		if (!Number.isSafeInteger(count) || count < 0)
			throw new RangeError("Plain text count must be a non-negative integer");
		assertText(value);
		// A count past the end deletes up to the end, like `String.slice`.
		let end = start,
			units = 0;
		while (units < count && end < content.length)
			units += content[end++]!.length;
		if (units > count)
			throw new RangeError("Plain text index splits a surrogate pair");
		model.spliceText(node, start, end, Array.from(value));
	};
	return Object.freeze({
		[Context]: context,
		[PlainTextSymbol]: true as const,
		[RichTextSymbol]: true as const,
		get text() {
			return text();
		},
		get length() {
			return text().length;
		},
		insert: (index: number, value: string) => replace(index, 0, value),
		delete: (index: number, count = 1) => replace(index, count, ""),
		replace,
		toString: text,
		toJSON: text,
		anchorAt(index: number) {
			const entry = entryAt(chars(), index);
			return entry ? node.visible[entry - 1]!.id : node.id;
		},
		indexOf(anchor: string) {
			chars();
			const entry = resolveRichTextAnchor(node, anchor);
			if (!entry) return entry === null ? 0 : undefined;
			let index = 0;
			for (const candidate of node.visible) {
				index += (candidate.value as string).length;
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
