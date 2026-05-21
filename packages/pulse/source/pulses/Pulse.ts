import { Model } from "json-joy/lib/json-crdt";
import type { Connection } from "pulse/connection/Connection";
import type { JsonObject } from "pulse/utilities/JsonValue";
import { pulsify } from "pulse/utilities/pulsify";
import { toNodeBuilder } from "pulse/utilities/toNodeBuilder";
import type { Connector } from "../connection/Connector";
import { bind } from "./Bindings";
import type {
	AnyPulseDefinition,
	DataFromDefinition,
	ModelFromDefinition,
} from "./PulseDefinition";
import type { PulseMeta } from "./PulseMeta";
import type { PulseObject } from "./PulseObject";
import type { PulseProperties } from "./PulseProperties";

const PulseMetaSymbol: unique symbol = Symbol("PulseMeta");
const pulses = new Map<string, Pulse>();

export type PulseOptions = {
	createId: () => string;
	connect: boolean;
	connectors: Array<Connector>;
};

const defaultOptions: PulseOptions = {
	createId: crypto.randomUUID,
	connectors: [],
	connect: false,
};

export function setDefaultPulseOptions(options: Partial<PulseOptions>): void {
	Object.assign(defaultOptions, options);
}

export type Pulse<
	Properties extends PulseProperties<string> &
		JsonObject = PulseProperties<string>,
> = PulseObject<Properties> & {
	[PulseMetaSymbol]: PulseMeta;
};

export type CreatePulseInput<Properties extends PulseProperties<string>> = Omit<
	Properties,
	"id" | "kind"
> &
	Partial<Pick<Properties, "id" | "kind">>;

export function createPulse<Definition extends AnyPulseDefinition>(
	definition: Definition,
	input: CreatePulseInput<DataFromDefinition<Definition>>,
	pulseOptions?: Partial<PulseOptions>,
): PulseObject<ModelFromDefinition<Definition>> {
	const options: PulseOptions = {
		...defaultOptions,
		...pulseOptions,
	};
	const data = {
		id: input.id ?? options.createId(),
		kind: definition.kind,
		...input,
	} as DataFromDefinition<Definition>;

	const existingPulse = pulses.get(data.id);

	if (existingPulse) {
		console.warn(
			`Pulse with id ${data.id} already exists. Returning existing pulse instead of creating a new one.`,
		);
		return existingPulse as Pulse<any>;
	}

	const schema = toNodeBuilder(data);
	const model = Model.create(schema);

	const pulse = pulsify(model.api.obj(), data) as PulseObject<
		DataFromDefinition<Definition>
	> as Pulse<DataFromDefinition<Definition>>;

	const connections: Array<Connection> = options.connectors.map(
		(connector) => ({
			connector,
			close: () => {},
			status: "idle",
		}),
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

	if (definition.bindings) {
		return bind(pulse, definition.bindings) as Pulse<any>;
	} else {
		return pulse as Pulse<any>;
	}
}

/**
 * Connect an idle pulse
 */
export async function connectPulse(pulse: Pulse): Promise<void> {
	const meta = pulse[PulseMetaSymbol];
	const connections = meta.connections;

	await Promise.all(
		connections.map(async (connection) => {
			if (connection.status !== "idle") return; // fix: case "connecting"
			const { close, done } = connection.connector.connect();
			connection.close = close;
			connection.status = "connecting";
			await done;
			connection.status = "connected";
		}),
	);
}

export function destroyPulse(pulse: Pulse): void {
	const meta = pulse[PulseMetaSymbol];
	const id = meta.id;
	pulses.delete(id);
}
