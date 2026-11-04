import type { Connector } from "../connection/Connector.js";
import type { Pulse } from "./Pulse.js";

export type PulseScope = { readonly pulses: Map<string, Pulse<any>> };
/** A separate identity map per application/client; useful for SSR and replicas. */
export function createPulseScope(): PulseScope {
	return { pulses: new Map() };
}
export const defaultPulseScope = createPulseScope();
export type PulseOptions = {
	createId: () => string;
	connect: boolean;
	connectors: Connector[];
	scope: PulseScope;
	timeoutMs: number;
	sessionId?: number;
	onError: (error: Error) => void;
};
export const defaultPulseOptions: PulseOptions = {
	createId: () => crypto.randomUUID(),
	connect: false,
	connectors: [],
	scope: defaultPulseScope,
	timeoutMs: 10_000,
	onError: () => {},
};
export function setDefaultPulseOptions(options: Partial<PulseOptions>): void {
	Object.assign(defaultPulseOptions, options);
}
