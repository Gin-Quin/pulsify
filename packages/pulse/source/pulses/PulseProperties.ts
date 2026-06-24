import type { JsonObject } from "pulse/utilities/JsonValue";

export type PulseProperties<Kind extends string> = {
	readonly id: string;
	readonly kind: Kind;

	/**
	 * Current migration level applied.
	 * Starts at version 1.
	 */
	version: number;

	/**
	 * Increments when a document is restored/forked and older generations must be ignored.
	 */
	generation?: number;
} & JsonObject;
