import type { PulseState } from "./AbstractPulse";

export interface Pulse<State extends PulseState<any, any>> {
	___pulse___: State;
}
