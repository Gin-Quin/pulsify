import type { Connector } from "pulse/connection/Connector";

export type PulseOptions = {
	createId: () => string;
	connect: boolean;
	connectors: Array<Connector>;
};

export const defaultPulseOptions: PulseOptions = {
	createId: crypto.randomUUID,
	connectors: [],
	connect: false,
};

export function setDefaultPulseOptions(options: Partial<PulseOptions>): void {
	Object.assign(defaultPulseOptions, options);
}
