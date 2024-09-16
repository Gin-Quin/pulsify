import { PulseValue } from ".."
import { PulseArray } from "../pulses/PulseArray"
import { PulseObject } from "../pulses/PulseObject"

export type Pulse<T> = T extends Array<infer Value>
	? PulseArray<Value>
	: T extends Record<string, any>
	? PulseObject<T>
	: PulseValue<T>
