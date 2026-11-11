import type { InferType, Schema } from "@gin-quin/codec";
import { prepareCoreSchema } from "../core/model.js";
import {
	compilePulseSchema,
	type CompiledPulseSchema,
	type PulseSchemaOptions,
	type PulseSchemaValue,
} from "../core/schema.js";
import type {
	AnyMigration,
	LastMigration,
	Migration,
	MigrationResult,
} from "../migration/Migrations.js";
import type { Binding, Bindings } from "./Bindings.js";
import {
	compileMigrationChain,
	type MigrationChain,
} from "../migration/MigrationChain.js";
import type { PulseProperties } from "./PulseProperties.js";
import type { PulseSnapshot } from "./Pulse.js";

type ManagedMigrationKeys = "generation" | "id" | "kind" | "version";
type ManagedMigrationKeyPattern = `${ManagedMigrationKeys}${string}`;

export type PulseMigration = Migration<any, any, ManagedMigrationKeys>;

type PulseMigrationResult<
	Before extends object,
	After extends object,
> = MigrationResult<Before, After, ManagedMigrationKeys> & {
	// Keep managed fields out of completions while still rejecting manual writes.
	[key: ManagedMigrationKeyPattern]: never;
};

export type PulseDefinition<
	Model extends PulseProperties<string>,
	Migrations extends readonly PulseMigration[],
	Data extends PulseProperties<string> = LastMigration<Migrations>,
> = {
	kind: Model["kind"];
	migrations: Migrations;
	materializer?: PulseMaterializer<Data, Model>;
	/** The original codec schema, shared by document and patch codecs. */
	schema?: Schema;
	compiledSchema?: CompiledPulseSchema<Schema>;
	/** A codec layout for each stored version, indexed by version - 1. */
	schemas?: readonly (CompiledPulseSchema | undefined)[];
	/** Cached recursive compatibility identities, shared by every document. */
	migrationChain?: MigrationChain;
};

/**
 * Describes how the latest stored pulse data is exposed as the public model.
 *
 * Use `bind` for fields that should stay connected in both directions: model
 * reads come from the data field, and model writes update that data field.
 */
export type PulseMaterializer<
	Data extends object,
	Model extends object,
> = (input: {
	bind: <DataKey extends keyof Data>(
		dataKey: DataKey,
	) => Binding<Data, Data[DataKey]>;
}) => Bindings<Data, Model>;

export type AnyPulseDefinition = PulseDefinition<
	any,
	readonly PulseMigration[],
	any
>;

export type ModelFromDefinition<
	Definition extends PulseDefinition<any, any, any>,
> = Definition extends PulseDefinition<infer Model, any, any> ? Model : never;

export type DataFromDefinition<
	Definition extends PulseDefinition<any, any, any>,
> = Definition extends PulseDefinition<any, any, infer Data> ? Data : never;

type ApplicationProperties<Value, Kind extends string> = Value extends unknown
	? string extends keyof Value
		? Omit<Value, keyof PulseProperties<string>>
		: "kind" extends keyof Value
			? Kind extends Value["kind"]
				? Omit<Value, keyof PulseProperties<string>>
				: never
			: Omit<Value, keyof PulseProperties<string>>
	: never;
type SchemaForKind<S extends Schema, Kind extends string> =
	InferType<S> extends object
		? [ApplicationProperties<InferType<S>, Kind>] extends [never]
			? never
			: unknown
		: never;
export type SchemaPulseProperties<
	Kind extends string,
	S extends Schema,
	O extends PulseSchemaOptions = {},
> = PulseProperties<Kind> & ApplicationProperties<PulseSchemaValue<S, O>, Kind>;

type SchemaMigrationData<Kind extends string, S extends Schema> = PulseSnapshot<
	SchemaPulseProperties<Kind, S>
>;

export function definePulse<const Kind extends string>(
	kind: Kind,
): PulseTypeBuilder<PulseProperties<Kind>, []>;
export function definePulse<From extends PulseProperties<string>>(
	kind: From["kind"],
): PulseTypeBuilder<From, []>;
/** Infer the public data fields directly from the same schema used by codec. */
export function definePulse<
	const Kind extends string,
	S extends Schema,
	const O extends PulseSchemaOptions = {},
>(
	kind: Kind,
	schema: S & SchemaForKind<S, Kind>,
	options?: O,
): PulseTypeBuilder<SchemaPulseProperties<Kind, S, O>, []>;
export function definePulse(
	kind: string,
	schema?: Schema,
	options?: PulseSchemaOptions,
): unknown {
	return new PulseTypeBuilder<PulseProperties<string>, []>(
		kind,
		[],
		schema,
		options,
	);
}

class PulseTypeBuilder<
	From extends PulseProperties<string>,
	Migrations extends readonly AnyMigration[],
> {
	private migrations: Migrations;
	private readonly valueSchema: Schema | undefined;
	private readonly schemaOptions: PulseSchemaOptions | undefined;
	private readonly schemaHistory: readonly (CompiledPulseSchema | undefined)[];
	private currentCompiled: CompiledPulseSchema | undefined;
	private currentChain: MigrationChain | undefined;
	public readonly kind: From["kind"];

	constructor(
		kind: From["kind"],
		migrations: Migrations,
		schema?: Schema,
		options?: PulseSchemaOptions,
		history: readonly (CompiledPulseSchema | undefined)[] = [],
		compiled?: CompiledPulseSchema,
	) {
		this.migrations = migrations;
		this.kind = kind;
		this.valueSchema = schema;
		this.schemaOptions = options;
		this.schemaHistory = history;
		this.currentCompiled = compiled;
	}

	private compileCurrent(): CompiledPulseSchema | undefined {
		if (this.valueSchema === undefined) return undefined;
		return (this.currentCompiled ??= compilePulseSchema(
			this.valueSchema,
			this.schemaOptions,
		));
	}

	/** Select the schema for the latest stored data and infer its fields. */
	schema<S extends Schema, const O extends PulseSchemaOptions = {}>(
		schema: S & SchemaForKind<S, From["kind"]>,
		options?: O,
	): PulseTypeBuilder<SchemaPulseProperties<From["kind"], S, O>, Migrations> {
		return new PulseTypeBuilder<
			SchemaPulseProperties<From["kind"], S, O>,
			Migrations
		>(
			this.kind as SchemaPulseProperties<From["kind"], S, O>["kind"],
			this.migrations,
			schema,
			options,
			this.schemaHistory,
		);
	}

	/**
	 * Infer the next version from its schema and retain the previous layout.
	 * Once used, keep this migration unchanged and append new steps for fixes.
	 */
	migrateTo<S extends Schema, const O extends PulseSchemaOptions = {}>(
		schema: S & SchemaForKind<S, From["kind"]>,
		migrator: (
			before: PulseSnapshot<From>,
		) => PulseMigrationResult<
			PulseSnapshot<From>,
			SchemaMigrationData<From["kind"], NoInfer<S>>
		>,
		options?: O,
	): PulseTypeBuilder<
		SchemaPulseProperties<From["kind"], S, O>,
		readonly [
			...Migrations,
			Migration<
				PulseSnapshot<From>,
				SchemaMigrationData<From["kind"], S>,
				ManagedMigrationKeys
			>,
		]
	> {
		const migrations = [...this.migrations, { migrator }] as readonly [
			...Migrations,
			Migration<
				PulseSnapshot<From>,
				SchemaMigrationData<From["kind"], S>,
				ManagedMigrationKeys
			>,
		];
		return new PulseTypeBuilder<
			SchemaPulseProperties<From["kind"], S, O>,
			typeof migrations
		>(
			this.kind as SchemaPulseProperties<From["kind"], S, O>["kind"],
			migrations,
			schema,
			options,
			[...this.schemaHistory, this.compileCurrent()],
		);
	}

	/** Append a typed migration. Published steps must never be replaced or reordered. */
	migrate<To extends PulseProperties<From["kind"]>>(
		migrator: (before: PulseSnapshot<From>) => PulseMigrationResult<From, To>,
	): PulseTypeBuilder<
		To,
		readonly [
			...Migrations,
			Migration<From, To, ManagedMigrationKeys, PulseSnapshot<From>>,
		]
	> {
		const migrations = [...this.migrations, { migrator }] as readonly [
			...Migrations,
			Migration<From, To, ManagedMigrationKeys, PulseSnapshot<From>>,
		];

		const compiled = this.compileCurrent();
		return new PulseTypeBuilder<
			To,
			readonly [
				...Migrations,
				Migration<From, To, ManagedMigrationKeys, PulseSnapshot<From>>,
			]
		>(
			this.kind,
			migrations,
			this.valueSchema,
			this.schemaOptions,
			[...this.schemaHistory, compiled],
			compiled,
		);
	}

	/**
	 * Finalize this pulse definition without changing its public model.
	 */
	materialize(): PulseDefinition<From, Migrations, From>;

	/**
	 * Finalize this pulse definition by materializing the stored data as another
	 * public model shape.
	 */
	materialize<Model extends PulseProperties<From["kind"]>>(
		materializer: PulseMaterializer<From, Model>,
	): PulseDefinition<Model, Migrations, From>;

	materialize<Model extends PulseProperties<From["kind"]>>(
		materializer?: PulseMaterializer<From, Model>,
	): PulseDefinition<Model, Migrations, From> {
		const compiled = this.compileCurrent();
		const schemas = Object.freeze([...this.schemaHistory, compiled]);
		for (const schema of schemas) if (schema) prepareCoreSchema(schema);
		const migrationChain = (this.currentChain ??= compileMigrationChain(
			this.kind,
			schemas,
		));
		return {
			kind: this.kind,
			migrations: this.migrations,
			materializer,
			migrationChain,
			...(this.valueSchema === undefined
				? {}
				: {
						schema: this.valueSchema,
						compiledSchema: compiled,
					}),
			...(schemas.some((schema) => schema !== undefined) ? { schemas } : {}),
		} as PulseDefinition<Model, Migrations, From>;
	}
}
