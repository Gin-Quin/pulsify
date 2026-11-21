import type { Connector } from "../connection/Connector.js";
import type { Pulse } from "./Pulse.js";

export type PulseScope = {
	readonly pulses: Map<string, Pulse<any>>;
	/**
	 * The account that writes through this scope, as your application knows it
	 * while offline too: the subject you sign into its tokens. It keeps the
	 * actor IDs of two accounts of one browser profile apart. It proves
	 * nothing: a server trusts the token of a connection, never this.
	 */
	readonly identity?: string;
	deleted?: Set<string>;
};
/**
 * A separate identity map per application/client; useful for replicas, and
 * for accounts: make one scope per signed-in account, with its `identity`,
 * and never load the pulses of an account into the scope of another.
 */
export function createPulseScope(
	options: { identity?: string } = {},
): PulseScope {
	const { identity } = options;
	if (identity === undefined) return { pulses: new Map() };
	if (typeof identity !== "string" || !identity.length)
		throw new TypeError("A scope identity is a non-empty string");
	return { pulses: new Map(), identity };
}
export const defaultPulseScope = createPulseScope();
/** Backoff between attempts of a failing connector: `initialDelayMs × factor^n`, capped. */
export type ReconnectOptions = {
	initialDelayMs: number;
	maxDelayMs: number;
	factor: number;
	/** Fraction of each delay removed at random, so clients do not retry in lockstep. */
	jitter: number;
};
export type PulseOptions = {
	createId: () => string;
	connect: boolean;
	connectors: Connector[];
	scope: PulseScope;
	/** Initial synchronization deadline, transport opening and request timeouts. */
	timeoutMs: number;
	/** Retry failing connectors until `disconnectPulse`; `false` gives up after the first failure. */
	reconnect: ReconnectOptions | false;
	sessionId?: number;
	/**
	 * Whether `loadPulse` loads the sub-pulses with the pulse, recursively;
	 * with `false`, load the ones you need with `ref.load()`.
	 */
	subPulses: boolean;
	onError: (error: Error) => void;
};
export const defaultPulseOptions: PulseOptions = {
	createId: () => crypto.randomUUID(),
	connect: false,
	connectors: [],
	scope: defaultPulseScope,
	timeoutMs: 10_000,
	reconnect: {
		initialDelayMs: 250,
		maxDelayMs: 30_000,
		factor: 2,
		jitter: 0.25,
	},
	subPulses: true,
	onError: () => {},
};
export function setDefaultPulseOptions(options: Partial<PulseOptions>): void {
	Object.assign(defaultPulseOptions, options);
}
