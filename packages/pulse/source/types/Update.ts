import { Entry } from "./Entry"

/**
 * An update represents an entry with the data associated with it.
 */
export type PulseUpdate =
	| PulseArrayUpdate<any>
	| PulseObjectUpdate<any, any>
	| PulsePrimitiveUpdate<any>

export type PulseArrayUpdate<Value> = Entry & {
	content: Array<Value>
	left: Entry
	right: Entry
}

export type PulseObjectUpdate<
	Properties extends Record<string, any>,
	Key extends keyof Properties
> = Entry & {
	key: Key
	content: Array<Properties[Key]>
}

export type PulsePrimitiveUpdate<Value> = Entry & {
	content: Value
	left: Entry
	right: Entry
}
