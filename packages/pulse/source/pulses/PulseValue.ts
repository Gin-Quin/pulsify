import type { PulseArray } from "./PulseArray.js";
import type { PulseObject } from "./PulseObject.js";

export type PulseValue =
	| PulseArray<any>
	| PulseObject<any>
	| string
	| number
	| boolean
	| null
	| undefined;
