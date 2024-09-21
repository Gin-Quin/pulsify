import type { PulseValue } from "..";
import type { PulseArray } from "../pulses/PulseArray";
import type { PulseObject } from "../pulses/PulseObject";

export type Pulse<T> = T extends Array<infer Value>
	? PulseArray<Value>
	: T extends Record<string, unknown>
		? PulseObject<T>
		: PulseValue<T>;

export function createPulse<T>(value: T): Pulse<T> {
	throw "TODO";
}
