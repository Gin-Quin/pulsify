import { rowToPatch, type PulsePatchRow } from "../connection/PulsePatch.js";
import { schemaFingerprint, type CompiledPulseSchema } from "../core/schema.js";
import { MigrationDriftError } from "../protocol/errors.js";
import type { PulseMeta } from "./PulseMeta.js";

const warned = new WeakMap<PulseMeta, Set<string>>();

/** A finite graph describes recursive schemas without invoking lazy functions. */
function describe(schema: CompiledPulseSchema | undefined) {
	if (!schema) return undefined;
	return {
		fingerprint: schemaFingerprint(schema),
		root: schema.root.id,
		annotations: structuredClone(schema.options),
		layouts: schema.layouts.map((layout) => ({
			id: layout.id,
			type: layout.kind,
			constant: layout.constant,
			richText: layout.richText,
			fields: layout.fields.map((field) => ({
				name: field.key,
				layout: field.layout.id,
				constant: field.constant,
				richText: field.richText,
			})),
			element: layout.element?.id,
			elements: layout.elements?.map((child) => child.id),
			variants: layout.variants
				? [...layout.variants].map(([tag, child]) => ({
						tag,
						layout: child.id,
					}))
				: undefined,
			tagName: layout.tagName,
			value: layout.value?.id,
			literal:
				typeof layout.schema === "object" && layout.schema._type === "literal"
					? structuredClone(layout.schema.value)
					: undefined,
		})),
	};
}

/** All copying and schema descriptions happen only after an update is rejected. */
export function warnMigrationDrift(
	meta: PulseMeta,
	error: unknown,
	row?: PulsePatchRow,
): void {
	if (!(error instanceof MigrationDriftError)) return;
	meta.lastError = error;
	let seen = warned.get(meta);
	if (!seen) warned.set(meta, (seen = new Set()));
	const key = `${error.details.version}:${error.details.received}`;
	if (seen.has(key)) return;
	seen.add(key);
	try {
		const version = error.details.version;
		let incomingSnapshot = error.incomingSnapshot;
		let incomingSnapshotUsesLocalSchema = false;
		if (incomingSnapshot === undefined && row) {
			// Best-effort diagnosis only. This value is NEVER applied or validated
			// as a remote schema: an unknown hash cannot reconstruct that schema.
			try {
				const expected =
					version === undefined
						? undefined
						: meta.definition.migrationChain?.schemaIds[version - 1];
				const patch = rowToPatch(
					row,
					expected === undefined
						? meta.model.encoding
						: meta.model.decodeEncoding(expected),
				);
				const root = patch.ops.find((op) => op.kind === 0);
				if (root?.kind === 0) {
					incomingSnapshot = root.value.value;
					incomingSnapshotUsesLocalSchema = true;
				}
			} catch {
				/* A different remote layout may not be decodable locally. */
			}
		}
		const schemaAt = (index: number) =>
			meta.definition.schemas?.[index] ??
			(index === meta.definition.migrations.length
				? meta.definition.compiledSchema
				: undefined);
		console.warn(
			"\nPULSIFY: MIGRATION DRIFT DETECTED — DOCUMENT UPDATE BLOCKED\n" +
				"DO NOT REWRITE APPLIED MIGRATIONS. RESTORE THE ORIGINAL CHAIN AND APPEND A NEW MIGRATION.\n",
			{
				...error.details,
				explanation:
					"The fingerprint disagrees at this version; the change may originate in an earlier migration. Callback-only changes with identical schemas are not detectable.",
				document: {
					id: meta.id,
					kind: meta.definition.kind,
					loaded: meta.loaded,
					version: meta.model.view()?.version,
				},
				// Use the raw view: diagnostics must not execute application bindings.
				snapshot: structuredClone(meta.model.view() ?? {}),
				incomingSnapshot: structuredClone(incomingSnapshot),
				incomingSnapshotUsesLocalSchema,
				remoteSchema:
					"Unavailable: fingerprints are not reversible and remote executable schemas are not transmitted.",
				localMigration:
					version !== undefined && version >= 2
						? {
								fromVersion: version - 1,
								toVersion: version,
								fromSchema: describe(schemaAt(version - 2)),
								toSchema: describe(schemaAt(version - 1)),
								transform:
									meta.definition.migrations[version - 2]?.migrator.toString(),
							}
						: undefined,
				localChain: meta.definition.migrationChain?.schemaIds.map(
					(identity, index) => ({ version: index + 1, identity }),
				),
				incomingPatch: row
					? {
							...row,
							operations: new Uint8Array(row.operations),
							dependencies: row.dependencies.map(([sid, clock]) => [
								sid,
								clock,
							]),
						}
					: undefined,
			},
		);
	} catch {
		// A throwing logger/diagnostic must never mask or bypass the rejection.
		try {
			console.warn(
				"PULSIFY: MIGRATION DRIFT DETECTED — DOCUMENT UPDATE BLOCKED",
				error.details,
			);
		} catch {
			/* Preserve the original error. */
		}
	}
}
