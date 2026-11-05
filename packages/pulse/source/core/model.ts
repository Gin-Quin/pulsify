import { createCodec, object, type Codec } from "@gin-quin/codec";
import { RT_NODE, richTextContent, trackRichTextAnchor } from "./richTextBinding.js";
import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import { MigrationDriftError, PulseError } from "../protocol/errors.js";
import {
	migrationVersion,
	type MigrationChain,
} from "../migration/MigrationChain.js";
import {
	compilePulseSchema,
	schemaFingerprint,
	type CompiledPulseSchema,
	type PulseLayout,
} from "./schema.js";
import {
	CorePatch,
	type CoreField,
	type CoreOperation,
	type CoreScalar,
	type ValueEncoding,
} from "./operations.js";
import {
	assertKey,
	freezeConstant,
	prepareValue,
	validatePrepared,
	type PreparedValue,
} from "./values.js";

export type Stamp = readonly [lamport: number, sid: number, clock: number];
export type CoreEntry = {
	id: string;
	after: string;
	stamp: Stamp;
	write: Stamp;
	value: unknown;
	child: CoreNode | undefined;
	deleted: boolean;
	children: CoreEntry[];
	marks: Map<string, { stamp: Stamp; value: unknown }>;
};
const emptyNodeMap = new Map<string, CoreNode>();
const emptyStampMap = new Map<string, Stamp>();
const emptyEntryMap = new Map<string, CoreEntry>();
const emptyEntryArray: CoreEntry[] = [];
const emptyMarks = new Map<string, { stamp: Stamp; value: unknown }>();
const emptyPathSet: ReadonlySet<string> = new Set();
export class CoreNode {
	private childMap: Map<string, CoreNode> | undefined;
	readonly stamps: Map<string, Stamp>;
	readonly entries: Map<string, CoreEntry>;
	readonly heads: CoreEntry[];
	readonly order: CoreEntry[];
	readonly visible: CoreEntry[];
	parent: CoreNode | undefined;
	parentKey: string | undefined;
	proxy: unknown;
	constructor(
		public readonly id: string,
		public readonly kind: "object" | "array" | "text",
		public readonly data: any,
		public layout: PulseLayout | undefined,
		public readonly initialStamp: Stamp,
	) {
		this.wireLayout = layout;
		const object = kind === "object";
		this.stamps = object ? new Map() : emptyStampMap;
		this.entries = object ? emptyEntryMap : new Map();
		this.heads = object ? emptyEntryArray : [];
		this.order = object ? emptyEntryArray : [];
		this.visible = object ? emptyEntryArray : [];
	}
	get children(): ReadonlyMap<string, CoreNode> {
		return this.childMap ?? emptyNodeMap;
	}
	child(key: string): CoreNode | undefined {
		return this.childMap?.get(key);
	}
	setChild(key: string, node: CoreNode): void {
		(this.childMap ??= new Map()).set(key, node);
	}
	removeChild(key: string): void {
		this.childMap?.delete(key);
	}
	readonly wireLayout: PulseLayout | undefined;
}
export const managedFields = new Set(["id", "kind", "version", "generation"]);
const newer = (a: Stamp, b?: Stamp): boolean =>
	!b ||
	a[0] > b[0] ||
	(a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
const keyPath = (path: readonly string[]) => JSON.stringify(path);

/** ID-addressed LWW object registers and an RGA sequence. Scalars live inline. */
export class CoreModel {
	readonly index = new Map<string, CoreNode>();
	root: CoreNode | undefined;
	lamport = 0;
	nextClock = 1;
	readonly schemaId: string;
	readonly encoding: ValueEncoding;
	private readonly rootCodec: Codec<unknown> | undefined;
	commit!: (ops: CoreOperation[], hint?: number) => void;
	commitScalar!: (
		node: CoreNode,
		key: string,
		field: CoreField,
		value: CoreScalar,
	) => void;
	constructor(
		public readonly sid: number,
		public readonly docId: string,
		public readonly kind: string,
		public readonly maxVersion: number,
		public readonly compiled?: CompiledPulseSchema,
		public readonly schemas: readonly (CompiledPulseSchema | undefined)[] = [],
		public readonly migrationChain?: MigrationChain,
	) {
		let cached = compiled ? schemaCache.get(compiled) : undefined;
		if (!cached && compiled) {
			const schema = compiled.codecSchema ?? compiled.schema;
			cached = { id: schemaFingerprint(compiled) };
			if (typeof schema === "object" && schema._type === "object")
				cached.codec = createCodec(
					object({
						...schema.fields,
						id: "string",
						kind: "string",
						version: "uint",
						generation: "uint",
					}),
				) as Codec<unknown>;
			schemaCache.set(compiled, cached);
		}
		this.schemaId =
			migrationChain?.schemaIds[maxVersion - 1] ?? cached?.id ?? "";
		this.rootCodec = cached?.codec;
		this.encoding = {
			encode: (value, op) => {
				if (op.kind === 0)
					return this.rootCodec
						? { layout: 1, data: this.rootCodec.encode(value.value) }
						: { layout: 0, data: unknownCodec.encode(value.value) };
				if (this.maxVersion > 1)
					return { layout: 0, data: unknownCodec.encode(value.value) };
				const layout = this.valueLayout(op, value.value);
				return layout && compiled
					? {
							layout: layout.id + 2,
							data: compiled.encode(layout.id, value.value),
						}
					: { layout: 0, data: unknownCodec.encode(value.value) };
			},
			decode: (layout, data) => {
				if (!layout) return decodeWhole(unknownCodec, data);
				if (layout === 1 && this.rootCodec)
					return ownDecoded(compiled?.root, decodeWhole(this.rootCodec, data));
				if (!compiled)
					throw new PulseError(
						"INCOMPATIBLE_DOCUMENT",
						"Patch requires a schema",
					);
				return ownDecoded(
					compiled.layouts[layout - 2],
					compiled.decode(layout - 2, data),
				);
			},
		};
	}
	schemaFor(id: string): CompiledPulseSchema | undefined {
		if (id === this.schemaId) return this.compiled;
		if (this.migrationChain) {
			const known = this.migrationChain.versions.get(id);
			if (known !== undefined) return this.schemaAtVersion(known);
			const version = migrationVersion(id);
			if (version !== undefined && version > this.maxVersion)
				throw new PulseError(
					"INCOMPATIBLE_DOCUMENT",
					"Document requires a newer migration version",
				);
			if (version !== undefined || this.maxVersion > 1)
				throw this.migrationDrift(
					id,
					version,
					"Migration chain does not match the published history",
				);
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"Patch schema does not match the pulse definition",
			);
		}
		for (const schema of this.schemas)
			if ((schema ? schemaFingerprint(schema) : "") === id) return schema;
		throw new PulseError(
			"INCOMPATIBLE_DOCUMENT",
			"Patch schema does not match a supported migration version",
		);
	}
	private migrationDrift(
		received: string,
		version: number | undefined,
		reason: string,
		incomingSnapshot?: unknown,
	): MigrationDriftError {
		return new MigrationDriftError(
			{
				docId: this.docId,
				kind: this.kind,
				version,
				expected:
					version === undefined
						? undefined
						: this.migrationChain?.schemaIds[version - 1],
				received,
				reason,
			},
			incomingSnapshot,
		);
	}
	private schemaAtVersion(version: number): CompiledPulseSchema | undefined {
		return version === this.maxVersion &&
			!Object.hasOwn(this.schemas, version - 1)
			? this.compiled
			: this.schemas[version - 1];
	}
	decodeEncoding(id: string): ValueEncoding {
		const compiled = this.schemaFor(id);
		if (compiled === this.compiled) return this.encoding;
		return {
			encode: this.encoding.encode,
			decode: (layout, bytes) => {
				if (!layout) return decodeWhole(unknownCodec, bytes);
				if (!compiled)
					throw new PulseError(
						"INCOMPATIBLE_DOCUMENT",
						"Patch requires a schema",
					);
				if (layout === 1) {
					let cache = schemaCache.get(compiled);
					if (!cache) {
						const schema = compiled.codecSchema ?? compiled.schema;
						cache = { id: schemaFingerprint(compiled) };
						if (typeof schema === "object" && schema._type === "object")
							cache.codec = createCodec(
								object({
									...schema.fields,
									id: "string",
									kind: "string",
									version: "uint",
									generation: "uint",
								}),
							) as Codec<unknown>;
						schemaCache.set(compiled, cache);
					}
					if (!cache.codec)
						throw new PulseError(
							"INCOMPATIBLE_DOCUMENT",
							"Invalid document schema",
						);
					return ownDecoded(compiled.root, decodeWhole(cache.codec, bytes));
				}
				return ownDecoded(
					compiled.layouts[layout - 2],
					compiled.decode(layout - 2, bytes),
				);
			},
		};
	}
	view(): any {
		return this.root?.data;
	}
	get clock() {
		return { sid: this.sid, time: this.nextClock };
	}
	isAttached(node: CoreNode): boolean {
		let current = node;
		while (current.parent) {
			const parent = current.parent;
			const key = current.parentKey!;
			if (parent.kind === "object") {
				if (parent.children.get(key) !== current) return false;
			} else {
				const entry = parent.entries.get(key);
				if (!entry || entry.deleted || entry.child !== current) return false;
			}
			current = parent;
		}
		return current === this.root;
	}
	field(node: CoreNode, key: string): CoreField {
		return this.maxVersion > 1
			? key
			: (node.layout?.fieldsByKey.get(key)?.id ?? key);
	}
	fieldKey(node: CoreNode, field: CoreField): string {
		const key =
			typeof field === "number" ? node.wireLayout?.fields[field]?.key : field;
		if (key === undefined)
			throw new PulseError("INVALID_MESSAGE", "Unknown schema field");
		if (typeof field === "string") assertKey(key);
		return key;
	}
	set(node: CoreNode, key: string, input: unknown): void {
		const field = this.writableField(node, key);
		const layout =
			field?.layout ??
			(node.layout?.kind === "map" ? node.layout.element : undefined);
		if (
			this.maxVersion === 1 &&
			!field?.richText &&
			!layout?.richText &&
			!layout?.constant &&
			(input === null ||
				input === undefined ||
				typeof input === "boolean" ||
				typeof input === "number" ||
				typeof input === "string")
		) {
			if (typeof input === "number" && !Number.isFinite(input))
				throw new TypeError("Numbers must be finite");
			if (typeof input === "string" && !input.isWellFormed())
				throw new TypeError("Strings must be valid Unicode");
			const scalar = typeof input === "number" && input === 0 ? 0 : input;
			layout?.assert(scalar);
			this.commitScalar(
				node,
				key,
				field?.id ?? key,
				layout ? (layout.clone(scalar) as CoreScalar) : scalar,
			);
			return;
		}
		const value = layout ? layout.prepare(input) : prepareValue(input);
		this.commit([
			{
				kind: 1,
				target: node.id,
				field: this.maxVersion > 1 ? key : (field?.id ?? key),
				value: this.fieldPrepared(value, field ?? layout),
			},
		]);
	}
	delete(node: CoreNode, key: string): void {
		this.assertWritable(node, key);
		if (Object.hasOwn(node.data, key)) {
			if (node.layout?.kind !== "map")
				this.validateValue(this.layoutField(node, key), undefined);
			this.commit([{ kind: 2, target: node.id, field: this.field(node, key) }]);
		}
	}
	splice(
		node: CoreNode,
		start: number,
		count: number,
		input: readonly unknown[],
	): unknown[] {
		if (node.kind !== "array") throw new TypeError("Expected a pulse array");
		if (!this.isAttached(node))
			throw new TypeError("This pulse array has been replaced or removed");
		const tuple = node.layout?.kind === "tuple";
		if (tuple && count !== input.length)
			throw new TypeError("Tuple cardinality is fixed");
		const values = input.map((value, i) => {
			const layout = tuple
				? node.layout?.elements?.[start + i]
				: node.layout?.element;
			return layout ? layout.prepare(value) : prepareValue(value);
		});
		const removed = count
			? node.visible
					.slice(start, start + count)
					.map((entry) => structuredClone(entry.value))
			: [];
		if (tuple && values.length) {
			this.commit(
				values.map((value, i) => ({
					kind: 4,
					target: node.id,
					entry: node.visible[start + i]!.id,
					value,
				})),
			);
		} else if (count === 1 && values.length === 1) {
			this.commit([
				{
					kind: 4,
					target: node.id,
					entry: node.visible[start]!.id,
					value: values[0]!,
				},
			]);
		} else if (count || values.length) {
			this.commit(
				[
					{
						kind: 3,
						target: node.id,
						after: start ? node.visible[start - 1]!.id : "",
						deletes: node.visible
							.slice(start, start + count)
							.map((entry) => entry.id),
						values,
					},
				],
				start,
			);
		}
		return removed;
	}
	assertWritable(node: CoreNode, key: string): void {
		this.writableField(node, key);
	}
	private writableField(node: CoreNode, key: string) {
		if (node.kind !== "object") throw new TypeError("Expected a pulse object");
		const field = node.layout?.fieldsByKey.get(key);
		if (!field) assertKey(key);
		if (!this.isAttached(node))
			throw new TypeError("This pulse object has been replaced or removed");
		if (node === this.root && managedFields.has(key))
			throw new TypeError(`${key} is managed by Pulsify`);
		if (
			field?.constant ||
			node.layout?.constant ||
			(node.layout?.kind === "map" && node.layout.element?.constant)
		)
			throw new TypeError(`${key} is constant`);
		if (node.layout?.kind === "object" && !field)
			throw new TypeError(`Unknown schema property ${key}`);
		return field;
	}
	private fieldPrepared(
		value: PreparedValue,
		field: { constant: boolean; richText: boolean } | undefined,
	): PreparedValue {
		if (!field?.constant && !field?.richText) return value;
		return {
			...value,
			constants: field.constant ? [...value.constants, []] : value.constants,
			texts: field.richText ? [...value.texts, []] : value.texts,
		};
	}
	private layoutField(node: CoreNode, key: string): PulseLayout | undefined {
		if (node === this.root && managedFields.has(key)) return undefined;
		return (
			node.layout?.fieldsByKey.get(key)?.layout ??
			(node.layout?.kind === "map" ? node.layout.element : undefined)
		);
	}
	private valueLayout(
		op: CoreOperation,
		value: unknown,
	): PulseLayout | undefined {
		if (op.kind === 0) return this.compiled?.root;
		const target = this.index.get(op.target);
		if (!target) return;
		if (op.kind === 1)
			return this.layoutField(target, this.fieldKey(target, op.field));
		if (op.kind === 3 || op.kind === 4) return target.layout?.element;
		void value;
		return undefined;
	}
	private validateValue(layout: PulseLayout | undefined, value: unknown): void {
		layout?.assert(value);
	}
	normalize(
		prepared: PreparedValue,
		layout: PulseLayout | undefined,
	): PreparedValue {
		if (!layout) return prepared;
		const next = layout.prepare(prepared.value);
		const result = {
			value: next.value,
			constants: mergePreparedPaths(prepared.constants, next.constants),
			texts: mergePreparedPaths(prepared.texts, next.texts),
		};
		if (result.constants.length || result.texts.length)
			validatePrepared(result);
		return result;
	}
	prepareRoot(
		prepared: PreparedValue,
		compiled = this.compiled,
	): PreparedValue {
		if (!compiled) return prepared;
		const data = prepared.value as Record<string, unknown>;
		const application =
			compiled.root.kind === "literal" || compiled.root.kind === "map"
				? withoutMetadata(data)
				: data;
		const normalized = this.normalize(
			{ ...prepared, value: application },
			compiled.root,
		);
		return {
			...normalized,
			value: {
				...(normalized.value as object),
				id: data["id"],
				kind: data["kind"],
				version: data["version"],
				generation: data["generation"],
			},
		};
	}
	prepareRootInput(data: Record<string, unknown>): PreparedValue {
		if (!this.compiled) return prepareValue(data);
		const application =
			this.compiled.root.kind === "literal" || this.compiled.root.kind === "map"
				? withoutMetadata(data)
				: data;
		const prepared = this.compiled.prepare(application);
		return {
			...prepared,
			value: {
				...(prepared.value as object),
				id: data["id"],
				kind: data["kind"],
				version: data["version"],
				generation: data["generation"],
			},
		};
	}
	/** Preflight all remote changes before the journal advances. No document clone. */
	validate(
		patches: readonly CorePatch[],
		dependencies: ReadonlyMap<CorePatch, PulseVersionVector>,
	): void {
		if (
			this.maxVersion === 1 &&
			this.validateScalarWrites(patches, dependencies)
		)
			return;
		const known = new Map<string, CoreNode>();
		const sequences = new Map<string, Set<string>>();
		const versions = new Map<string, { value: number; stamp: Stamp }>();
		let root = this.root;
		let rootStamp = this.rootStamp;
		for (const patch of patches) {
			const patchSchema = this.schemaFor(patch.schema);
			const deps = new Map(dependencies.get(patch));
			const stamp: Stamp = [patch.lamport, patch.sid, patch.clock];
			for (const [actor, clock] of deps) {
				void actor;
				if (clock < 1)
					throw new PulseError("INVALID_MESSAGE", "Invalid dependency");
			}
			let serial = 0;
			const builds: BuiltValue[] = [];
			const build = (
				value: PreparedValue,
				layout: PulseLayout | undefined,
				documentRoot = false,
			) => {
				const nodes = new Map<string, CoreNode>();
				const built = this.build(
					value,
					id,
					stamp,
					layout,
					nodes,
					true,
					documentRoot,
					true,
				);
				for (const [key, node] of nodes) known.set(key, node);
				builds.push({ ...built, nodes, serialEnd: serial });
				return built;
			};
			const id = () => `${patch.sid}:${patch.clock}:${serial++}`;
			const reference = (ref: string) => {
				const parts = ref.split(":");
				const sid = Number(parts[0]),
					clock = Number(parts[1]);
				if (
					parts.length !== 3 ||
					!Number.isSafeInteger(sid) ||
					!Number.isSafeInteger(clock) ||
					!Number.isSafeInteger(Number(parts[2])) ||
					Number(parts[2]) < 0 ||
					clock < 1 ||
					sid < 65536 ||
					!(
						(sid === patch.sid && clock === patch.clock) ||
						(deps.get(sid) ?? 0) > clock
					)
				)
					throw new PulseError(
						"INVALID_MESSAGE",
						"Operation reference is not causally covered",
					);
			};
			for (const op of patch.ops) {
				if (op.kind === 0) {
					this.validateRoot(op.value.value, patch.schema);
					for (const paths of [op.value.constants, op.value.texts])
						for (const path of paths)
							if (path.length && managedFields.has(path[0]!))
								throw new PulseError(
									"INCOMPATIBLE_DOCUMENT",
									"Document metadata cannot carry value markers",
								);
					const created = build(op.value, patchSchema?.root, true);
					if (!created.child || created.child.kind !== "object")
						throw new PulseError(
							"INCOMPATIBLE_DOCUMENT",
							"Document root must be an object",
						);
					if (newer(stamp, rootStamp)) {
						root = created.child;
						rootStamp = stamp;
						versions.set(root.id, {
							value: root.data.version as number,
							stamp,
						});
					}
					continue;
				}
				reference(op.target);
				const target = known.get(op.target) ?? this.index.get(op.target);
				if (!target)
					throw new PulseError("INVALID_MESSAGE", "Unknown operation target");
				if (op.kind === 1 || op.kind === 2) {
					if (target.kind !== "object")
						throw new PulseError("INVALID_MESSAGE", "Expected object target");
					const key = this.fieldKey(target, op.field);
					if (target === root && managedFields.has(key)) {
						if (
							key !== "version" ||
							op.kind !== 1 ||
							!Number.isSafeInteger(op.value.value) ||
							(op.value.value as number) < 1 ||
							(op.value.value as number) > this.maxVersion
						)
							throw new PulseError(
								"INCOMPATIBLE_DOCUMENT",
								"Document metadata is managed by Pulsify",
							);
						if (
							op.kind === 1 &&
							this.migrationChain &&
							patch.schema !==
								this.migrationChain.schemaIds[(op.value.value as number) - 1]
						)
							throw this.migrationDrift(
								patch.schema,
								op.value.value as number,
								"Migration patch identity does not match its target version",
							);
					}
					if (
						!managedFields.has(key) &&
						(target.layout?.constant ||
							target.layout?.fieldsByKey.get(key)?.constant ||
							(target.layout?.kind === "map" &&
								target.layout.element?.constant))
					) {
						const version = patch.ops.find(
							(change) =>
								change.kind === 1 &&
								change.target === root?.id &&
								this.fieldKey(root!, change.field) === "version",
						);
						const next =
							version?.kind === 1 ? (version.value.value as number) : 0;
						const prior = versions.get(target.id) ?? {
							value: target.data.version as number,
							stamp: target.stamps.get("version") ?? target.initialStamp,
						};
						const oldSchema = this.schemas[next - 2];
						const wasConstant =
							oldSchema?.fieldAt([key], target.data)?.constant ??
							oldSchema?.layoutAt([key], target.data)?.constant ??
							false;
						const nowConstant =
							patchSchema?.fieldAt([key], target.data)?.constant ??
							patchSchema?.layoutAt([key], target.data)?.constant ??
							false;
						const concurrent =
							next > prior.value ||
							(deps.get(prior.stamp[1]) ?? 0) <= prior.stamp[2];
						const captured =
							target === root &&
							op.kind === 1 &&
							op.value.constants.some((path) => path.length === 0) &&
							Number.isSafeInteger(next) &&
							next >= 2 &&
							next <= this.maxVersion &&
							!wasConstant &&
							nowConstant &&
							concurrent;
						if (!captured)
							throw new PulseError(
								"INCOMPATIBLE_DOCUMENT",
								"Cannot mutate a constant field",
							);
					}
					const operationLayout =
						target === root
							? resolveLayout(patchSchema?.root, target.data)
							: target.layout;
					if (
						operationLayout?.kind === "object" &&
						!operationLayout.fieldsByKey.has(key) &&
						!(target === root && managedFields.has(key))
					)
						throw new PulseError("INVALID_MESSAGE", "Unknown schema property");
					const metadata = target === root && managedFields.has(key);
					const fieldLayout = metadata
						? undefined
						: (operationLayout?.fieldsByKey.get(key)?.layout ??
							(operationLayout?.kind === "map"
								? operationLayout.element
								: undefined));
					if (op.kind === 2 && operationLayout?.kind !== "map")
						this.validateValue(fieldLayout, undefined);
					if (op.kind === 1)
						build(
							metadata
								? op.value
								: this.fieldPrepared(
										op.value,
										operationLayout?.fieldsByKey.get(key) ?? fieldLayout,
									),
							fieldLayout,
						);
				} else {
					if (target.kind === "object")
						throw new PulseError("INVALID_MESSAGE", "Expected sequence target");
					let sequence = sequences.get(target.id);
					if (!sequence) {
						sequence = new Set(target.entries.keys());
						sequences.set(target.id, sequence);
					}
					const entries =
						op.kind === 3
							? [...(op.after ? [op.after] : []), ...op.deletes]
							: op.kind === 4
								? [op.entry]
								: op.entries;
					for (const entry of entries) {
						reference(entry);
						if (!sequence.has(entry))
							throw new PulseError("INVALID_MESSAGE", "Unknown sequence entry");
					}
					if (op.kind === 3 && target.layout?.kind === "tuple")
						throw new PulseError(
							"INVALID_MESSAGE",
							"Tuple cardinality is fixed",
						);
					if (op.kind === 3)
						for (const value of op.values) {
							if (
								target.kind === "text" &&
								(typeof value.value !== "string" ||
									Array.from(value.value).length !== 1)
							)
								throw new PulseError(
									"INVALID_MESSAGE",
									"Text entries must be single Unicode characters",
								);
							sequence.add(id());
							build(
								value,
								target.kind === "text" ? undefined : target.layout?.element,
							);
						}
					if (op.kind === 4) {
						if (target.kind === "text")
							throw new PulseError(
								"INVALID_MESSAGE",
								"Use text insert and delete",
							);
						const layout =
							target.layout?.kind === "tuple"
								? target.layout.elements?.[
										target.order.findIndex((entry) => entry.id === op.entry)
									]
								: target.layout?.element;
						build(op.value, layout);
					}
					if (op.kind === 5) {
						if (target.kind !== "text")
							throw new PulseError(
								"INVALID_MESSAGE",
								"Formatting requires rich text",
							);
						if (
							!op.attributes ||
							typeof op.attributes !== "object" ||
							Array.isArray(op.attributes)
						)
							throw new PulseError(
								"INVALID_MESSAGE",
								"Invalid text attributes",
							);
						prepareValue(op.attributes);
					}
				}
			}
			if (root)
				for (const op of patch.ops) {
					if (
						op.kind !== 1 ||
						op.target !== root.id ||
						this.fieldKey(root, op.field) !== "version"
					)
						continue;
					const previous = versions.get(root.id) ?? {
						value: root.data.version as number,
						stamp: root.stamps.get("version") ?? root.initialStamp,
					};
					const value = op.value.value as number;
					if (
						value > previous.value ||
						(value === previous.value && newer(stamp, previous.stamp))
					)
						versions.set(root.id, { value, stamp });
				}
			this.planned.set(patch, builds);
		}
	}
	/** Narrow run eligibility: scalar object fields with an unchanged v1 schema. */
	scalarColumn(target: string, field: CoreField): PulseLayout | undefined {
		if (this.maxVersion !== 1) return;
		const node = this.index.get(target);
		if (!node || node.kind !== "object") return;
		const key = this.fieldKey(node, field);
		if (managedFields.has(key)) return;
		const entry = node.layout?.fieldsByKey.get(key),
			layout = entry?.layout;
		if (
			node.layout?.constant ||
			!entry ||
			entry.constant ||
			entry.richText ||
			!layout ||
			layout.constant ||
			layout.richText
		)
			return;
		if (layout.kind !== "float64" && layout.kind !== "string") return;
		return layout;
	}
	/** Same checks as homogeneous validateScalarWrites, shared context once. */
	validateScalarRun(
		run: {
			sid: number;
			clock: number;
			schema: string;
			target: string;
			field: CoreField;
			layout: number;
			external: PulseVersionVector;
		},
		values: readonly CoreScalar[],
	): void {
		const layout = this.scalarColumn(run.target, run.field);
		if (
			!layout ||
			run.schema !== this.schemaId ||
			run.layout !== layout.id + 2
		) {
			if (run.schema !== this.schemaId) this.schemaFor(run.schema);
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"Invalid scalar run layout",
			);
		}
		const node = this.index.get(run.target)!;
		const actor = node.initialStamp[1],
			created = node.initialStamp[2];
		const have =
			actor === run.sid
				? run.clock > 1
					? run.clock
					: 0
				: (run.external.find(([sid]) => sid === actor)?.[1] ?? 0);
		if (have <= created)
			throw new PulseError(
				"INVALID_MESSAGE",
				"Operation reference is not causally covered",
			);
		for (const value of values) layout.assert(value);
	}

	validateSingle(patch: CorePatch, dependencies: PulseVersionVector): void {
		if (this.maxVersion === 1 && this.validateScalarWrite(patch, dependencies))
			return;
		this.validate([patch], new Map([[patch, dependencies]]));
	}
	private validateScalarWrites(
		patches: readonly CorePatch[],
		dependencies: ReadonlyMap<CorePatch, PulseVersionVector>,
	): boolean {
		for (const patch of patches)
			if (!this.validateScalarWrite(patch, dependencies.get(patch) ?? []))
				return false;
		return true;
	}
	private validateScalarWrite(
		patch: CorePatch,
		dependencies: PulseVersionVector,
	): boolean {
		const op = patch.ops.length === 1 ? patch.ops[0] : undefined;
		if (
			op?.kind !== 1 ||
			op.value.constants.length ||
			op.value.texts.length ||
			(op.value.value !== null && typeof op.value.value === "object")
		)
			return false;
		if (patch.schema !== this.schemaId) return false;
		const node = this.index.get(op.target);
		if (!node) return false;
		if (node.kind !== "object")
			throw new PulseError("INVALID_MESSAGE", "Expected object target");
		const actor = node.initialStamp[1],
			clock = node.initialStamp[2];
		let covered = false;
		for (const [sid, time] of dependencies)
			if (sid === actor && time > clock) {
				covered = true;
				break;
			}
		if (!covered)
			throw new PulseError(
				"INVALID_MESSAGE",
				"Operation reference is not causally covered",
			);
		const key = this.fieldKey(node, op.field);
		const field = node.layout?.fieldsByKey.get(key);
		if (
			node === this.root &&
			managedFields.has(key) &&
			(key !== "version" || op.value.value !== 1)
		)
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"Document metadata is managed by Pulsify",
			);
		const layout = this.layoutField(node, key);
		if (
			(!managedFields.has(key) && node.layout?.constant) ||
			field?.constant ||
			layout?.constant
		)
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"Cannot mutate a constant field",
			);
		if (field?.richText || layout?.richText) return false;
		if (
			node.layout?.kind === "object" &&
			!field &&
			!(node === this.root && managedFields.has(key))
		)
			throw new PulseError("INVALID_MESSAGE", "Unknown schema property");
		this.validateValue(layout, op.value.value);
		return true;
	}
	private readonly planned = new WeakMap<CorePatch, BuiltValue[]>();
	private rootStamp: Stamp | undefined;
	private rootSchemaVersion = 0;
	validateRoot(value: unknown, schema?: string): void {
		const data = value as Record<string, unknown>;
		if (
			!data ||
			typeof data !== "object" ||
			Array.isArray(data) ||
			data["id"] !== this.docId ||
			data["kind"] !== this.kind ||
			!Number.isSafeInteger(data["version"]) ||
			(data["version"] as number) < 1 ||
			(data["version"] as number) > this.maxVersion ||
			data["generation"] !== 0
		)
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"Document identity, kind or migration version is incompatible",
			);
		if (schema !== undefined) {
			const expected = this.schemaAtVersion(data["version"] as number);
			const identity =
				this.migrationChain?.schemaIds[(data["version"] as number) - 1] ??
				(expected ? schemaFingerprint(expected) : "");
			if (schema !== identity) {
				if (this.migrationChain)
					throw this.migrationDrift(
						schema,
						data["version"] as number,
						"Root schema does not match its stored version",
						value,
					);
				throw new PulseError(
					"INCOMPATIBLE_DOCUMENT",
					"Root schema does not match its stored version",
				);
			}
		}
	}
	apply(patch: CorePatch, hint?: number): void {
		const patchSchema = this.schemaFor(patch.schema);
		this.lamport = Math.max(this.lamport, patch.lamport);
		if (patch.sid === this.sid)
			this.nextClock = Math.max(this.nextClock, patch.clock + 1);
		const stamp: Stamp = [patch.lamport, patch.sid, patch.clock];
		const single = patch.ops.length === 1 ? patch.ops[0] : undefined;
		if (
			this.maxVersion === 1 &&
			single?.kind === 1 &&
			!this.planned.get(patch)?.[0]?.child &&
			!single.value.constants.length &&
			!single.value.texts.length &&
			(single.value.value === null || typeof single.value.value !== "object")
		) {
			const node = this.index.get(single.target)!;
			const key = this.fieldKey(node, single.field);
			if (newer(stamp, node.stamps.get(key) ?? node.initialStamp)) {
				node.stamps.set(key, stamp);
				node.removeChild(key);
				const layout = this.layoutField(node, key);
				node.data[key] =
					layout?.kind === "float32"
						? Math.fround(single.value.value as number)
						: single.value.value;
			}
			this.planned.delete(patch);
			return;
		}
		let serial = 0;
		const id = () => `${patch.sid}:${patch.clock}:${serial++}`;
		const planned = this.planned.get(patch);
		let builtIndex = 0;
		const build = (
			value: PreparedValue,
			layout: PulseLayout | undefined,
			documentRoot = false,
		) => {
			const staged = planned?.[builtIndex++];
			if (!staged)
				return this.build(
					value,
					id,
					stamp,
					layout,
					this.index,
					false,
					documentRoot,
				);
			serial = staged.serialEnd;
			for (const [key, node] of staged.nodes) this.index.set(key, node);
			return staged;
		};
		for (const op of patch.ops) {
			if (op.kind === 0) {
				const built = build(op.value, patchSchema?.root, true);
				if (newer(stamp, this.rootStamp)) {
					this.root = built.child;
					this.rootStamp = stamp;
					this.rootSchemaVersion = (built.value as Record<string, unknown>)[
						"version"
					] as number;
				}
				continue;
			}
			const node = this.index.get(op.target)!;
			if (op.kind === 1 || op.kind === 2) {
				const key = this.fieldKey(node, op.field);
				const operationLayout =
					node === this.root
						? resolveLayout(patchSchema?.root, node.data)
						: node.layout;
				const metadata = node === this.root && managedFields.has(key);
				const field = metadata
					? undefined
					: operationLayout?.fieldsByKey.get(key);
				const fieldLayout = metadata
					? undefined
					: (field?.layout ??
						(operationLayout?.kind === "map"
							? operationLayout.element
							: undefined));
				const built =
					op.kind === 1
						? build(
								metadata
									? op.value
									: this.fieldPrepared(op.value, field ?? fieldLayout),
								fieldLayout,
							)
						: { value: undefined, child: undefined };
				const write =
					node === this.root && key === "version"
						? op.kind === 1 &&
							((op.value.value as number) > (node.data.version as number) ||
								(op.value.value === node.data.version &&
									newer(stamp, node.stamps.get(key) ?? node.initialStamp)))
						: newer(stamp, node.stamps.get(key) ?? node.initialStamp);
				if (write) {
					node.stamps.set(key, stamp);
					node.removeChild(key);
					if (op.kind === 2) delete node.data[key];
					else {
						node.data[key] = built.value;
						this.adopt(node, key, built.child);
					}
				}
			} else if (op.kind === 3) {
				this.remove(node, op.deletes);
				let after = op.after;
				let offset = hint;
				for (const value of op.values) {
					const entryId = id();
					const built = build(
						value,
						node.kind === "text" ? undefined : node.layout?.element,
					);
					const entry: CoreEntry = {
						id: entryId,
						after,
						stamp,
						write: stamp,
						value: built.value,
						child: built.child,
						deleted: false,
						children: [],
						marks: node.kind === "text" ? new Map() : emptyMarks,
					};
					this.insert(node, entry, offset);
					after = entryId;
					if (offset !== undefined) offset++;
				}
			} else if (op.kind === 4) {
				const entry = node.entries.get(op.entry)!;
				const built = build(
					op.value,
					node.layout?.kind === "tuple"
						? node.layout.elements?.[
								node.order.findIndex((item) => item.id === op.entry)
							]
						: node.layout?.element,
				);
				if (newer(stamp, entry.write)) {
					entry.write = stamp;
					entry.value = built.value;
					entry.child = built.child;
					this.adopt(node, entry.id, built.child);
					if (!entry.deleted)
						node.data[node.visible.indexOf(entry)] = built.value;
				}
			} else {
				for (const entryId of op.entries) {
					const entry = node.entries.get(entryId)!;
					for (const [key, value] of Object.entries(op.attributes))
						if (newer(stamp, entry.marks.get(key)?.stamp))
							entry.marks.set(key, { stamp, value });
					if (Object.hasOwn(op.attributes, RT_NODE)) trackRichTextAnchor(node, entry);
				}
			}
			if (node.kind === "text") this.syncText(node);
		}
		this.planned.delete(patch);
		if (this.maxVersion > 1 && this.root) {
			const version = this.root.data.version as number;
			if (version !== this.rootSchemaVersion) {
				const compiled = this.schemaAtVersion(version);
				if (compiled) this.retype(this.root, compiled.root);
				this.rootSchemaVersion = version;
			}
		}
	}
	private retype(node: CoreNode, layout: PulseLayout | undefined) {
		node.layout = resolveLayout(
			layout,
			node.kind === "text" ? node.data.join("") : node.data,
		);
		if (node.kind === "object")
			for (const [key, child] of node.children) {
				const field = node.layout?.fieldsByKey.get(key);
				if (field?.constant) {
					node.data[key] = freezeConstant(structuredClone(node.data[key]));
					node.removeChild(key);
				} else
					this.retype(
						child,
						field?.layout ??
							(node.layout?.kind === "map" ? node.layout.element : undefined),
					);
			}
		else
			for (const entry of node.order)
				if (entry.child)
					this.retype(
						entry.child,
						node.layout?.element ??
							node.layout?.elements?.[node.order.indexOf(entry)],
					);
	}
	private syncText(node: CoreNode) {
		const text = richTextContent(node);
		const parent = node.parent,
			key = node.parentKey;
		if (!parent || key === undefined) return;
		if (parent.kind === "object") {
			if (parent.children.get(key) === node) parent.data[key] = text;
		} else {
			const entry = parent.entries.get(key);
			if (entry?.child === node) {
				entry.value = text;
				if (!entry.deleted) parent.data[parent.visible.indexOf(entry)] = text;
			}
		}
	}
	private adopt(parent: CoreNode, key: string, child: CoreNode | undefined) {
		if (child) {
			if (parent.kind === "object") parent.setChild(key, child);
			child.parent = parent;
			child.parentKey = key;
		}
	}
	private receivedConstant(
		value: unknown,
		layout: PulseLayout | undefined,
		depth: number,
	): unknown {
		const checked = (layout ?? unknownLayout).prepare(value, depth);
		// Received float32 values are already rounded. Reinterpreting -0 as raw
		// user input would lose the sign produced by a negative underflow.
		return freezeConstant(layout ? layout.clone(value) : checked.value);
	}

	private build(
		prepared: PreparedValue,
		id: () => string,
		stamp: Stamp,
		layout: PulseLayout | undefined,
		index: Map<string, CoreNode>,
		reuse = false,
		documentRoot = false,
		validate = false,
	): { value: unknown; child: CoreNode | undefined } {
		if (
			!validate &&
			!layout?.constant &&
			!layout?.richText &&
			!prepared.constants.length &&
			!prepared.texts.length &&
			(prepared.value === null || typeof prepared.value !== "object")
		)
			return {
				value:
					layout?.kind === "float32"
						? Math.fround(prepared.value as number)
						: prepared.value,
				child: undefined,
			};
		const constantPaths = prepared.constants.length
			? new Set(prepared.constants.map(keyPath))
			: emptyPathSet;
		const textPaths = prepared.texts.length
			? new Set(prepared.texts.map(keyPath))
			: emptyPathSet;
		const trackPaths = constantPaths.size > 0 || textPaths.size > 0;
		const walk = (
			value: any,
			path: string[],
			current: PulseLayout | undefined,
			constant = false,
			text = false,
			depth = 0,
			grammarChecked = false,
		): { value: any; child: CoreNode | undefined } => {
			const captured =
				!(documentRoot && depth === 0) &&
				(constant ||
					current?.constant ||
					current?.kind === "literal" ||
					(constantPaths.size && constantPaths.has(keyPath(path))));
			if (validate && captured)
				return {
					value: this.receivedConstant(value, current, depth),
					child: undefined,
				};
			if (validate) {
				if (depth > 32)
					throw new TypeError("Pulse values may nest at most 32 levels");
				const application =
					documentRoot &&
					depth === 0 &&
					(current?.kind === "map" || current?.kind === "literal")
						? withoutMetadata(value)
						: value;
				current?.assertShallow(application);
			}
			current = resolveLayout(current, value);
			if (
				validate &&
				(!current || current.kind === "unknown" || current.kind === "schema") &&
				!grammarChecked
			) {
				value = (current ?? unknownLayout).prepare(value, depth).value;
				grammarChecked = true;
			}
			if (
				!(documentRoot && depth === 0) &&
				(constant ||
					current?.constant ||
					current?.kind === "literal" ||
					(constantPaths.size && constantPaths.has(keyPath(path))))
			) {
				const owned = validate
					? this.receivedConstant(value, current, depth)
					: structuredClone(value);
				return { value: freezeConstant(owned), child: undefined };
			}
			const isText =
				typeof value === "string" &&
				(text ||
					current?.richText ||
					(textPaths.size > 0 && textPaths.has(keyPath(path))));
			if (
				!isText &&
				(value === null ||
					typeof value !== "object" ||
					value instanceof Uint8Array)
			)
				return {
					value:
						value instanceof Uint8Array
							? new Uint8Array(value)
							: current?.kind === "float32"
								? Math.fround(value)
								: value,
					child: undefined,
				};
			const array = isText || Array.isArray(value);
			const root = documentRoot && depth === 0;
			let keys: readonly string[] | undefined;
			if (current?.kind === "object") {
				const cache = root ? rootKeyCache : fieldKeyCache;
				keys = cache.get(current);
				if (!keys) {
					const declared = current.fields.map((field) => field.key);
					if (root)
						for (const key of managedFields)
							if (!current.fieldsByKey.has(key)) declared.push(key);
					cache.set(current, declared);
					keys = declared;
				}
			}
			let useInput = reuse && !isText;
			let actual: string[] | undefined;
			if (useInput && keys) {
				actual = Object.keys(value);
				if (actual.length !== keys.length) useInput = false;
				else
					for (let i = 0; i < keys.length; i++)
						if (actual[i] !== keys[i]) {
							useInput = false;
							break;
						}
			}
			if (validate && current?.kind === "object" && !useInput) {
				actual ??= Object.keys(value);
				for (const key of actual) {
					if (current.fieldsByKey.has(key) || (root && managedFields.has(key)))
						continue;
					assertKey(key);
					unknownLayout.prepare(value[key], depth + 1);
				}
			}
			const node = new CoreNode(
				id(),
				isText ? "text" : array ? "array" : "object",
				useInput ? value : array ? [] : {},
				current,
				stamp,
			);
			index.set(node.id, node);
			if (array) {
				const values = (
					isText ? Array.from(value as string) : value
				) as unknown[];
				let after = "";
				for (let i = 0; i < values.length; i++) {
					if (validate && !isText && !(i in values))
						throw new TypeError("Pulse arrays cannot contain holes");
					const entryId = id();
					const built = walk(
						values[i],
						trackPaths ? [...path, String(i)] : path,
						current?.element ?? current?.elements?.[i],
						false,
						false,
						depth + (isText ? 0 : 1),
						grammarChecked,
					);
					const entry: CoreEntry = {
						id: entryId,
						after,
						stamp,
						write: stamp,
						value: built.value,
						child: built.child,
						deleted: false,
						children: [],
						marks: node.kind === "text" ? new Map() : emptyMarks,
					};
					node.entries.set(entryId, entry);
					if (after) node.entries.get(after)!.children.push(entry);
					else node.heads.push(entry);
					node.order.push(entry);
					node.visible.push(entry);
					if (useInput) node.data[i] = built.value;
					else node.data.push(built.value);
					this.adopt(node, entryId, built.child);
					after = entryId;
				}
			} else {
				keys ??= Object.keys(value);
				for (const key of keys) {
					const field = current?.fieldsByKey.get(key);
					if (!Object.hasOwn(value, key)) {
						if (validate) field?.layout.assertShallow(undefined);
						continue;
					}
					if (current?.kind !== "object") assertKey(key);
					const metadata =
						documentRoot && depth === 0 && managedFields.has(key);
					if (validate && metadata) field?.layout.assertShallow(value[key]);
					const built = walk(
						value[key],
						trackPaths ? [...path, key] : path,
						metadata
							? undefined
							: (field?.layout ??
									(current?.kind === "map" ? current.element : undefined)),
						!metadata &&
							(field?.constant ||
								(documentRoot && depth === 0 && !!current?.constant)),
						!metadata && field?.richText,
						depth + 1,
						grammarChecked || metadata,
					);
					node.data[key] = built.value;
					this.adopt(node, key, built.child);
				}
			}
			return { value: isText ? node.data.join("") : node.data, child: node };
		};
		const built = walk(prepared.value, [], layout);
		if (validate && trackPaths)
			validatePrepared({
				value: built.value,
				constants: prepared.constants,
				texts: prepared.texts,
			});
		return built;
	}
	private insert(node: CoreNode, entry: CoreEntry, hint?: number): void {
		const parent = entry.after ? node.entries.get(entry.after)! : undefined;
		const siblings = parent?.children ?? node.heads;
		let sibling = 0;
		while (
			sibling < siblings.length &&
			newer(siblings[sibling]!.stamp, entry.stamp)
		)
			sibling++;
		let orderIndex: number;
		if (sibling === 0)
			orderIndex = parent
				? node.order[node.order.length - 1] === parent
					? node.order.length
					: node.order.indexOf(parent) + 1
				: 0;
		else {
			let tail = siblings[sibling - 1]!;
			while (tail.children.length)
				tail = tail.children[tail.children.length - 1]!;
			orderIndex =
				node.order[node.order.length - 1] === tail
					? node.order.length
					: node.order.indexOf(tail) + 1;
		}
		siblings.splice(sibling, 0, entry);
		node.entries.set(entry.id, entry);
		node.order.splice(orderIndex, 0, entry);
		let visibleIndex = hint;
		if (visibleIndex === undefined) {
			if (orderIndex === node.order.length - 1)
				visibleIndex = node.visible.length;
			else {
				visibleIndex = 0;
				for (let i = 0; i < orderIndex; i++)
					if (!node.order[i]!.deleted) visibleIndex++;
			}
		}
		node.visible.splice(visibleIndex, 0, entry);
		node.data.splice(visibleIndex, 0, entry.value);
		this.adopt(node, entry.id, entry.child);
	}
	private remove(node: CoreNode, ids: readonly string[]) {
		for (const id of ids) {
			const entry = node.entries.get(id)!;
			if (entry.deleted) continue;
			entry.deleted = true;
			const position = node.visible.indexOf(entry);
			node.visible.splice(position, 1);
			node.data.splice(position, 1);
		}
	}
}
type BuiltValue = {
	value: unknown;
	child: CoreNode | undefined;
	nodes: Map<string, CoreNode>;
	serialEnd: number;
};
function resolveLayout(
	layout: PulseLayout | undefined,
	value: unknown,
): PulseLayout | undefined {
	if (!layout) return;
	if (layout.kind === "optional" && value !== undefined)
		return resolveLayout(layout.value, value);
	if (layout.kind === "union" && value && typeof value === "object")
		return resolveLayout(
			layout.variants?.get(
				String((value as Record<string, unknown>)[layout.tagName!]),
			),
			value,
		);
	if (layout.kind === "untaggedUnion")
		for (const candidate of layout.elements ?? []) {
			try {
				candidate.assert(value);
				return resolveLayout(candidate, value);
			} catch {
				/* Try the next union variant. */
			}
		}
	return layout;
}
const fieldKeyCache = new WeakMap<PulseLayout, string[]>();
const rootKeyCache = new WeakMap<PulseLayout, string[]>();
const unknownLayout = compilePulseSchema("unknown").root;
const schemaCache = new WeakMap<
	CompiledPulseSchema,
	{ id: string; codec?: Codec<unknown> }
>();
const unknownCodec = createCodec("unknown");
import { createDecoder } from "@gin-quin/codec";
function decodeWhole(codec: Codec<unknown>, bytes: Uint8Array): unknown {
	const decoder = createDecoder(bytes),
		value = codec.decode(decoder);
	if (decoder.pos !== bytes.length)
		throw new PulseError("INVALID_MESSAGE", "Trailing value bytes");
	return value;
}

const binaryLayouts = new WeakMap<PulseLayout, boolean>();
function ownDecoded(layout: PulseLayout | undefined, value: unknown): unknown {
	if (!layout) return value;
	let binary = binaryLayouts.get(layout);
	if (binary === undefined) {
		binary = false;
		const seen = new Set<PulseLayout>(),
			pending = [layout];
		while (pending.length) {
			const current = pending.pop()!;
			if (seen.has(current)) continue;
			seen.add(current);
			if (current.kind === "uint8Array" || current.kind === "unknown") {
				binary = true;
				break;
			}
			for (const field of current.fields) pending.push(field.layout);
			if (current.element) pending.push(current.element);
			if (current.value) pending.push(current.value);
			pending.push(
				...(current.elements ?? []),
				...(current.variants?.values() ?? []),
			);
		}
		binaryLayouts.set(layout, binary);
	}
	return binary ? prepareValue(value).value : value;
}

function withoutMetadata(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const data = { ...value };
	for (const key of managedFields) delete data[key];
	return data;
}

function mergePreparedPaths(left: string[][], right: string[][]): string[][] {
	if (!left.length) return right;
	if (!right.length) return left;
	return [
		...new Map(
			[...left, ...right].map((path) => [keyPath(path), path]),
		).values(),
	];
}
