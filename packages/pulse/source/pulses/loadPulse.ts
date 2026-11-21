import type { PulsePatchRow } from "../connection/PulsePatch.js";
import { assertScopeLive, markPulseDeleted } from "./deletion.js";
import {
	connectPulse,
	type ConnectPulseOptions,
} from "../connection/connectPulse.js";
import type { Connector } from "../connection/Connector.js";
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
import {
	collectSubRefs,
	consumePushedRows,
	registerSubPulseLoader,
} from "./subPulses.js";

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
					identity: options.scope.identity,
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
	const loadInput = { ...connectInput, subPulses };
	const pulse = await loadOne(definition, id, loadInput, prefetched);
	if (subPulses) {
		const tried = new Set<string>();
		await loadSubPulses(pulse, loadInput, new Set(), prefetched, tried);
		getPulseMeta(pulse).subPulses?.enable(tried);
	}
	return pulse;
}

async function loadOne<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: string,
	input: LoadPulseOptions,
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
		} else {
			const pushed = consumePushedRows(options.connectors, id);
			if (pushed?.length) getPulseMeta(pulse).applyRows(pushed);
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
	input: LoadPulseOptions,
	visited: Set<string>,
	prefetched?: Map<string, PulsePatchRow[]>,
	tried?: Set<string>,
): Promise<void> {
	const meta = getPulseMeta(pulse);
	if (visited.has(meta.id)) return;
	visited.add(meta.id);
	const refs = collectSubRefs(pulse);
	if (!refs.size) return;
	const tasks: Promise<void>[] = [];
	for (const [childId, definition] of refs) {
		tried?.add(childId);
		tasks.push(
			loadOne(definition, childId, input, prefetched).then(
				async (loaded) => {
					const childTried = new Set<string>();
					await loadSubPulses(loaded, input, visited, prefetched, childTried);
					getPulseMeta(loaded).subPulses?.enable(childTried);
				},
				// A dangling ID is tolerated: its reference keeps `pulse === undefined`.
				(error) => {
					if (!(error instanceof PulseError && error.code === "NOT_FOUND"))
						throw error;
				},
			),
		);
	}
	await Promise.all(tasks);
}

registerSubPulseLoader({
	createRuntime: (definition, id, options) =>
		createRuntime(definition, id, options),
	loadOne: (definition, id, input) => loadOne(definition, id, input),
	loadSubPulses: (pulse, input, visited) =>
		loadSubPulses(pulse, input, visited),
});
