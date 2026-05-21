import type { IsSameType } from "../utilities/IsSameType";

declare const migrationVersions: unique symbol;

export type MigrationResult<Before extends object, After extends object> = {
	[Key in keyof After as Key extends keyof Before
		? IsSameType<Before[Key], After[Key]> extends true
			? never
			: Key
		: Key]: After[Key];
} & {
	[Key in keyof After as Key extends keyof Before
		? IsSameType<Before[Key], After[Key]> extends true
			? Key
			: never
		: never]?: After[Key];
};

export type Migration<Before extends object, After extends object> = {
	name: string;
	migrator: (before: Before) => MigrationResult<Before, After>;
	readonly [migrationVersions]?: After;
};

export type AnyMigration = Migration<any, any>;

export type LastMigration<Migrations extends readonly AnyMigration[]> =
	Migrations extends readonly [
		...(readonly AnyMigration[]),
		Migration<any, infer Last extends object>,
	]
		? Last
		: never;
