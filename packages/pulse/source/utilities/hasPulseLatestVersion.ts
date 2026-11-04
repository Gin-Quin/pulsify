import type { Pulse } from "../pulses/Pulse.js";
import { getPulseMeta } from "../pulses/PulseMeta.js";
export function hasPulseLatestVersion(pulse: Pulse<any>): boolean {
	const meta = getPulseMeta(pulse);
	return meta.loaded && pulse.version === meta.definition.migrations.length + 1;
}
