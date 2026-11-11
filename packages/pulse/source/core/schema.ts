import {
	createCodec,
	createDecoder,
	array,
	object,
	type Codec,
	type InferType,
	type Schema,
} from "@gin-quin/codec";
import type { DeepReadonly } from "../utilities/DeepReadonly.js";
import { fingerprintBytes } from "../utilities/fingerprint.js";
import type { RichText } from "./richText.js";
import type { Tree } from "./tree.js";
import type { TreeSchema } from "./treeSchema.js";
import {
	treeSchemaRole,
	assertTreeStructure,
	TreeSymbol,
} from "./treeSchema.js";
import {
	codecSchemas,
	isRichTextSchema,
	type PublicRichTextSchema,
} from "./richTextSchema.js";
import {
	prepareValue,
	validatePrepared,
	assertKey,
	RichTextSymbol,
	type PreparedValue,
} from "./values.js";
import {
	ConstantSchemaSymbol,
	FrozenSchemaSymbol,
	hasSchemaMarker,
} from "./constantSchema.js";
import { subDefinitionOf } from "./subSchema.js";
import { SubPulseSymbol } from "./values.js";
import { PulseMetaSymbol } from "../pulses/PulseMeta.js";
import type { AnyPulseDefinition } from "../pulses/PulseDefinition.js";

export type PulseSchemaPath = readonly (string | number)[];

/** Annotations do not alter the codec schema or its binary representation. */
export interface PulseSchemaOptions {
	/** @deprecated Wrap the field schema in `constant(...)` instead. */
	readonly constantPaths?: readonly PulseSchemaPath[];
	readonly richTextPaths?: readonly PulseSchemaPath[];
}

type AnnotationPaths<O extends PulseSchemaOptions> = O extends {
	readonly constantPaths: infer Paths extends readonly PulseSchemaPath[];
}
	? Paths[number]
	: never;
type RichTextPaths<O extends PulseSchemaOptions> = O extends {
	readonly richTextPaths: infer Paths extends readonly PulseSchemaPath[];
}
	? Paths[number]
	: never;
type PrependPath<
	Key extends string | number,
	Paths,
> = Paths extends PulseSchemaPath ? readonly [Key, ...Paths] : never;
type ConstantMarker = { readonly [ConstantSchemaSymbol]: true };
type FrozenMarker = { readonly [FrozenSchemaSymbol]: true };
/** Paths of occurrences matching `Match`; optional wrappers pass `Through` only. */
type MarkerPaths<
	S extends Schema,
	Match,
	Through,
	Depth extends unknown[] = [],
> = Depth["length"] extends 12
	? never
	: Schema extends S
		? never
		: S extends TreeSchema
			? never
			: S extends Match
				? readonly []
				: S extends () => infer Inner
					? Inner extends Schema
						? MarkerPaths<Inner, Match, Through, [...Depth, 0]>
						: never
					: S extends {
								_type: "object";
								fields: infer Fields extends Record<string, Schema>;
						  }
						? {
								[Key in keyof Fields]: PrependPath<
									Key & string,
									MarkerPaths<Fields[Key], Match, Through, [...Depth, 0]>
								>;
							}[keyof Fields]
						: S extends {
									_type: "optional";
									schema: infer Inner extends Schema;
							  }
							? Inner extends Through
								? readonly []
								: Exclude<
										MarkerPaths<Inner, Match, Through, [...Depth, 0]>,
										readonly []
									>
							: S extends {
										_type: "array" | "map";
										element: infer Inner extends Schema;
								  }
								? PrependPath<
										"*",
										MarkerPaths<Inner, Match, Through, [...Depth, 0]>
									>
								: S extends {
											_type: "tuple";
											elements: infer Elements extends Schema[];
									  }
									? {
											[Key in keyof Elements]: PrependPath<
												Key & string,
												MarkerPaths<
													Elements[Key],
													Match,
													Through,
													[...Depth, 0]
												>
											>;
										}[number]
									: S extends {
												_type: "union";
												tagName: infer Tag extends string;
												variants: infer Variants extends Record<
													string,
													Record<string, Schema>
												>;
										  }
										? // A discriminant is a literal, hence constant.
											| ({ _type: "literal" } extends Match
													? readonly [Tag]
													: never)
											| {
													[Key in keyof Variants]: MarkerPaths<
														{ _type: "object"; fields: Variants[Key] },
														Match,
														Through,
														[...Depth, 0]
													>;
											  }[keyof Variants]
										: S extends {
													_type: "untaggedUnion";
													variants: infer Variants extends readonly Schema[];
											  }
											? MarkerPaths<
													Variants[number],
													Match,
													Through,
													[...Depth, 0]
												>
											: never;
type LiteralPaths<S extends Schema> = MarkerPaths<
	S,
	{ _type: "literal" } | ConstantMarker,
	ConstantMarker
>;
type FrozenPaths<S extends Schema> = MarkerPaths<S, FrozenMarker, FrozenMarker>;
type ChildPaths<Paths, Key> = Paths extends readonly [infer Head, ...infer Tail]
	? Head extends "*"
		? Tail
		: Key extends number
			? Head extends number | `${number}`
				? Tail
				: never
			: Head extends Key
				? Tail
				: Key extends `${infer Index extends number}`
					? Head extends Index
						? Tail
						: never
					: never
	: never;
type IsConstant<Paths> = [Extract<Paths, readonly []>] extends [never]
	? false
	: true;
type ApplyConstantPaths<Value, Paths> = [Paths] extends [never]
	? Value
	: IsConstant<Paths> extends true
		? DeepReadonly<Value>
		: Value extends Tree<infer Item>
			? Tree<
					ApplyConstantPaths<Item, ChildPaths<ChildPaths<Paths, "*">, "data">>
				>
			: Value extends Date | Uint8Array | Set<unknown>
				? Value
				: Value extends readonly unknown[]
					? {
							[Key in keyof Value]: ApplyConstantPaths<
								Value[Key],
								ChildPaths<Paths, Key>
							>;
						}
					: Value extends object
						? {
								[
									Key in keyof Value as IsConstant<
										ChildPaths<Paths, Key>
									> extends true
										? never
										: Key
								]: ApplyConstantPaths<Value[Key], ChildPaths<Paths, Key>>;
							} & {
								readonly [
									Key in keyof Value as IsConstant<
										ChildPaths<Paths, Key>
									> extends true
										? Key
										: never
								]: DeepReadonly<Value[Key]>;
							}
						: Value;
type ApplyRichTextPaths<Value, Paths> = [Paths] extends [never]
	? Value
	: IsConstant<Paths> extends true
		? Value extends string
			? RichText
			: Value
		: Value extends Tree<infer Item>
			? Tree<
					ApplyRichTextPaths<Item, ChildPaths<ChildPaths<Paths, "*">, "data">>
				>
			: Value extends Date | Uint8Array | Set<unknown>
				? Value
				: Value extends object
					? {
							[Key in keyof Value]: ApplyRichTextPaths<
								Value[Key],
								ChildPaths<Paths, Key>
							>;
						}
					: Value;

type ApplyFrozenPaths<Value, Paths> = [Paths] extends [never]
	? Value
	: IsConstant<Paths> extends true
		? DeepReadonly<Value>
		: Value extends Tree<infer Item>
			? Tree<ApplyFrozenPaths<Item, ChildPaths<ChildPaths<Paths, "*">, "data">>>
			: Value extends Date | Uint8Array | Set<unknown>
				? Value
				: Value extends object
					? {
							[Key in keyof Value]: ApplyFrozenPaths<
								Value[Key],
								ChildPaths<Paths, Key>
							>;
						}
					: Value;

/** Infer codec values while exposing declared constants as readonly properties. */
type SchemaPublicValue<S extends Schema> =
	PublicRichTextSchema<S> extends infer Public
		? Public extends Schema
			? InferType<Public>
			: never
		: never;

export type PulseSchemaValue<
	S extends Schema,
	O extends PulseSchemaOptions = {},
> = ApplyConstantPaths<
	ApplyFrozenPaths<
		ApplyRichTextPaths<SchemaPublicValue<S>, RichTextPaths<O>>,
		FrozenPaths<S>
	>,
	AnnotationPaths<O> | LiteralPaths<S>
>;

export interface PulseField {
	/** Zero-based field slot within its object layout, in codec declaration order. */
	readonly id: number;
	readonly key: string;
	readonly layout: PulseLayout;
	readonly constant: boolean;
	readonly richText: boolean;
	readonly get: (value: unknown) => unknown;
	readonly set: (value: unknown, next: unknown) => void;
}

/** Layout IDs identify schema occurrences; field slots identify object members. */
export interface PulseLayout {
	readonly id: number;
	readonly schema: Schema;
	readonly kind: string;
	/** Annotations on this occurrence, including array/map element layouts. */
	readonly constant: boolean;
	/** Replaceable as a whole; descendants are constant and stored with it. */
	readonly frozen: boolean;
	readonly richText: boolean;
	readonly tree: boolean;
	readonly treeRole?: "tree" | "node" | "location";
	/** The child definition of a `sub()` field; the stored value is its ID. */
	readonly sub?: AnyPulseDefinition;
	readonly codec: Codec<unknown>;
	/** Validate only this node's value, before it enters the operation journal. */
	readonly assert: (value: unknown) => unknown;
	readonly clone: (value: unknown) => unknown;
	/** Detach stored data while preserving deleted, retired and reordered fields. */
	readonly snapshot: (value: unknown, documentRoot?: boolean) => unknown;
	readonly prepare: (value: unknown, initialDepth?: number) => PreparedValue;
	readonly assertShallow: (value: unknown) => unknown;
	readonly fields: readonly PulseField[];
	readonly fieldsByKey: ReadonlyMap<string, PulseField>;
	readonly element?: PulseLayout;
	readonly elements?: readonly PulseLayout[];
	readonly variants?: ReadonlyMap<string, PulseLayout>;
	readonly tagName?: string;
	/** The wrapped layout of an optional schema. */
	readonly value?: PulseLayout;
}

export interface CompiledPulseSchema<S extends Schema = Schema> {
	readonly schema: S;
	/** Inline rich-text fields normalized to strings for compiled codec hot paths. */
	readonly codecSchema?: Schema;
	/** Inline declarations, separate from explicit path annotations. */
	readonly inferredRichTextPaths?: readonly PulseSchemaPath[];
	readonly inferredConstantPaths?: readonly PulseSchemaPath[];
	readonly options: PulseSchemaOptions;
	readonly codec: Codec<InferType<S>>;
	readonly root: PulseLayout;
	readonly layouts: readonly PulseLayout[];
	/** Returns a named object field; use layoutAt for an array/map element. */
	fieldAt(path: PulseSchemaPath, value?: unknown): PulseField | undefined;
	layoutAt(path: PulseSchemaPath, value?: unknown): PulseLayout | undefined;
	encode(layoutId: number, value: unknown): Uint8Array<ArrayBuffer>;
	decode(layoutId: number, bytes: Uint8Array): unknown;
	validate(layoutId: number, value: unknown): void;
	/** Schema-specialized detached copy, without an encode/decode round trip. */
	clone(value: InferType<S>): InferType<S>;
	assert(value: unknown): InferType<S>;
	prepare(value: unknown, initialDepth?: number): PreparedValue;
}

interface MutableLayout {
	id: number;
	schema: Schema;
	kind: string;
	constant: boolean;
	frozen: boolean;
	richText: boolean;
	tree: boolean;
	treeRole?: "tree" | "node" | "location";
	sub?: AnyPulseDefinition;
	codec: Codec<unknown>;
	assert: (value: unknown) => unknown;
	clone: (value: unknown) => unknown;
	snapshot: (value: unknown, documentRoot?: boolean) => unknown;
	prepare: (value: unknown, initialDepth?: number) => PreparedValue;
	assertShallow: (value: unknown) => unknown;
	fields: PulseField[];
	fieldsByKey: Map<string, PulseField>;
	element?: PulseLayout;
	elements?: PulseLayout[];
	variants?: Map<string, PulseLayout>;
	tagName?: string;
	value?: PulseLayout;
}

/**
 * Compile once per document definition. Hot paths use numeric slots and the
 * specialized codec functions; they never walk the schema descriptor tree.
 * `*` in an annotation path matches any array index or map key.
 */
const emptyMatchStack = new WeakSet<object>();
export function compilePulseSchema<S extends Schema>(
	schema: S,
	options: PulseSchemaOptions = {},
): CompiledPulseSchema<S> {
	const wireSchemas = codecSchemas(schema);
	const inferredRichTextPaths: PulseSchemaPath[] = [];
	const inferredConstantPaths: PulseSchemaPath[] = [];
	const layouts: MutableLayout[] = [];
	const codecs = new Map<Schema, Codec<unknown>>();
	const active = new Map<Schema, Map<string, MutableLayout>>();
	const cloneFunctions: Array<(value: unknown) => unknown> = [];
	const snapshotFunctions: Array<
		(value: unknown, documentRoot?: boolean) => unknown
	> = [];
	const matchFunctions: Array<
		(value: unknown, stack: WeakSet<object>) => boolean
	> = [];
	const prepareFunctions: PrepareFunction[] = [];
	const cloneLiterals: unknown[] = [];
	const constantPaths = options.constantPaths ?? [];
	const richTextPaths = options.richTextPaths ?? [];
	const annotationState = (
		path: PulseSchemaPath,
		constant: boolean,
		richText: boolean,
	) =>
		JSON.stringify([
			constant,
			richText,
			constant
				? []
				: constantPaths
						.filter(
							(candidate) =>
								candidate.length > path.length &&
								matchesPrefix(path, candidate),
						)
						.map((candidate) => candidate.slice(path.length)),
			richTextPaths
				.filter(
					(candidate) =>
						candidate.length > path.length && matchesPrefix(path, candidate),
				)
				.map((candidate) => candidate.slice(path.length)),
		]);
	const activate = (
		descriptor: Schema,
		state: string,
		layout: MutableLayout,
	) => {
		let states = active.get(descriptor);
		if (!states) active.set(descriptor, (states = new Map()));
		states.set(state, layout);
	};
	const codecFor = (descriptor: Schema): Codec<unknown> => {
		let codec = codecs.get(descriptor);
		if (!codec) {
			codec = createCodec(wireSchemas.resolve(descriptor));
			codecs.set(descriptor, codec);
		}
		return codec;
	};
	/** `inherited` marks descendants of a constant or frozen occurrence. */
	const build = (
		descriptor: Schema,
		path: PulseSchemaPath,
		inherited = false,
		inheritedFrozen = false,
	): MutableLayout => {
		const resolved = resolveSchema(descriptor);
		const inlineRichText = isRichTextSchema(descriptor);
		const inlineConstant = hasSchemaMarker(descriptor, ConstantSchemaSymbol);
		const treeRole = treeSchemaRole(descriptor);
		const subDefinition = subDefinitionOf(descriptor);
		const tree = treeRole === "tree";
		const annotated = constantPaths.some((candidate) =>
			matchesPrefix(candidate, path),
		);
		const constant =
			inherited ||
			inlineConstant ||
			annotated ||
			(typeof resolved === "object" && resolved._type === "literal");
		const frozen =
			!constant &&
			(inheritedFrozen || hasSchemaMarker(descriptor, FrozenSchemaSymbol));
		const richText =
			inlineRichText ||
			richTextPaths.some((candidate) => pathsMatch(candidate, path));
		const state =
			annotationState(path, constant, richText) +
			(frozen ? ".frozen" : "") +
			(treeRole ? `.${treeRole}` : "");
		const existing = active.get(descriptor)?.get(state);
		if (existing) return existing;
		const resolvedExisting = active.get(resolved)?.get(state);
		if (resolvedExisting) return resolvedExisting;
		if (inlineRichText) inferredRichTextPaths.push(path);
		if (inlineConstant && !inherited && !annotated)
			inferredConstantPaths.push(path);
		const kind = typeof resolved === "string" ? resolved : resolved._type;
		if (
			frozen &&
			(typeof resolved === "string"
				? resolved !== "unknown" && resolved !== "schema"
				: resolved._type === "literal")
		)
			throw new TypeError(
				`frozen() requires a structured schema, not ${kind}; use constant() instead`,
			);
		const layout: MutableLayout = {
			id: layouts.length,
			schema: descriptor,
			kind,
			constant,
			frozen,
			richText,
			codec: codecFor(descriptor),
			tree,
			...(treeRole ? { treeRole } : {}),
			...(subDefinition ? { sub: subDefinition } : {}),
			assert(value) {
				if (
					!matchFunctions[layout.id]!(
						value,
						typeof resolved === "string" ? emptyMatchStack : new WeakSet(),
					)
				)
					throw new TypeError(
						`Value does not match pulse schema layout ${layout.id} (${kind})`,
					);
				return value;
			},
			clone: (value) => cloneFunctions[layout.id]!(value),
			snapshot: (value, documentRoot = false) =>
				snapshotFunctions[layout.id]!(value, documentRoot),
			prepare: (value, depth = 0) =>
				runPrepared(prepareFunctions[layout.id]!, value, depth),
			assertShallow: (value) => value,
			fields: [],
			fieldsByKey: new Map(),
		};
		layouts.push(layout);
		activate(descriptor, state, layout);
		activate(resolved, state, layout);
		const locked = constant || frozen;
		if (typeof resolved !== "string") {
			switch (resolved._type) {
				case "object":
					for (const [key, fieldSchema] of Object.entries(resolved.fields)) {
						assertSchemaProperty(key);
						const fieldPath = [...path, key];
						const child = build(fieldSchema, fieldPath, locked);
						const field: PulseField = {
							id: layout.fields.length,
							key,
							layout: child,
							constant: child.constant,
							richText: child.richText,
							get: new Function(
								"value",
								`return value[${JSON.stringify(key)}];`,
							) as PulseField["get"],
							set: new Function(
								"value",
								"next",
								key === "__proto__"
									? `Object.defineProperty(value, "__proto__", {value: next, enumerable: true, writable: true, configurable: true});`
									: `value[${JSON.stringify(key)}] = next;`,
							) as PulseField["set"],
						};
						if (
							field.richText &&
							unwrapOptional(field.layout).kind !== "string"
						)
							throw new TypeError(
								"Rich text annotations require a string schema",
							);
						if (field.richText && field.constant)
							throw new TypeError(
								"A constant field cannot also be collaborative rich text",
							);
						layout.fields.push(field);
						layout.fieldsByKey.set(key, field);
					}
					break;
				case "array":
				case "map":
				case "set":
					layout.element = build(resolved.element, [...path, "*"], locked);
					break;
				case "tuple":
					layout.elements = resolved.elements.map((element, index) =>
						build(element, [...path, index], locked),
					);
					break;
				case "optional":
					layout.value = build(resolved.schema, path, constant, frozen);
					break;
				case "union": {
					assertSchemaProperty(resolved.tagName);
					layout.tagName = resolved.tagName;
					layout.variants = new Map();
					for (const [tag, fields] of Object.entries(resolved.variants)) {
						// The discriminant is represented as a literal in the variant
						// layout so its field has a stable slot and cannot be edited.
						const tagValue = resolved.type === "string" ? tag : Number(tag);
						const variantFields: Record<string, Schema> = {
							[resolved.tagName]: { _type: "literal", value: tagValue },
						};
						for (const [key, child] of Object.entries(fields)) {
							assertSchemaProperty(key);
							if (key !== resolved.tagName) variantFields[key] = child;
						}
						const variantSchema: Schema = {
							_type: "object",
							fields: variantFields,
						};
						layout.variants.set(tag, build(variantSchema, path, locked));
					}
					break;
				}
				case "untaggedUnion":
					layout.elements = resolved.variants.map((variant) =>
						build(variant, path, locked),
					);
					break;
			}
		}
		if (layout.richText && unwrapOptional(layout).kind !== "string")
			throw new TypeError("Rich text annotations require a string schema");
		if (layout.richText && layout.constant)
			throw new TypeError(
				"A constant field cannot also be collaborative rich text",
			);
		if (layout.tree && (layout.constant || layout.frozen))
			throw new TypeError(
				"A constant field cannot also be a collaborative tree",
			);
		active.get(descriptor)?.delete(state);
		active.get(resolved)?.delete(state);
		return layout;
	};
	const root = build(schema, []);
	for (const layout of layouts) {
		const source = cloneSource(layout, cloneLiterals);
		cloneFunctions[layout.id] = new Function(
			"clones",
			"literals",
			"matches",
			`return function cloneSchemaValue(value) {${source}}`,
		)(cloneFunctions, cloneLiterals, matchFunctions) as (
			value: unknown,
		) => unknown;
		snapshotFunctions[layout.id] = new Function(
			"snapshots",
			"matches",
			`return function snapshotSchemaValue(value,documentRoot=false) {${snapshotSource(layout)}}`,
		)(snapshotFunctions, matchFunctions) as (
			value: unknown,
			documentRoot?: boolean,
		) => unknown;
		matchFunctions[layout.id] = new Function(
			"matches",
			"codecs",
			"isRecord",
			"assertTreeStructure",
			`return function matchesSchemaValue(value,stack) {${layout.treeRole ? `if(value!==undefined){try{assertTreeStructure(value,${JSON.stringify(layout.treeRole)});}catch{return false;}}` : ""}${matchSource(layout)}}`,
		)(
			matchFunctions,
			layouts.map((entry) => entry.codec),
			isRecord,
			assertTreeStructure,
		) as (value: unknown, stack: WeakSet<object>) => boolean;
	}
	const cyclic = cyclicLayouts(layouts);
	for (const layout of layouts) {
		prepareFunctions[layout.id] = new Function(
			"prepares",
			"layouts",
			"helpers",
			`const {RichTextSymbol,TreeSymbol,SubPulseSymbol,PulseMetaSymbol,assertTreeStructure,recordMarker,prepareFallback,prepareExtra,assertKey}=helpers;return function prepareCompiled(value,ctx,initialDepth,skipMarkers){${prepareSource(layout, cyclic)}}`,
		)(prepareFunctions, layouts, {
			RichTextSymbol,
			TreeSymbol,
			SubPulseSymbol,
			PulseMetaSymbol,
			assertTreeStructure,
			recordMarker,
			prepareFallback,
			prepareExtra,
			assertKey,
		}) as PrepareFunction;
		layout.assertShallow = new Function(
			"layouts",
			"assertTreeStructure",
			`return function assertShallow(value){${layout.treeRole ? `if(value!==undefined)assertTreeStructure(value,${JSON.stringify(layout.treeRole)});` : ""}${shallowSource(layout)}}`,
		)(layouts, assertTreeStructure) as (value: unknown) => unknown;
	}
	const at = (path: PulseSchemaPath, value: unknown) => {
		let current: PulseLayout | undefined = root;
		let field: PulseField | undefined;
		for (const key of path) {
			current = selectLayout(current, value);
			if (!current) return undefined;
			field = undefined;
			if (current.kind === "object") {
				field = current.fieldsByKey.get(String(key));
				current = field?.layout;
			} else if (current.kind === "array" || current.kind === "map") {
				if (current.kind === "array" && key !== "*" && !isArrayIndex(key))
					return undefined;
				current = current.element;
			} else if (current.kind === "tuple") {
				current = isArrayIndex(key)
					? current.elements?.[Number(key)]
					: undefined;
			} else return undefined;
			value =
				value !== null && typeof value === "object"
					? (value as Record<string | number, unknown>)[key]
					: undefined;
		}
		return current ? { layout: current, field } : undefined;
	};
	return {
		schema,
		codecSchema: wireSchemas.resolve(schema),
		inferredRichTextPaths,
		inferredConstantPaths,
		options,
		codec: root.codec as Codec<InferType<S>>,
		root,
		layouts,
		fieldAt: (path, value) => at(path, value)?.field,
		layoutAt: (path, value) => at(path, value)?.layout,
		encode(id, value) {
			const layout = layouts[id];
			if (!layout) throw new RangeError("Unknown pulse schema layout");
			return layout.codec.encode(value);
		},
		decode(id, bytes) {
			const layout = layouts[id];
			if (!layout) throw new RangeError("Unknown pulse schema layout");
			const decoder = createDecoder(bytes);
			const result = layout.codec.decode(decoder);
			if (decoder.pos !== bytes.length)
				throw new TypeError("Trailing bytes after pulse field value");
			return result;
		},
		validate(id, value) {
			const layout = layouts[id];
			if (!layout) throw new RangeError("Unknown pulse schema layout");
			layout.assert(value);
		},
		clone: (value) => cloneFunctions[root.id]!(value) as InferType<S>,
		assert: (value) => root.assert(value) as InferType<S>,
		prepare: (value, depth = 0) => root.prepare(value, depth),
	};
}

function resolveSchema(schema: Schema): Exclude<Schema, () => unknown> {
	const seen = new Set<Schema>();
	while (typeof schema === "function") {
		if (seen.has(schema))
			throw new TypeError("Schema resolver does not reach a concrete schema");
		seen.add(schema);
		schema = schema();
	}
	return schema;
}

/** Compiled property slots bypass repeated key checks in the mutation path. */
function assertSchemaProperty(key: string): void {
	if (
		!key.isWellFormed() ||
		key === "__proto__" ||
		key === "constructor" ||
		key === "prototype"
	)
		throw new TypeError(
			`Unsupported pulse schema property ${JSON.stringify(key)}`,
		);
}

function unwrapOptional(layout: PulseLayout): PulseLayout {
	while (layout.kind === "optional" && layout.value) layout = layout.value;
	return layout;
}

function selectLayout(
	layout: PulseLayout | undefined,
	value: unknown,
): PulseLayout | undefined {
	if (!layout) return undefined;
	layout = unwrapOptional(layout);
	if (layout.kind === "union") {
		if (value === null || typeof value !== "object") return undefined;
		return layout.variants?.get(
			String((value as Record<string, unknown>)[layout.tagName!]),
		);
	}
	return layout;
}

function matchesPrefix(
	candidate: PulseSchemaPath,
	path: PulseSchemaPath,
): boolean {
	return (
		candidate.length <= path.length &&
		candidate.every(
			(part, index) =>
				part === "*" ||
				path[index] === "*" ||
				String(part) === String(path[index]),
		)
	);
}

function pathsMatch(
	candidate: PulseSchemaPath,
	path: PulseSchemaPath,
): boolean {
	return candidate.length === path.length && matchesPrefix(candidate, path);
}

function isArrayIndex(key: string | number): boolean {
	const index = Number(key);
	return (
		Number.isSafeInteger(index) && index >= 0 && String(index) === String(key)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		!(value instanceof Date) &&
		!(value instanceof Uint8Array) &&
		!(value instanceof Set)
	);
}

function matchSource(layout: PulseLayout): string {
	const matchAt = (child: PulseLayout, expression: string) =>
		`matches[${child.id}](${expression},stack)`;
	const guardCycle = (body: string) =>
		`if(stack.has(value)) return false;stack.add(value);try {${body}} finally {stack.delete(value);}`;
	switch (layout.kind) {
		case "object":
			return `if(!isRecord(value)) return false;${guardCycle(
				`return ${
					layout.fields
						.map((field) =>
							matchAt(field.layout, `value[${JSON.stringify(field.key)}]`),
						)
						.join("&&") || "true"
				};`,
			)}`;
		case "array":
			return `if(!Array.isArray(value)) return false;${guardCycle(`for(let i=0;i<value.length;i++) if(!Object.hasOwn(value,i)||!${matchAt(layout.element!, "value[i]")}) return false;return true;`)}`;
		case "map":
			return `if(!isRecord(value)) return false;${guardCycle(`for(const key of Object.keys(value)) if(!${matchAt(layout.element!, "value[key]")}) return false;return true;`)}`;
		case "set":
			return `if(!(value instanceof Set)) return false;${guardCycle(`for(const item of value) if(!${matchAt(layout.element!, "item")}) return false;return true;`)}`;
		case "tuple":
			return `if(!Array.isArray(value)||value.length!==${layout.elements!.length}) return false;${guardCycle(`return ${layout.elements!.map((child, index) => matchAt(child, `value[${index}]`)).join("&&") || "true"};`)}`;
		case "optional":
			return `return value === undefined || ${matchAt(layout.value!, "value")};`;
		case "union":
			return `if(!isRecord(value)) return false;switch(String(value[${JSON.stringify(layout.tagName)}])){${[
				...layout.variants!,
			]
				.map(
					([tag, child]) =>
						`case ${JSON.stringify(tag)}:return ${matchAt(child, "value")};`,
				)
				.join("")}default:return false;}`;
		case "untaggedUnion":
			return `return ${layout.elements!.map((child) => matchAt(child, "value")).join("||") || "false"};`;
		case "int":
		case "int32":
		case "int64":
			return "return Number.isSafeInteger(value);";
		case "uint":
		case "uint32":
		case "uint64":
			return "return Number.isSafeInteger(value) && value >= 0;";
		case "float32":
			return 'return typeof value === "number" && Number.isFinite(Math.fround(value));';
		case "float64":
			return 'return typeof value === "number" && Number.isFinite(value);';
		case "boolean":
			return `return typeof value === ${JSON.stringify(layout.kind)};`;
		case "string":
			return 'return typeof value === "string" && value.isWellFormed();';
		case "date":
			return "return value instanceof Date && Number.isFinite(value.getTime());";
		case "uint8Array":
			return "return value instanceof Uint8Array;";
		case "undefined":
			return "return value === undefined;";
		case "null":
			return "return value === null;";
		default:
			// Codec owns equality for literals and the value grammar for unknown,
			// bigint bounds, and schema values. These uncommon boundaries retain
			// its exact checks without duplicating the wire-format implementation.
			return `try {codecs[${layout.id}].encode(value);return true;} catch {return false;}`;
	}
}

function cloneSource(layout: PulseLayout, literals: unknown[]): string {
	const descriptor = resolveSchema(layout.schema);
	const cloneAt = (child: PulseLayout, expression: string) =>
		`clones[${child.id}](${expression})`;
	switch (layout.kind) {
		case "object":
			return `return {${layout.fields
				.map(
					(field) =>
						`[${JSON.stringify(field.key)}]:${cloneAt(field.layout, `value[${JSON.stringify(field.key)}]`)}`,
				)
				.join(",")}};`;
		case "array":
			return `const result = new Array(value.length);for(let i=0;i<value.length;i++) result[i]=${cloneAt(layout.element!, "value[i]")};return result;`;
		case "map":
			return `const result = {};for(const key of Object.keys(value)) Object.defineProperty(result,key,{value:${cloneAt(layout.element!, "value[key]")},enumerable:true,writable:true,configurable:true});return result;`;
		case "set":
			return `const result = new Set();for(const item of value) result.add(${cloneAt(layout.element!, "item")});return result;`;
		case "tuple":
			return `return [${layout.elements!.map((child, index) => cloneAt(child, `value[${index}]`)).join(",")}];`;
		case "optional":
			return `return value === undefined ? undefined : ${cloneAt(layout.value!, "value")};`;
		case "union":
			return `switch(String(value[${JSON.stringify(layout.tagName)}])){${[
				...layout.variants!,
			]
				.map(
					([tag, child]) =>
						`case ${JSON.stringify(tag)}:return ${cloneAt(child, "value")};`,
				)
				.join(
					"",
				)}default:throw new TypeError("Unknown pulse schema union tag");}`;
		case "untaggedUnion":
			return `${layout.elements!.map((child) => `if(matches[${child.id}](value,new WeakSet())) return ${cloneAt(child, "value")};`).join("")}throw new TypeError("Value does not match an untagged union variant");`;
		case "literal": {
			if (typeof descriptor !== "object" || descriptor._type !== "literal")
				throw new TypeError("Invalid literal layout");
			const index = literals.push(descriptor.value) - 1;
			return `return structuredClone(literals[${index}]);`;
		}
		case "date":
			return "return new Date(value.getTime());";
		case "uint8Array":
			return "return new Uint8Array(value);";
		case "float32":
			return "return Math.fround(value);";
		case "int":
		case "int32":
		case "int64":
		case "uint":
		case "uint32":
		case "uint64":
			return "return value === 0 ? 0 : value;";
		case "unknown":
		case "schema":
			return "return structuredClone(value);";
		default:
			return "return value;";
	}
}

/** Stored values can retain fields from older layouts or omit deleted optionals. */
function snapshotSource(layout: PulseLayout): string {
	const snapshotAt = (child: PulseLayout, expression: string, root = false) =>
		`snapshots[${child.id}](${expression}${root ? ",documentRoot" : ""})`;
	switch (layout.kind) {
		case "object": {
			const fields = layout.fields.map((field) => field.key);
			const metadata = ["id", "kind", "version", "generation"].filter(
				(key) => !layout.fieldsByKey.has(key),
			);
			const objectSource = (keys: string[]) => {
				const shape = [
					`keys.length!==${keys.length}`,
					...keys.map(
						(key, index) => `keys[${index}]!==${JSON.stringify(key)}`,
					),
				].join("||");
				const entries = keys.map((key) => {
					const field = layout.fieldsByKey.get(key);
					const expression = `value[${JSON.stringify(key)}]`;
					return `[${JSON.stringify(key)}]:${field ? snapshotAt(field.layout, expression) : expression}`;
				});
				return `if(${shape})return structuredClone(value);return {${entries.join(",")}};`;
			};
			return `const keys=Object.keys(value);${metadata.length ? `if(documentRoot){${objectSource([...fields, ...metadata])}}` : ""}${objectSource(fields)}`;
		}
		case "array":
			return `const result=new Array(value.length);for(let i=0;i<value.length;i++)result[i]=${snapshotAt(layout.element!, "value[i]")};return result;`;
		case "map":
			return `const result={};for(const key of Object.keys(value))Object.defineProperty(result,key,{value:${snapshotAt(layout.element!, "value[key]")},enumerable:true,writable:true,configurable:true});return result;`;
		case "set":
			return `const result=new Set();for(const item of value)result.add(${snapshotAt(layout.element!, "item")});return result;`;
		case "tuple":
			return `return [${layout.elements!.map((child, index) => snapshotAt(child, `value[${index}]`)).join(",")}];`;
		case "optional":
			return `return value===undefined?undefined:${snapshotAt(layout.value!, "value", true)};`;
		case "union":
			return `switch(String(value[${JSON.stringify(layout.tagName)}])){${[
				...layout.variants!,
			]
				.map(
					([tag, child]) =>
						`case ${JSON.stringify(tag)}:return ${snapshotAt(child, "value", true)};`,
				)
				.join("")}default:return structuredClone(value);}`;
		case "untaggedUnion":
			return `${layout.elements!.map((child) => `if(matches[${child.id}](value,new WeakSet()))return ${snapshotAt(child, "value", true)};`).join("")}return structuredClone(value);`;
		case "uint8Array":
			return "return new Uint8Array(value);";
		case "date":
			return "return new Date(value.getTime());";
		case "literal":
		case "unknown":
		case "schema":
			return "return structuredClone(value);";
		default:
			return "return value;";
	}
}

type PrepareFunction = (
	value: unknown,
	context: PrepareContext,
	depth: number,
	skipMarkers: boolean,
) => unknown;
interface PrepareContext {
	path: (string | number)[];
	keyOrders: (readonly string[] | undefined)[];
	constants: string[][];
	texts: string[][];
	ancestors?: Set<object>;
	markerOrders?: Map<string[], number[]>;
}
const emptyPreparedPaths: string[][] = [];
const primitivePrepareContext: PrepareContext = {
	path: [],
	keyOrders: [],
	constants: emptyPreparedPaths,
	texts: emptyPreparedPaths,
};

function runPrepared(
	prepare: PrepareFunction,
	input: unknown,
	depth: number,
): PreparedValue {
	if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32)
		throw new TypeError("Pulse values may nest at most 32 levels");
	if (input === null || typeof input !== "object")
		return {
			value: prepare(input, primitivePrepareContext, depth, false),
			constants: emptyPreparedPaths,
			texts: emptyPreparedPaths,
		};
	const context: PrepareContext = {
		path: [],
		keyOrders: [],
		constants: [],
		texts: [],
	};
	const value = prepare(input, context, depth, false);
	const prepared = {
		value,
		constants: context.constants,
		texts: context.texts,
	};
	if (context.markerOrders) {
		const compare = (left: string[], right: string[]) => {
			const a = context.markerOrders!.get(left)!,
				b = context.markerOrders!.get(right)!;
			for (let i = 0; i < Math.min(a.length, b.length); i++)
				if (a[i] !== b[i]) return a[i]! - b[i]!;
			return a.length - b.length;
		};
		if (context.constants.length > 1) context.constants.sort(compare);
		if (context.texts.length > 1) context.texts.sort(compare);
		validatePrepared(prepared);
	}
	return prepared;
}

/** Allocate paths only for explicit markers; sort them in the input's DFS order. */
function recordMarker(
	context: PrepareContext,
	text: boolean,
	suffix: readonly string[] = [],
	suffixValue?: unknown,
): void {
	const path = context.path.map(String);
	const order = context.path.map(
		(key, i) => context.keyOrders[i]?.indexOf(String(key)) ?? Number(key),
	);
	let current = suffixValue;
	for (const key of suffix) {
		path.push(key);
		order.push(
			Array.isArray(current)
				? Number(key)
				: Object.keys(current as object).indexOf(key),
		);
		current = (current as Record<string, unknown>)[key];
	}
	(text ? context.texts : context.constants).push(path);
	(context.markerOrders ??= new Map()).set(path, order);
}

function checkPreparedDepth(value: unknown, depth: number): void {
	if (depth > 32)
		throw new TypeError("Pulse values may nest at most 32 levels");
	if (value && typeof value === "object" && !(value instanceof Uint8Array))
		for (const key of Object.keys(value))
			checkPreparedDepth((value as Record<string, unknown>)[key], depth + 1);
}

function prepareFallback(
	layout: PulseLayout,
	input: unknown,
	context: PrepareContext,
	depth: number,
): unknown {
	const prepared = prepareValue(input);
	checkPreparedDepth(prepared.value, depth);
	for (const path of prepared.texts)
		if (depth + path.length + 1 > 32)
			throw new TypeError("Pulse values may nest at most 32 levels");
	layout.assert(prepared.value);
	const value = layout.clone(prepared.value);
	checkPreparedDepth(value, depth);
	if (prepared.constants.length || prepared.texts.length) {
		validatePrepared({ ...prepared, value });
		// The generated entry has already consumed markers on this occurrence.
		for (const path of prepared.constants)
			if (path.length) recordMarker(context, false, path, prepared.value);
		for (const path of prepared.texts)
			if (path.length) recordMarker(context, true, path, prepared.value);
	}
	return value;
}

function prepareExtra(
	input: unknown,
	context: PrepareContext,
	depth: number,
): void {
	if (depth > 32)
		throw new TypeError("Pulse values may nest at most 32 levels");
	if (
		input === null ||
		input === undefined ||
		typeof input === "boolean" ||
		typeof input === "bigint"
	)
		return;
	if (typeof input === "number") {
		if (!Number.isFinite(input)) throw new TypeError("Numbers must be finite");
		return;
	}
	if (typeof input === "string") {
		if (!input.isWellFormed())
			throw new TypeError("Strings must be valid Unicode");
		return;
	}
	const prepared = prepareValue(input);
	checkPreparedDepth(prepared.value, depth);
	for (const path of prepared.constants)
		recordMarker(context, false, path, prepared.value);
	for (const path of prepared.texts) {
		if (depth + path.length + 1 > 32)
			throw new TypeError("Pulse values may nest at most 32 levels");
		recordMarker(context, true, path, prepared.value);
	}
}

function layoutChildren(layout: PulseLayout): PulseLayout[] {
	return [
		...layout.fields.map((field) => field.layout),
		...(layout.element ? [layout.element] : []),
		...(layout.elements ?? []),
		...(layout.value ? [layout.value] : []),
		...(layout.variants?.values() ?? []),
	];
}

function cyclicLayouts(layouts: readonly PulseLayout[]): Set<number> {
	const result = new Set<number>(),
		completed = new Set<number>();
	const active: number[] = [],
		positions = new Map<number, number>();
	const visit = (layout: PulseLayout) => {
		const position = positions.get(layout.id);
		if (position !== undefined) {
			for (const id of active.slice(position)) result.add(id);
			return;
		}
		if (completed.has(layout.id)) return;
		positions.set(layout.id, active.length);
		active.push(layout.id);
		for (const child of layoutChildren(layout)) visit(child);
		active.pop();
		positions.delete(layout.id);
		completed.add(layout.id);
	};
	for (const layout of layouts) visit(layout);
	return result;
}

function plainRecordCheck(value: string, fail: string): string {
	return `if(${value}===null||typeof ${value}!=="object"||Array.isArray(${value}))${fail};{const proto=Object.getPrototypeOf(${value});if(proto!==Object.prototype&&proto!==null)${fail};}`;
}

/** Schema-specialized validation and canonical cloning share one generated walk. */
function prepareSource(root: PulseLayout, cyclic: ReadonlySet<number>): string {
	let serial = 0;
	const fresh = (prefix: string) => `${prefix}${serial++}`;
	const emit = (
		layout: PulseLayout,
		input: string,
		initialDepth: string,
		active: ReadonlyMap<number, number>,
		offset: number,
		mode: "yes" | "no" | "conditional",
		fieldOverrides?: ReadonlyMap<string, string>,
	): { code: string; value: string } => {
		const result = fresh("out");
		const recursive = active.get(layout.id);
		if (recursive !== undefined)
			return {
				code:
					recursive === offset
						? `throw new TypeError("Recursive schema cannot represent this value");let ${result};`
						: `const ${result}=prepares[${layout.id}](${input},ctx,${initialDepth},${mode === "no"});`,
				value: result,
			};
		const value = fresh("value"),
			depth = fresh("depth");
		const fail = `throw new TypeError(${JSON.stringify(`Value does not match pulse schema layout ${layout.id} (${layout.kind})`)})`;
		let code = `let ${value}=${input};let ${depth}=${initialDepth};if(${depth}>32)throw new TypeError("Pulse values may nest at most 32 levels");`;
		const markerCode = `if(${value}!==null&&typeof ${value}==="object"){if(${value}[TreeSymbol])${value}=${value}.snapshot();if(${value}[RichTextSymbol]){const wrappers=new Set();while(${value}!==null&&typeof ${value}==="object"&&${value}[RichTextSymbol]){if(wrappers.has(${value}))throw new TypeError("Pulse values cannot contain cycles");wrappers.add(${value});recordMarker(ctx,true);${value}=${value}.text;if(++${depth}>32)throw new TypeError("Pulse values may nest at most 32 levels");}}}`;
		if (mode === "yes") code += markerCode;
		else if (mode === "conditional") code += `if(!skipMarkers){${markerCode}}`;
		const next = new Map(active);
		next.set(layout.id, offset);
		const child = (
			target: PulseLayout,
			expression: string,
			key?: string,
			transparent = false,
			overrides?: ReadonlyMap<string, string>,
		) => {
			const fragment = emit(
				target,
				expression,
				transparent ? depth : `${depth}+1`,
				next,
				transparent ? offset : offset + 1,
				transparent ? "no" : "yes",
				overrides,
			);
			return {
				code:
					key === undefined
						? fragment.code
						: `ctx.path.push(${key});${fragment.code}ctx.path.pop();`,
				value: fragment.value,
			};
		};
		let body = "";
		switch (layout.kind) {
			case "object": {
				const keys = fresh("keys"),
					key = fresh("key");
				body =
					plainRecordCheck(value, fail) +
					`const ${keys}=Object.keys(${value});ctx.keyOrders[ctx.path.length]=${keys};for(const ${key} of ${keys}){${layout.fields.length ? `switch(${key}){${layout.fields.map((field) => `case ${JSON.stringify(field.key)}:`).join("")}break;default:` : ""}assertKey(${key});ctx.path.push(${key});prepareExtra(${value}[${key}],ctx,${depth}+1);ctx.path.pop();${layout.fields.length ? "}" : ""}}`;
				const fields: string[] = [];
				for (const field of layout.fields) {
					const fragment = child(
						field.layout,
						fieldOverrides?.get(field.key) ??
							`(Object.prototype.propertyIsEnumerable.call(${value},${JSON.stringify(field.key)})?${value}[${JSON.stringify(field.key)}]:undefined)`,
						JSON.stringify(field.key),
					);
					body += fragment.code;
					fields.push(`[${JSON.stringify(field.key)}]:${fragment.value}`);
				}
				body += `${result}={${fields.join(",")}};`;
				break;
			}
			case "array":
			case "tuple": {
				body = `if(!Array.isArray(${value})${layout.kind === "tuple" ? `||${value}.length!==${layout.elements!.length}` : ""})${fail};ctx.keyOrders[ctx.path.length]=undefined;`;
				if (layout.kind === "array") {
					const index = fresh("index");
					const fragment = child(layout.element!, `${value}[${index}]`, index);
					body += `${result}=new Array(${value}.length);for(let ${index}=0;${index}<${value}.length;${index}++){if(!(${index} in ${value}))throw new TypeError("Pulse arrays cannot contain holes");${fragment.code}${result}[${index}]=${fragment.value};}`;
				} else {
					const elements: string[] = [];
					for (const [index, target] of layout.elements!.entries()) {
						const fragment = child(target, `${value}[${index}]`, String(index));
						body += `if(!(${index} in ${value}))throw new TypeError("Pulse arrays cannot contain holes");${fragment.code}`;
						elements.push(fragment.value);
					}
					body += `${result}=[${elements.join(",")}];`;
				}
				break;
			}
			case "map": {
				const keys = fresh("keys"),
					key = fresh("key");
				const fragment = child(layout.element!, `${value}[${key}]`, key);
				body =
					plainRecordCheck(value, fail) +
					`const ${keys}=Object.keys(${value});ctx.keyOrders[ctx.path.length]=${keys};${result}={};for(const ${key} of ${keys}){assertKey(${key});${fragment.code}${result}[${key}]=${fragment.value};}`;
				break;
			}
			case "optional": {
				const fragment = child(layout.value!, value, undefined, true);
				body = `if(${value}===undefined)${result}=undefined;else{${fragment.code}${result}=${fragment.value};}`;
				break;
			}
			case "union": {
				const tag = fresh("tag");
				body =
					plainRecordCheck(value, fail) +
					`const ${tag}=Object.prototype.propertyIsEnumerable.call(${value},${JSON.stringify(layout.tagName)})?${value}[${JSON.stringify(layout.tagName)}]:undefined;switch(String(${tag})){`;
				for (const [name, variant] of layout.variants!) {
					const fragment = child(
						variant,
						value,
						undefined,
						true,
						new Map([[layout.tagName!, tag]]),
					);
					body += `case ${JSON.stringify(name)}:{${fragment.code}${result}=${fragment.value};break;}`;
				}
				body += `default:${fail};}`;
				break;
			}
			case "string":
				// A sub field accepts a pulse or sub-pulse handle and stores its ID.
				body = `${layout.sub ? `if(${value}!==null&&typeof ${value}==="object"&&(${value}[SubPulseSymbol]===true||${value}[PulseMetaSymbol]!==undefined))${value}=${value}.id;` : ""}if(typeof ${value}!=="string"||!${value}.isWellFormed())${fail};${result}=${value};`;
				break;
			case "boolean":
				body = `if(typeof ${value}!=="boolean")${fail};${result}=${value};`;
				break;
			case "null":
				body = `if(${value}!==null)${fail};${result}=null;`;
				break;
			case "undefined":
				body = `if(${value}!==undefined)${fail};${result}=undefined;`;
				break;
			case "int":
			case "int32":
			case "int64":
				body = `if(!Number.isSafeInteger(${value}))${fail};${result}=${value}===0?0:${value};`;
				break;
			case "uint":
			case "uint32":
			case "uint64":
				body = `if(!Number.isSafeInteger(${value})||${value}<0)${fail};${result}=${value}===0?0:${value};`;
				break;
			case "float32":
				body = `if(typeof ${value}!=="number"||!Number.isFinite(Math.fround(${value})))${fail};${result}=${value}===0?0:Math.fround(${value});`;
				break;
			case "float64":
				body = `if(typeof ${value}!=="number"||!Number.isFinite(${value}))${fail};${result}=${value}===0?0:${value};`;
				break;
			case "uint8Array":
				body = `if(!(${value} instanceof Uint8Array))${fail};${result}=new Uint8Array(${value});`;
				break;
			default:
				body = `${result}=prepareFallback(layouts[${layout.id}],${value},ctx,${depth});`;
		}
		code += `let ${result};`;
		if (
			cyclic.has(layout.id) &&
			["object", "array", "map", "tuple"].includes(layout.kind)
		) {
			const ancestors = fresh("ancestors");
			code += `const ${ancestors}=ctx.ancestors??(ctx.ancestors=new Set());if(${ancestors}.has(${value}))throw new TypeError("Pulse values cannot contain cycles");${ancestors}.add(${value});try{${body}}finally{${ancestors}.delete(${value});}`;
		} else code += body;
		if (layout.treeRole)
			code += `if(${result}!==undefined)assertTreeStructure(${result},${JSON.stringify(layout.treeRole)});`;
		return { code, value: result };
	};
	const fragment = emit(
		root,
		"value",
		"initialDepth",
		new Map(),
		0,
		"conditional",
	);
	return `${fragment.code}return ${fragment.value};`;
}

function shallowSource(layout: PulseLayout): string {
	const fail = `throw new TypeError(${JSON.stringify(`Value does not match pulse schema layout ${layout.id} (${layout.kind})`)})`;
	switch (layout.kind) {
		case "object":
		case "map":
			return `${plainRecordCheck("value", fail)}return value;`;
		case "array":
			return `if(!Array.isArray(value))${fail};return value;`;
		case "tuple":
			return `if(!Array.isArray(value)||value.length!==${layout.elements!.length})${fail};return value;`;
		case "optional": {
			const seen = new Set<number>();
			let current: PulseLayout | undefined = layout;
			while (current?.kind === "optional" && !seen.has(current.id)) {
				seen.add(current.id);
				current = current.value;
			}
			return `if(value===undefined)return value;${current && !seen.has(current.id) ? `return layouts[${current.id}].assertShallow(value);` : `${fail};`}`;
		}
		case "union": {
			const descriptor = resolveSchema(layout.schema);
			const tagType =
				typeof descriptor === "object" && descriptor._type === "union"
					? descriptor.type
					: "string";
			const check =
				tagType === "string"
					? 'typeof tag!=="string"||!tag.isWellFormed()'
					: `!Number.isSafeInteger(tag)${tagType.startsWith("u") ? "||tag<0" : ""}`;
			return `${plainRecordCheck("value", fail)}const tag=value[${JSON.stringify(layout.tagName)}];if(${check}||!layouts[${layout.id}].variants.has(String(tag)))${fail};return value;`;
		}
		case "string":
			return `if(typeof value!=="string"||!value.isWellFormed())${fail};return value;`;
		case "boolean":
			return `if(typeof value!=="boolean")${fail};return value;`;
		case "null":
			return `if(value!==null)${fail};return value;`;
		case "undefined":
			return `if(value!==undefined)${fail};return value;`;
		case "int":
		case "int32":
		case "int64":
			return `if(!Number.isSafeInteger(value))${fail};return value;`;
		case "uint":
		case "uint32":
		case "uint64":
			return `if(!Number.isSafeInteger(value)||value<0)${fail};return value;`;
		case "float32":
			return `if(typeof value!=="number"||!Number.isFinite(Math.fround(value)))${fail};return value;`;
		case "float64":
			return `if(typeof value!=="number"||!Number.isFinite(value))${fail};return value;`;
		case "uint8Array":
			return `if(!(value instanceof Uint8Array))${fail};return value;`;
		case "date":
		case "set":
			return `${fail};`;
		case "unknown":
		case "schema":
			return `if(value===null||value===undefined||typeof value==="boolean"||typeof value==="bigint")return value;if(typeof value==="number"){if(!Number.isFinite(value))${fail};return value;}if(typeof value==="string"){if(!value.isWellFormed())${fail};return value;}if(Array.isArray(value)||value instanceof Uint8Array)return value;${plainRecordCheck("value", fail)}return value;`;
		default:
			return `return layouts[${layout.id}].assert(value);`;
	}
}

const fingerprints = new WeakMap<object, string>();
const literalFingerprintCodec = createCodec("unknown");
const fingerprintCodec = createCodec(
	object({
		version: "uint",
		root: "uint",
		constants: array(array("string")),
		texts: array(array("string")),
		layouts: array(
			object({
				kind: "string",
				constant: "boolean",
				richText: "boolean",
				keys: array("string"),
				fields: array("uint"),
				flags: array("uint"),
				element: "int",
				elements: array("uint"),
				tags: array("string"),
				variants: array("uint"),
				tagName: "string",
				tagType: "string",
				value: "int",
				literal: "uint8Array",
				maxBytes: "uint",
			}),
		),
	}),
);

/**
 * A cached, compact compatibility key for the compiled layout graph. Lazy
 * functions are represented by their resolved layout edges, including cycles;
 * function source text and process-local object identity never enter the key.
 */
export function schemaFingerprint<S extends Schema>(
	compiled: CompiledPulseSchema<S>,
): string {
	const existing = fingerprints.get(compiled);
	if (existing !== undefined) return existing;
	const paths = (input: readonly PulseSchemaPath[] | undefined) => {
		const unique = new Map<string, string[]>();
		for (const path of input ?? []) {
			const normalized = path.map(String);
			unique.set(JSON.stringify(normalized), normalized);
		}
		return [...unique]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map((entry) => entry[1]);
	};
	const bytes = fingerprintCodec.encode({
		version: 2,
		root: compiled.root.id,
		constants: paths([
			...(compiled.options.constantPaths ?? []),
			...(compiled.inferredConstantPaths ?? []),
		]),
		texts: paths([
			...(compiled.options.richTextPaths ?? []),
			...(compiled.inferredRichTextPaths ?? []),
		]),
		layouts: compiled.layouts.map((layout) => {
			const descriptor = resolveSchema(layout.schema);
			return {
				kind: layout.treeRole
					? `tree:${layout.treeRole}`
					: layout.frozen
						? `frozen:${layout.kind}`
						: layout.kind,
				constant: layout.constant,
				richText: layout.richText,
				keys: layout.fields.map((field) => field.key),
				fields: layout.fields.map((field) => field.layout.id),
				flags: layout.fields.map(
					(field) => (field.constant ? 1 : 0) | (field.richText ? 2 : 0),
				),
				element: layout.element?.id ?? -1,
				elements: layout.elements?.map((child) => child.id) ?? [],
				tags: layout.variants ? [...layout.variants.keys()] : [],
				variants: layout.variants
					? [...layout.variants.values()].map((child) => child.id)
					: [],
				tagName: layout.tagName ?? "",
				tagType:
					typeof descriptor === "object" && descriptor._type === "union"
						? descriptor.type
						: "",
				value: layout.value?.id ?? -1,
				literal:
					typeof descriptor === "object" && descriptor._type === "literal"
						? literalFingerprintCodec.encode(descriptor.value)
						: new Uint8Array(0),
				maxBytes:
					typeof descriptor === "object" && descriptor._type === "bigint"
						? descriptor.maxBytes
						: 0,
			};
		}),
	});
	// Four independent 32-bit streams keep the wire key fixed at 32 ASCII bytes.
	// This detects schema mismatches; it is not an authentication mechanism.
	const fingerprint = fingerprintBytes(bytes);
	fingerprints.set(compiled, fingerprint);
	return fingerprint;
}
