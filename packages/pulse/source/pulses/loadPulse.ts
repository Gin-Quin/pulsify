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
	const pulse = await loadOne(definition, id, connectInput);
	if (subPulses) await loadSubPulses(pulse, connectInput, new Set());
	return pulse;
}

async function loadOne<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: string,
	input: Omit<LoadPulseOptions, "subPulses">,
): Promise<Pulse<ModelFromDefinition<Definition>>> {
	const options = { ...defaultPulseOptions, ...input };
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
		if (!existing) destroyPulse(pulse);
		throw error;
	}
}

/** Walk the stored data with its compiled layouts and load every sub-pulse, recursively. */
async function loadSubPulses(
	pulse: Pulse<any>,
	input: Omit<LoadPulseOptions, "subPulses">,
	visited: Set<string>,
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
				loadOne(layout.sub, value, input).then(
					(loaded) => loadSubPulses(loaded, input, visited),
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
