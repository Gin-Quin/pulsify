import type { LiteralSchema, Schema } from "@gin-quin/codec";
import type { PulseSchemaValue } from "./schema.js";
import type { TreeSchema } from "./treeSchema.js";
import type { Tree } from "./tree.js";
import type { RichText } from "./richText.js";
import { PlainTextSchemaSymbol, RichTextSchemaSymbol } from "./values.js";
import { hasSchemaMarker } from "./constantSchema.js";
import type { PlainText } from "./plainText.js";
import type { SubSchema } from "./subSchema.js";
import type { PulseRef } from "../pulses/PulseRef.js";

/** Codec sees a lazy string schema; Pulsify also sees its collaborative marker. */
export type RichTextSchema = (() => "string") & {
	readonly [RichTextSchemaSymbol]: true;
};

export const richTextSchema: RichTextSchema = Object.freeze(
	Object.assign(() => "string" as const, {
		[RichTextSchemaSymbol]: true as const,
	}),
);

/** A collaborative string without attributes; codec sees a lazy string schema. */
export type PlainTextSchema = (() => "string") & {
	readonly [PlainTextSchemaSymbol]: true;
};

export const plainTextSchema: PlainTextSchema = Object.freeze(
	Object.assign(() => "string" as const, {
		[PlainTextSchemaSymbol]: true as const,
	}),
);

type PublicSchemaFields<Fields extends Record<string, Schema>> = {
	[Key in keyof Fields]: PublicRichTextSchema<Fields[Key]>;
};
type PublicSchemaList<Values extends readonly Schema[]> = {
	[Key in keyof Values]: PublicRichTextSchema<Values[Key]>;
};

/** Type-only substitution lets codec retain its object/union/optional inference. */
export type PublicRichTextSchema<S extends Schema> = Schema extends S
	? S
	: S extends SubSchema<infer Definition>
		? LiteralSchema<PulseRef<Definition>>
		: S extends PlainTextSchema
			? LiteralSchema<PlainText>
			: S extends RichTextSchema
				? LiteralSchema<RichText>
				: S extends TreeSchema<infer Element>
					? LiteralSchema<Tree<PulseSchemaValue<Element>>>
					: S extends () => infer Inner
						? Inner extends Schema
							? () => PublicRichTextSchema<Inner>
							: S
						: S extends object
							? {
									[Key in keyof S]: Key extends "fields"
										? S[Key] extends Record<string, Schema>
											? PublicSchemaFields<S[Key]>
											: S[Key]
										: Key extends "element" | "schema"
											? S[Key] extends Schema
												? PublicRichTextSchema<S[Key]>
												: S[Key]
											: Key extends "elements"
												? S[Key] extends readonly Schema[]
													? PublicSchemaList<S[Key]>
													: S[Key]
												: Key extends "variants"
													? S[Key] extends readonly Schema[]
														? PublicSchemaList<S[Key]>
														: S[Key] extends Record<
																	string | number,
																	Record<string, Schema>
															  >
															? {
																	[Tag in keyof S[Key]]: {
																		[
																			Field in keyof S[Key][Tag]
																		]: PublicRichTextSchema<S[Key][Tag][Field]>;
																	};
																}
															: S[Key]
													: S[Key];
								}
							: S;

/** Recognize an occurrence through optional/lazy wrappers, at compile time only. */
export const isPlainTextSchema = (schema: Schema): boolean =>
	hasSchemaMarker(schema, PlainTextSchemaSymbol);
/** Plain text is the same character sequence, so it counts as a text occurrence. */
export const isRichTextSchema = (schema: Schema): boolean =>
	hasSchemaMarker(schema, RichTextSchemaSymbol) || isPlainTextSchema(schema);

/** Resolve inline markers once, keeping codecs free of per-value marker checks. */
export function codecSchemas(schema: Schema): {
	resolve(schema: Schema): Schema;
} {
	const normalized = new Map<Schema, Schema>();
	let hasMarker = false;
	const normalize = (value: Schema): Schema => {
		if (typeof value === "string") return value;
		const known = normalized.get(value);
		if (known) return known;
		if (typeof value === "function") {
			if (
				Reflect.get(value, RichTextSchemaSymbol) === true ||
				Reflect.get(value, PlainTextSchemaSymbol) === true
			) {
				hasMarker = true;
				normalized.set(value, "string");
				return "string";
			}
			let resolved: Schema;
			const lazy = () => resolved as Exclude<Schema, () => unknown>;
			normalized.set(value, lazy);
			resolved = normalize(value());
			return lazy;
		}
		const copy = { ...value } as Schema & Record<string, unknown>;
		normalized.set(value, copy);
		switch (value._type) {
			case "object":
				copy["fields"] = Object.fromEntries(
					Object.entries(value.fields).map(([key, child]) => [
						key,
						normalize(child),
					]),
				);
				break;
			case "array":
			case "map":
			case "set":
				copy["element"] = normalize(value.element);
				break;
			case "optional":
				copy["schema"] = normalize(value.schema);
				break;
			case "tuple":
				copy["elements"] = value.elements.map(normalize);
				break;
			case "untaggedUnion":
				copy["variants"] = value.variants.map(normalize);
				break;
			case "union":
				copy["variants"] = Object.fromEntries(
					Object.entries(value.variants).map(([tag, fields]) => [
						tag,
						Object.fromEntries(
							Object.entries(fields).map(([key, child]) => [
								key,
								normalize(child),
							]),
						),
					]),
				);
				break;
		}
		return copy;
	};
	normalize(schema);
	return {
		resolve: (value) =>
			hasMarker ? (normalized.get(value) ?? normalize(value)) : value,
	};
}
