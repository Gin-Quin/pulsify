import { PulseError } from "../protocol/errors.js";
import { coversDocument } from "../storage/documents.js";
import type { Pulse } from "./Pulse.js";
import { getPulseMeta } from "./PulseMeta.js";
import type { PulseScope } from "./PulseOptions.js";

export function assertScopeLive(scope: PulseScope, id: string): void {
	if ([...(scope.deleted ?? [])].some((prefix) => coversDocument(prefix, id)))
		throw new PulseError("NOT_FOUND", `Document ${id} was permanently deleted`);
}

/** Stop a deleted subtree, retaining both in-memory and persisted recovery data. */
export function markPulseDeleted(pulse: Pulse<any>): Promise<void> {
	const source = getPulseMeta(pulse);
	if (source.deleted) return source.deletion ?? Promise.resolve();
	const scope = source.options.scope;
	(scope.deleted ??= new Set()).add(source.id);
	const affected = [...scope.pulses.values()]
		.map(getPulseMeta)
		.filter((meta) => coversDocument(source.id, meta.id));
	const recovery = affected.flatMap((meta) => {
		try {
			return meta.log.missing([]);
		} catch (error) {
			meta.report(error instanceof Error ? error : new Error(String(error)));
			return [];
		}
	});
	const locals = new Set(
		affected.flatMap((meta) =>
			meta.options.connectors.filter((c) => c.kind === "local"),
		),
	);
	const error = new PulseError(
		"NOT_FOUND",
		`Document ${source.id} was permanently deleted`,
	);
	for (const meta of affected) {
		meta.deleted = true;
		meta.cancelConnection?.(error);
		for (const connection of meta.connections) connection.close();
		meta.status = "error";
		meta.lastError = error;
	}
	const saved = Promise.all(
		[...locals].map((local) =>
			Promise.resolve().then(() => local.markDeleted?.(source.id, recovery)),
		),
	).then(() => {});
	for (const meta of affected) meta.deletion = saved;
	void saved.catch((failure) => source.report(failure));
	return saved;
}
