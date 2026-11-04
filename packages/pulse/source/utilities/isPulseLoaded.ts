import type { Pulse } from "../pulses/Pulse.js";
import { getPulseMeta } from "../pulses/PulseMeta.js";
export function isPulseLoaded(pulse: Pulse<any>): boolean {
	return getPulseMeta(pulse).loaded;
}
