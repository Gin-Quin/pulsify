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
import { defaultPulseOptions, type PulseOptions } from "./PulseOptions.js";
import { createRuntime } from "./PulseRuntime.js";

/**
 * Select `sub()` fields to load with their parent; arrays, maps and optionals
 * are transparent. `true` on a field loads that child only; a nested object
 * continues into the child.
 */
export type SubPulseInclude = {
	readonly [field: string]: boolean | SubPulseInclude;
};
export type LoadPulseOptions = Partial<PulseOptions> &
	ConnectPulseOptions & {
		waitFor?: "ready" | "connected" | "synced" | "all" | Connector[];
		/** `true` loads every sub-pulse recursively; an object selects fields. */
		include?: boolean | SubPulseInclude;
	};
export async function loadPulse<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: string,
	input: LoadPulseOptions = {},
): Promise<Pulse<ModelFromDefinition<Definition>>> {
	const { include, ...connectInput } = input;
	const pulse = await loadOne(definition, id, connectInput);
	if (include) await loadIncluded(pulse, include, connectInput, new Set());
	return pulse;
}

async function loadOne<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: string,
	input: Omit<LoadPulseOptions, "include">,
): Promise<Pulse<ModelFromDefinition<Definition>>> {
	const options = { ...defaultPulseOptions, ...input };
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

/** Walk the stored data with its compiled layouts and load every selected sub-pulse. */
async function loadIncluded(
	pulse: Pulse<any>,
	include: true | SubPulseInclude,
	input: Omit<LoadPulseOptions, "include">,
	visited: Set<string>,
): Promise<void> {
	const meta = getPulseMeta(pulse);
	if (visited.has(meta.id)) return;
	visited.add(meta.id);
	const root = meta.definition.compiledSchema?.root;
	if (!root) return;
	const tasks: Promise<void>[] = [];
	// `true` recurses through every child; "self" loads a selected child only.
	const visit = (
		layout: PulseLayout | undefined,
		value: unknown,
		spec: true | "self" | SubPulseInclude,
	): void => {
		if (!layout || value === undefined || value === null) return;
		if (layout.sub) {
			if (typeof value !== "string") return;
			const child = loadOne(layout.sub, value, input).then((loaded) =>
				spec === "self"
					? undefined
					: loadIncluded(loaded, spec, input, visited),
			);
			tasks.push(child);
			return;
		}
		switch (layout.kind) {
			case "optional":
				return visit(layout.value, value, spec);
			case "object":
				for (const field of layout.fields) {
					const selected =
						spec === true || spec === "self" ? spec : spec[field.key];
					const next = selected === true && spec !== true ? "self" : selected;
					if (next)
						visit(
							field.layout,
							(value as Record<string, unknown>)[field.key],
							next,
						);
				}
				return;
			case "array":
			case "tuple":
				if (Array.isArray(value))
					value.forEach((item, i) =>
						visit(
							layout.kind === "tuple" ? layout.elements?.[i] : layout.element,
							item,
							spec,
						),
					);
				return;
			case "map":
				if (typeof value === "object")
					for (const item of Object.values(value))
						visit(layout.element, item, spec);
				return;
			case "union": {
				if (typeof value !== "object" || !layout.tagName) return;
				const tag = (value as Record<string, unknown>)[layout.tagName];
				return visit(layout.variants?.get(String(tag)), value, spec);
			}
			// ponytail: untagged unions are not walked; add a layout match if needed.
		}
	};
	visit(root, meta.model.view(), include);
	await Promise.all(tasks);
}
