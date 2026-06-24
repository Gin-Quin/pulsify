import type { Pulse } from "pulse/pulses/Pulse";

/**
 * Check whether a pulse has been loaded from any source.
 * For that, we simply check the "id" property that is
 * a mandatory property in a well-loaded pulse.
 */
export function isPulseLoaded(pulse: Pulse) {
	return !!pulse.id;
}
