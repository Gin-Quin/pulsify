import type {
	AnyMigration,
	LastMigration,
	Migration,
	MigrationResult,
} from "../migration/Migrations";
import type { Binding, Bindings } from "./Bindings";
import type { PulseProperties } from "./PulseProperties";

type ManagedMigrationKeys = "generation" | "id" | "kind" | "version";
type ManagedMigrationKeyPattern = `${ManagedMigrationKeys}${string}`;

export type PulseMigration = Migration<
	PulseProperties<string>,
	PulseProperties<string>,
	ManagedMigrationKeys
>;

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

export function definePulse<From extends PulseProperties<string>>(
	kind: From["kind"],
): PulseTypeBuilder<From, []> {
	return new PulseTypeBuilder<From, []>(kind, []);
}

class PulseTypeBuilder<
	From extends PulseProperties<string>,
	Migrations extends readonly AnyMigration[],
> {
	private migrations: Migrations;
	public readonly kind: From["kind"];

	constructor(kind: From["kind"], migrations: Migrations) {
		this.migrations = migrations;
		this.kind = kind;
	}

	migrate<To extends PulseProperties<From["kind"]>>(
		name: string,
		migrator: (before: From) => PulseMigrationResult<From, To>,
	): PulseTypeBuilder<
		To,
		readonly [...Migrations, Migration<From, To, ManagedMigrationKeys>]
	> {
		const migrations = [...this.migrations, { name, migrator }] as readonly [
			...Migrations,
			Migration<From, To, ManagedMigrationKeys>,
		];

		return new PulseTypeBuilder<
			To,
			readonly [...Migrations, Migration<From, To, ManagedMigrationKeys>]
		>(this.kind, migrations);
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
		return {
			kind: this.kind,
			migrations: this.migrations,
			materializer,
		} as PulseDefinition<Model, Migrations, From>;
	}
}

// usage example

const User = definePulse<UserV1>("User")
	.migrate<UserV2>("v2", () => ({
		email: "salut@toi",
	}))
	.migrate<UserV3>("v3", () => ({
		emailV2: "hello@you",
	}))
	.materialize<User>(({ bind }) => ({
		email: bind("emailV2"),
	}));

type User = PulseProperties<"User"> & {
	name: string;
	email: string;
};

type UserV3 = UserV2 & {
	emailV2: string;
};

type UserV2 = UserV1 & {
	email: string;
};

type UserV1 = PulseProperties<"User"> & {
	name: string;
};
