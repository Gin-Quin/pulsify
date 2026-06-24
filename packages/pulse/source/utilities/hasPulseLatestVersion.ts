import type { Pulse } from "pulse/pulses/Pulse";
import { getPulseMeta } from "pulse/pulses/PulseMeta";

export function hasPulseLatestVersion(pulse: Pulse) {
	const meta = getPulseMeta(pulse);
	if (!meta) {
		console.error(`No metadata associated to the pulse ${pulse.id}`);
		return false;
	}
	return pulse.version + 1 === meta.definition.migrations.length;
}
