import { type Entry } from "../types/Entry"
import { BasePulse } from "./BasePulse"

export class PulseArray<T> extends BasePulse<Array<T>> {
	state = Array<ArrayUpdate<T>>()
}

export type ArrayUpdate<Value> = Entry & {
	content: Array<Value>
	left: Entry
	right: Entry
}
