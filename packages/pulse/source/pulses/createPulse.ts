import { Model } from "json-joy/lib/json-crdt";
import { Connection } from "pulse/connection/Connection";
import { connectPulse } from "pulse/connection/connectPulse";
import type { JsonValue } from "pulse/utilities/JsonValue";
import { pulsify } from "pulse/utilities/pulsify";
import { toNodeBuilder } from "pulse/utilities/toNodeBuilder";
import { bind as bindPulse } from "./Bindings";
import type { Binding } from "./Bindings";
import { type Pulse, pulses } from "./Pulse";
import type {
	AnyPulseDefinition,
	DataFromDefinition,
	ModelFromDefinition,
} from "./PulseDefinition";
import { type PulseMeta, PulseMetaSymbol } from "./PulseMeta";
import { type PulseOptions, defaultPulseOptions } from "./PulseOptions";
import type { PulseProperties } from "./PulseProperties";

export type CreatePulseInput<Properties extends PulseProperties<string>> = Omit<
	Properties,
	"id" | "kind" | "version"
> &
	Partial<Pick<Properties, "id">>;

export function createPulse<Definition extends AnyPulseDefinition>(
	definition: Definition,
	input: CreatePulseInput<DataFromDefinition<Definition>>,
	pulseOptions?: Partial<PulseOptions>,
): Pulse<ModelFromDefinition<Definition>> {
	const options: PulseOptions = {
		...defaultPulseOptions,
		...pulseOptions,
	};
	const data = {
		id: input.id ?? options.createId(),
		kind: definition.kind,
		version: definition.migrations.length + 1,
		...input,
	} as DataFromDefinition<Definition>;

	const existingPulse = pulses.get(data.id) as Pulse<
		ModelFromDefinition<Definition>
	>;

	if (existingPulse) {
		console.warn(
			`Pulse with id ${data.id} already exists. Returning existing pulse instead of creating a new one.`,
		);
		return existingPulse;
	}

	const schema = toNodeBuilder(data as JsonValue);
	const model = Model.create(schema);

	const pulse = pulsify(
		model.api.obj(),
		data as DataFromDefinition<Definition> & JsonValue,
	);

	const connections: Array<Connection> = options.connectors.map(
		(connector) => new Connection(pulse, connector),
	);

	const meta: PulseMeta = {
		id: data.id,
		definition,
		model,
		pulse,
		connections,
		status: "idle",
	};

	Object.defineProperty(pulse, PulseMetaSymbol, {
		value: meta,
		enumerable: false,
		configurable: false,
	});

	pulses.set(data.id, pulse);

	if (options.connect) {
		connectPulse(pulse);
	}

	if (definition.materializer) {
		const bindings = definition.materializer({
			bind: createDataFieldBinding,
		});

		return bindPulse(pulse, bindings) as Pulse<any>;
	} else {
		return pulse;
	}
}

function createDataFieldBinding<
	Data extends object,
	DataKey extends keyof Data,
>(dataKey: DataKey): Binding<Data, Data[DataKey]> {
	// Back the materializer's `bind("field")` helper with a direct two-way field binding.
	return {
		get(data) {
			return data[dataKey];
		},
		set(data, value) {
			data[dataKey] = value;
		},
	};
}
