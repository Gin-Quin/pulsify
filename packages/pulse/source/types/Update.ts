import { type Entry } from "./Entry"

/**
 * An update represents an entry with the data associated with it.
 */
export type Update =
	| ArrayUpdate<any>
	| ObjectUpdate<any, any>
	| ValueUpdate<any>
	| IncrementableUpdate

export type ArrayUpdate<Value> = Entry & {
	content: Array<Value>
	left: Entry
	right: Entry
}

export type ObjectUpdate<
	Properties extends Record<string, any>,
	Key extends keyof Properties
> = Entry & {
	key: Key
	left: Entry
	content: Array<Properties[Key]>
}

export type ValueUpdate<Value> = Entry & {
	left: Entry | undefined
	content: Array<Value>
}

export type IncrementableUpdate = Entry & {
	value: number
}
