import type { LiteralSchema, Schema } from "@gin-quin/codec";
import type { RichText } from "./richText.js";
import { RichTextSchemaSymbol } from "./values.js";

/** Codec sees a lazy string schema; Pulsify also sees its collaborative marker. */
export type RichTextSchema = (() => "string") & {
	readonly [RichTextSchemaSymbol]: true;
};

export const richTextSchema: RichTextSchema = Object.freeze(
	Object.assign(() => "string" as const, {
		[RichTextSchemaSymbol]: true as const,
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
	: S extends RichTextSchema
		? LiteralSchema<RichText>
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
															[Field in keyof S[Key][Tag]]: PublicRichTextSchema<
																S[Key][Tag][Field]
															>;
														};
													}
												: S[Key]
										: S[Key];
					}
				: S;

/** Recognize an occurrence through optional/lazy wrappers, at compile time only. */
export function isRichTextSchema(schema: Schema): boolean {
	const seen = new Set<Schema>();
	while (!seen.has(schema)) {
		seen.add(schema);
		if (typeof schema === "function") {
			if (Reflect.get(schema, RichTextSchemaSymbol) === true) return true;
			schema = schema();
		} else if (typeof schema === "object" && schema._type === "optional") {
			schema = schema.schema;
		} else return false;
	}
	return false;
}

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
			if (Reflect.get(value, RichTextSchemaSymbol) === true) {
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
