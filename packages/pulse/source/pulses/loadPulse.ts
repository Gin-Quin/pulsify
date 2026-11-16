import type { PulsePatchRow } from "../connection/PulsePatch.js";
import { assertScopeLive, markPulseDeleted } from "./deletion.js";
import {
	connectPulse,
	type ConnectPulseOptions,
} from "../connection/connectPulse.js";
import type { Connector } from "../connection/Connector.js";
import type { PulseLayout } from "../core/schema.js";
import { PulseError } from "../protocol/errors.js";
import { destroyPulse, type Pulse } from "./Pulse.js";
import type {
	AnyPulseDefinition,
	ModelFromDefinition,
} from "./PulseDefinition.js";
import { getPulseMeta } from "./PulseMeta.js";
import { actorPoolOf, leaseActor } from "./actors.js";
import { defaultPulseOptions, type PulseOptions } from "./PulseOptions.js";
import { createRuntime } from "./PulseRuntime.js";

export type LoadPulseOptions = Partial<PulseOptions> &
	ConnectPulseOptions & {
		waitFor?: "ready" | "connected" | "synced" | "all" | Connector[];
	};
export async function loadPulse<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: string,
	input: LoadPulseOptions = {},
): Promise<Pulse<ModelFromDefinition<Definition>>> {
	const { subPulses = defaultPulseOptions.subPulses, ...connectInput } = input;
	const options = { ...defaultPulseOptions, ...connectInput };
	assertScopeLive(options.scope, id);
	const retire = async (error: PulseError): Promise<never> => {
		const existing = options.scope.pulses.get(id);
		const retained = existing ?? createRuntime(definition, id, options);
		try {
			await markPulseDeleted(retained).catch(() => {});
		} finally {
			if (!existing) destroyPulse(retained);
		}
		throw error;
	};
	const locals = options.connectors.filter(
		(connector) => connector.kind === "local",
	);
	let cold = locals.length === 0;
	if (subPulses && locals.length && locals.every((local) => local.cached)) {
		const probes = await Promise.allSettled(
			locals.map((local) => local.cached!(id)),
		);
		cold = probes.every(
			(probe) => probe.status === "fulfilled" && !probe.value,
		);
		for (const [index, probe] of probes.entries()) {
			if (
				probe.status === "rejected" &&
				probe.reason instanceof PulseError &&
				probe.reason.code === "NOT_FOUND" &&
				locals[index]!.authoritativeDeletions
			)
				return retire(probe.reason);
		}
	}
	let prefetched: Map<string, PulsePatchRow[]> | undefined;
	if (subPulses && cold) {
		const remote = options.connectors.find((connector) => connector.prefetch);
		try {
			if (options.sessionId === undefined)
				await leaseActor(options.scope, actorPoolOf(options.connectors));
			prefetched = (
				await remote?.prefetch?.(id, {
					descendants: true,
					timeoutMs: options.timeoutMs,
					signal: input.signal,
					vectors: [...options.scope.pulses]
						.filter(([name]) => name === id || name.startsWith(`${id}/`))
						.map(([name, pulse]) => [
							name,
							getPulseMeta(pulse).log.historyVector,
						]),
				})
			)?.documents;
		} catch (error) {
			if (
				error instanceof PulseError &&
				error.code === "NOT_FOUND" &&
				remote?.authoritativeDeletions
			) {
				return retire(error);
			}
			if (error instanceof PulseError && error.code === "TIMEOUT") throw error;
			if (input.signal?.aborted) throw new PulseError("CLOSED", "Load aborted");
		}
	}
	const pulse = await loadOne(definition, id, connectInput, prefetched);
	if (subPulses)
		await loadSubPulses(pulse, connectInput, new Set(), prefetched);
	return pulse;
}

async function loadOne<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: string,
	input: Omit<LoadPulseOptions, "subPulses">,
	prefetched?: Map<string, PulsePatchRow[]>,
): Promise<Pulse<ModelFromDefinition<Definition>>> {
	const options = { ...defaultPulseOptions, ...input };
	assertScopeLive(options.scope, id);
	// A runtime reuses the scope's leased actor only if the lease came first,
	// so that every download it relies on happened under the lease.
	if (options.sessionId === undefined && !options.scope.pulses.has(id)) {
		const lease = leaseActor(options.scope, actorPoolOf(options.connectors));
		if (lease) await lease;
	}
	const existing = options.scope.pulses.get(id);
	if (existing && getPulseMeta(existing).definition !== definition)
		throw new PulseError(
			"INCOMPATIBLE_DOCUMENT",
			"ID already belongs to a different pulse definition",
		);
	if (existing && getPulseMeta(existing).loaded && !input.waitFor)
		return existing as Pulse<ModelFromDefinition<Definition>>;
	const pulse = existing ?? createRuntime(definition, id, options);
	try {
		if (prefetched?.has(id)) {
			getPulseMeta(pulse).applyRows(prefetched.get(id)!);
			prefetched.delete(id);
		}
		const task = connectPulse(pulse, input);
		if (Array.isArray(input.waitFor)) {
			const required = input.waitFor;
			if (
				required.some(
					(connector) =>
						!getPulseMeta(pulse).connections.some(
							(connection) => connection.connector === connector,
						),
				)
			)
				throw new TypeError("waitFor connector is not configured");
			await task.ready;
			await Promise.all(
				getPulseMeta(pulse)
					.connections.filter((connection) =>
						required.includes(connection.connector),
					)
					.map((connection) => connection.whenSynced),
			);
		} else
			await task[
				input.waitFor === "all" ? "synced" : (input.waitFor ?? "ready")
			];
		return pulse as Pulse<ModelFromDefinition<Definition>>;
	} catch (error) {
		await getPulseMeta(pulse).deletion?.catch(() => {});
		if (!existing) destroyPulse(pulse);
		throw error;
	}
}

/** Walk the stored data with its compiled layouts and load every sub-pulse, recursively. */
async function loadSubPulses(
	pulse: Pulse<any>,
	input: Omit<LoadPulseOptions, "subPulses">,
	visited: Set<string>,
	prefetched?: Map<string, PulsePatchRow[]>,
): Promise<void> {
	const meta = getPulseMeta(pulse);
	if (visited.has(meta.id)) return;
	visited.add(meta.id);
	const root = meta.definition.compiledSchema?.root;
	if (!root) return;
	const tasks: Promise<void>[] = [];
	const visit = (layout: PulseLayout | undefined, value: unknown): void => {
		if (!layout || value === undefined || value === null) return;
		if (layout.sub) {
			if (typeof value !== "string") return;
			tasks.push(
				loadOne(layout.sub, value, input, prefetched).then(
					(loaded) => loadSubPulses(loaded, input, visited, prefetched),
					// A dangling ID is tolerated: its reference keeps `pulse === undefined`.
					(error) => {
						if (!(error instanceof PulseError && error.code === "NOT_FOUND"))
							throw error;
					},
				),
			);
			return;
		}
		switch (layout.kind) {
			case "optional":
				return visit(layout.value, value);
			case "object":
				for (const field of layout.fields)
					visit(field.layout, (value as Record<string, unknown>)[field.key]);
				return;
			case "array":
			case "tuple":
				if (Array.isArray(value))
					value.forEach((item, i) =>
						visit(
							layout.kind === "tuple" ? layout.elements?.[i] : layout.element,
							item,
						),
					);
				return;
			case "record":
			case "map":
				if (typeof value === "object")
					for (const item of Object.values(value)) visit(layout.element, item);
				return;
			case "union": {
				if (typeof value !== "object" || !layout.tagName) return;
				const tag = (value as Record<string, unknown>)[layout.tagName];
				return visit(layout.variants?.get(String(tag)), value);
			}
			// ponytail: untagged unions are not walked; add a layout match if needed.
		}
	};
	visit(root, meta.model.view());
	await Promise.all(tasks);
}
