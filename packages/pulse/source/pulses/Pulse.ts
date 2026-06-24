import type { JsonObject } from "pulse/utilities/JsonValue";
import { type PulseMeta, PulseMetaSymbol } from "./PulseMeta";
import type { PulseObject } from "./PulseObject";
import type { PulseProperties } from "./PulseProperties";

export const pulses = new Map<string, Pulse>();

export type Pulse<
	Properties extends PulseProperties<string> &
		JsonObject = PulseProperties<string>,
> = PulseObject<Properties> & {
	[PulseMetaSymbol]: PulseMeta;
};

export function destroyPulse(pulse: Pulse): void {
	const meta = pulse[PulseMetaSymbol];
	const id = meta.id;
	pulses.delete(id);
}
