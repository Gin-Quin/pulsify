import { createCodec, object } from "@gin-quin/codec";
import { schemaFingerprint, type CompiledPulseSchema } from "../core/schema.js";
import { fingerprintBytes } from "../utilities/fingerprint.js";

export type MigrationChain = {
	readonly fingerprints: readonly string[];
	readonly schemaIds: readonly string[];
	readonly versions: ReadonlyMap<string, number>;
};

const codec = createCodec(
	object({
		previous: "string",
		version: "uint",
		schema: "string",
	}),
);

/** Called once per definition; documents share these arrays and the lookup map. */
export function compileMigrationChain(
	kind: string,
	schemas: readonly (CompiledPulseSchema | undefined)[],
): MigrationChain {
	const fingerprints: string[] = [],
		schemaIds: string[] = [];
	const versions = new Map<string, number>();
	let previous = kind;
	for (let i = 0; i < schemas.length; i++) {
		const version = i + 1;
		const schema = schemas[i];
		const layout = schema ? schemaFingerprint(schema) : "";
		previous = fingerprintBytes(
			codec.encode({ previous, version, schema: layout }),
		);
		fingerprints.push(previous);
		// V1 retains its existing wire identity, including untyped documents.
		const id = version === 1 ? layout : `m${version}:${previous}`;
		schemaIds.push(id);
		versions.set(id, version);
	}
	return Object.freeze({
		fingerprints: Object.freeze(fingerprints),
		schemaIds: Object.freeze(schemaIds),
		versions,
	});
}

/** Only used for unknown identities, never on the ordinary patch path. */
export function migrationVersion(id: string): number | undefined {
	const match = /^m([1-9][0-9]*):[0-9a-f]{32}$/.exec(id);
	if (!match) return;
	const version = Number(match[1]);
	return Number.isSafeInteger(version) && version >= 2 ? version : undefined;
}
