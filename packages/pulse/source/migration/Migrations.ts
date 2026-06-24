import type { IsSameType } from "../utilities/IsSameType";

declare const migrationVersions: unique symbol;

type Simplify<ObjectType> = {
	[Key in keyof ObjectType]: ObjectType[Key];
};

export type MigrationResult<
	Before extends object,
	After extends object,
	ExcludedKeys extends PropertyKey = never,
> = Simplify<
	RequiredMigrationResult<Before, After, ExcludedKeys> &
		OptionalMigrationResult<Before, After, ExcludedKeys>
>;

type RequiredMigrationResult<
	Before extends object,
	After extends object,
	ExcludedKeys extends PropertyKey,
> = {
	[Key in keyof After as Key extends ExcludedKeys
		? never
		: Key extends keyof Before
			? IsSameType<Before[Key], After[Key]> extends true
				? never
				: Key
			: Key]: After[Key];
};

type OptionalMigrationResult<
	Before extends object,
	After extends object,
	ExcludedKeys extends PropertyKey,
> = {
	[Key in keyof After as Key extends ExcludedKeys
		? never
		: Key extends keyof Before
			? IsSameType<Before[Key], After[Key]> extends true
				? Key
				: never
			: never]?: After[Key];
};

export type Migration<
	Before extends object,
	After extends object,
	ExcludedKeys extends PropertyKey = never,
> = {
	name: string;
	migrator: (before: Before) => MigrationResult<Before, After, ExcludedKeys>;
	readonly [migrationVersions]?: After;
};

export type AnyMigration = Migration<any, any>;

export type LastMigration<Migrations extends readonly AnyMigration[]> =
	Migrations extends readonly [
		...(readonly AnyMigration[]),
		Migration<any, infer Last extends object, any>,
	]
		? Last
		: never;
