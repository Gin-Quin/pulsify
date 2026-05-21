import type { PulseArray } from "./PulseArray";
import type { PulseObject } from "./PulseObject";

export type PulseValue =
	| PulseArray<any>
	| PulseObject<any>
	| string
	| number
	| boolean
	| null
	| undefined;
