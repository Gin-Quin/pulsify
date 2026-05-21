import type {
	AnyMigration,
	LastMigration,
	Migration,
	MigrationResult,
} from "../migration/Migrations";
import type { Binding, Bindings } from "./Bindings";
import type { PulseProperties } from "./PulseProperties";

export type PulseMigration = Migration<
	PulseProperties<string>,
	PulseProperties<string>
>;

export type PulseDefinition<
	Model extends PulseProperties<string>,
	Migrations extends readonly PulseMigration[],
	Data extends PulseProperties<string> = LastMigration<Migrations>,
> = {
	kind: Model["kind"];
	migrations: Migrations;
	bindings?: PulseBindings<Data, Model>;
};

export type PulseBindings<Data extends object, Model extends object> = (input: {
	data: Data;
	bind: <DataKey extends keyof Data, ModelKey extends keyof Model>(
		dataKey: DataKey,
		modelKey: ModelKey,
	) => Binding<Data[DataKey], Model[ModelKey]>;
}) => Bindings<Data, Model>;

export type AnyPulseDefinition = PulseDefinition<
	PulseProperties<string>,
	readonly PulseMigration[],
	PulseProperties<string>
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
		migrator: (before: From) => MigrationResult<From, To>,
	): PulseTypeBuilder<To, readonly [...Migrations, Migration<From, To>]> {
		const migrations = [...this.migrations, { name, migrator }] as readonly [
			...Migrations,
			Migration<From, To>,
		];

		return new PulseTypeBuilder<
			To,
			readonly [...Migrations, Migration<From, To>]
		>(this.kind, migrations);
	}

	bind(): PulseDefinition<From, Migrations, From>;

	bind<Model extends PulseProperties<From["kind"]>>(
		bindings: PulseBindings<From, Model>,
	): PulseDefinition<Model, Migrations, From>;

	bind<Model extends PulseProperties<From["kind"]>>(
		bindings?: PulseBindings<From, Model>,
	): PulseDefinition<Model, Migrations, From> {
		return {
			kind: this.kind,
			migrations: this.migrations,
			bindings,
		} as PulseDefinition<Model, Migrations, From>;
	}
}

// usage example

// const User = definePulse<UserV1>("User")
// 	.migrate<UserV2>("v2", () => ({
// 		email: "Hello",
// 	}))
// 	.migrate<UserV3>("v3", () => ({
// 		emailV2: "hello@you",
// 	}))
// 	.bind<User>(({ data, bind }) => ({
// 		email: bind("emailV2"),
// 	}));

// type User = PulseProperties & {
// 	name: string;
// 	email: string;
// };

// type UserV3 = UserV2 & {
// 	emailV2: string;
// };

// type UserV2 = UserV1 & {
// 	email: string;
// };

// type UserV1 = PulseProperties & {
// 	name: string;
// };
