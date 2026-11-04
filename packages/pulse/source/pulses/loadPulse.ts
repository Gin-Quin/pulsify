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
